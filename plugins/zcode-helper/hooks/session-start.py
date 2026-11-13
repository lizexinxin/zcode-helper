#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SessionStart hook：检查 zcode-helper 的 UI 补丁状态。

- 从未应用过：静默退出。
- 之前应用过、ZCode 升级后失效：自动重新应用（autoApply 默认开启），并提示重启。
- 新版本代码结构变化导致无法匹配：提示用户适配。

只输出简短结论到 stdout（会进入模型上下文）。
"""

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOOL = ROOT / "scripts" / "zcode_helper.py"
CONFIG = Path.home() / ".zcode" / "zcode-helper" / "config.json"


def auto_apply_enabled() -> bool:
    try:
        data = json.loads(CONFIG.read_text(encoding="utf-8"))
        return data.get("autoApply", True) is not False
    except (OSError, ValueError):
        return True


def ensure_daemon() -> None:
    """best-effort 拉起本地分支服务（folder-git-branch 补丁的数据源），失败静默。

    独立于 autoApply 开关：daemon 是无害的本地只读服务，拉起失败也不影响补丁。
    """
    try:
        subprocess.run(
            [sys.executable, str(TOOL), "daemon", "start"],
            capture_output=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        pass


def main() -> int:
    if not TOOL.is_file():
        return 0
    ensure_daemon()
    if not auto_apply_enabled():
        return 0
    try:
        proc = subprocess.run(
            [sys.executable, str(TOOL), "--json", "auto"],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return 0

    payload = None
    for line in reversed(proc.stdout.strip().splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                payload = json.loads(line)
                break
            except ValueError:
                continue
    if not payload:
        return 0

    reason = payload.get("reason")
    if reason == "never_applied":
        return 0

    repaired = payload.get("repaired") or []
    broken = payload.get("broken") or []
    if repaired:
        print(
            "[zcode-helper] 检测到 ZCode 升级后 UI 补丁失效，已自动重新应用："
            + "、".join(repaired)
            + "。请完全退出 ZCode 后重新打开，补丁才会生效。"
        )
    if broken:
        names = "、".join(item.get("id", "?") for item in broken)
        print(
            f"[zcode-helper] 以下 UI 补丁无法适配当前 ZCode 版本：{names}。"
            "需要更新补丁定义；运行 /zcode-helper-status 查看详情。"
        )
    if reason == "not_writable":
        print(
            "[zcode-helper] ZCode 的 app.asar 不可写，无法自动修复 UI 补丁。"
            "请运行 /zcode-helper-apply 查看处理建议。"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())