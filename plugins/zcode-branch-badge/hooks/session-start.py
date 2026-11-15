#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SessionStart / UserPromptSubmit hook：确保主进程 loader 在位（多个插件共用同一份副本）。

- autoApply 开启（默认）：调用引擎 loader install（幂等）——首次安装时重打包
  asar 写入指针并提示重启一次；loader 已激活时快速幂等返回。
- 输出策略（stdout 进入模型上下文，只在有话要说时输出）：
  installed            → 首装完成，提示重启一次 + 系统通知；
  already + 未激活     → 提示「上次已自动安装，请重启一次」+ 系统通知；
  already + 已激活     → 完全静默（常态路径）；
  失败 / 无输出        → 一行简短原因，便于会话里的助手接手排查。
- 激活凭证是 ~/.zcode/zcode-helper/active.json（loader activate 时写入 pid），
  用 os.kill(pid, 0) 判活，区分「指针已装但 ZCode 未重启」与「已生效」。
- 需要重启时发 macOS 系统通知（config.json 的 "notify": false 可关）。
- 仅当本插件携带分支服务脚本（zch_branch_daemon.py）时，best-effort 拉起 daemon，
  独立于 autoApply 开关。

旧版等长替换补丁路线已退役；ZCode 升级覆盖 asar 后，下次触发会自动重装指针。
"""

import json
import os
import platform
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOOL = ROOT / "scripts" / "zcode_helper.py"
DAEMON_SCRIPT = ROOT / "scripts" / "zch_branch_daemon.py"
LOADER_HOME = Path(
    os.environ.get("ZCODE_LOADER_HOME") or Path.home() / ".zcode" / "zcode-helper"
)
ACTIVE_FILE = LOADER_HOME / "active.json"


def _plugin_name(root: Path) -> str:
    """插件名来自清单；缺失时回退目录名（hook 只读 config，宽松处理）。"""
    manifest = root / ".zcode-plugin" / "plugin.json"
    try:
        name = json.loads(manifest.read_text(encoding="utf-8")).get("name")
    except (OSError, ValueError):
        name = None
    return name or root.name


PLUGIN_NAME = _plugin_name(ROOT)
CONFIG = Path.home() / ".zcode" / PLUGIN_NAME / "config.json"


def auto_apply_enabled() -> bool:
    try:
        data = json.loads(CONFIG.read_text(encoding="utf-8"))
        return data.get("autoApply", True) is not False
    except (OSError, ValueError):
        return True


def notify_enabled() -> bool:
    try:
        data = json.loads(CONFIG.read_text(encoding="utf-8"))
        return data.get("notify", True) is not False
    except (OSError, ValueError):
        return True


def notify(message: str) -> None:
    """macOS 系统通知（best-effort）：重启提醒要在会话之外也能被看到。"""
    if platform.system() != "Darwin" or not notify_enabled():
        return
    script = 'display notification "{}" with title "ZCode Helper"'.format(
        message.replace('"', "'")
    )
    try:
        subprocess.run(["osascript", "-e", script], capture_output=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        pass


def loader_active() -> bool:
    """active.json 存在且 pid 活着 → loader 已在运行中的 ZCode 主进程生效。"""
    try:
        data = json.loads(ACTIVE_FILE.read_text(encoding="utf-8"))
        pid = int(data.get("pid", 0))
    except (OSError, ValueError, TypeError):
        return False
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # 进程存在但无权发信号 → 视为活着
    except OSError:
        return False
    return True


def ensure_daemon() -> None:
    """best-effort 拉起本地分支服务（分支徽章的数据源），失败静默。

    独立于 autoApply 开关：daemon 是无害的本地只读服务。
    仅当本插件携带 daemon 脚本时才尝试。
    """
    if not DAEMON_SCRIPT.is_file():
        return
    try:
        subprocess.run(
            [sys.executable, str(TOOL), "daemon", "start"],
            capture_output=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        pass


def ensure_loader() -> None:
    """幂等安装主进程 loader；按结果分四路输出（详见模块 docstring）。"""
    try:
        proc = subprocess.run(
            [sys.executable, str(TOOL), "--json", "loader", "install", "--quiet"],
            capture_output=True,
            text=True,
            timeout=120,  # 首次安装需整包重打包，可达数十秒
        )
    except (OSError, subprocess.SubprocessError):
        return
    payload = None
    for line in reversed(proc.stdout.strip().splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                payload = json.loads(line)
                break
            except ValueError:
                continue
    if payload is None:
        print(
            f"[{PLUGIN_NAME}] loader 自动安装无输出（可能超时或引擎异常），"
            "可让助手运行 zcode_helper.py loader install 排查。"
        )
        return
    action = payload.get("action")
    if action == "installed":
        print(
            f"[{PLUGIN_NAME}] 已自动安装 UI 注入 loader（app.asar 已重打包）。"
            "请完全退出 ZCode 后重新打开一次，此后插件开关即时生效、无需重启。"
        )
        notify("UI 增强已自动安装，请重启 ZCode 一次生效")
    elif action == "already":
        if loader_active():
            return  # 已生效：常态，零输出
        print(
            f"[{PLUGIN_NAME}] 上次已自动安装 UI 注入 loader，但尚未生效——"
            "请完全退出 ZCode（菜单 → 退出，关闭窗口不算）后重新打开一次。"
        )
        notify("UI 增强待生效，请完全退出并重开 ZCode")
    else:
        reasons = {
            "not_writable": "app.asar 不可写（可 sudo 运行，或将 ZCode 装到用户目录后用 --asar 指向）",
        }
        reason = reasons.get(payload.get("reason"), payload.get("reason") or "未知原因")
        print(
            f"[{PLUGIN_NAME}] loader 自动安装失败：{reason}。"
            "可让助手运行 zcode_helper.py loader install 查看详情。"
        )


def main() -> int:
    if not TOOL.is_file():
        return 0
    ensure_daemon()
    if not auto_apply_enabled():
        return 0
    ensure_loader()
    return 0


if __name__ == "__main__":
    sys.exit(main())
