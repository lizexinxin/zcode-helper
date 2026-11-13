#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SessionStart hook：确保主进程 loader 在位（多个插件共用同一份副本）。

- autoApply 开启（默认）：调用引擎 loader install（幂等）——首次安装时
  重打包 asar 写入指针并提示重启一次；已在位时静默。
- 仅当本插件携带分支服务脚本（zch_branch_daemon.py）时，best-effort 拉起 daemon。

旧版等长替换补丁路线已退役；ZCode 升级覆盖 asar 后，下次会话启动会自动重装指针。

只输出简短结论到 stdout（会进入模型上下文）。
"""

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOOL = ROOT / "scripts" / "zcode_helper.py"
DAEMON_SCRIPT = ROOT / "scripts" / "zch_branch_daemon.py"


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
    """幂等安装主进程 loader；首次安装（重打包 asar）时提示重启一次。"""
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
    if payload and payload.get("action") == "installed":
        print(
            f"[{PLUGIN_NAME}] 已安装 UI 注入 loader（app.asar 已重打包）。"
            "请完全退出 ZCode 后重新打开一次，此后插件开关即时生效、无需重启。"
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
