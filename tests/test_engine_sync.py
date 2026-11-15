#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""shared/ 真源与各插件分发副本的同步校验（仅依赖标准库）。

运行：python3 tests/test_engine_sync.py

引擎、hook 或 loader 资产改动后，必须把 shared/ 下的真源复制到每个
插件目录（cp 命令见 README「修改引擎」），否则本测试失败。
"""

import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SHARED = ROOT / "shared"
PLUGINS = ["plugins/zcode-folder-full-path", "plugins/zcode-branch-badge"]

# (shared/ 下真源相对路径, 插件目录下副本相对路径)；每个插件一份副本
COPY_MAP = [
    ("zcode_helper.py", "scripts/zcode_helper.py"),
    ("session-start.py", "hooks/session-start.py"),
    ("loader.cjs", "loader/loader.cjs"),
    ("core.cjs", "loader/core.cjs"),
    ("modules/folder-full-path.js", "loader/modules/folder-full-path.js"),
    ("modules/branch-badge.js", "loader/modules/branch-badge.js"),
    ("modules/market-switch-bridge.js", "loader/modules/market-switch-bridge.js"),
]


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def core_version() -> str:
    """从 shared/core.cjs 提取 CORE_VERSION 常量。"""
    text = (SHARED / "core.cjs").read_text(encoding="utf-8")
    match = re.search(r'CORE_VERSION = "(\d+\.\d+\.\d+)"', text)
    if not match:
        raise AssertionError("shared/core.cjs 里找不到 CORE_VERSION 常量")
    return match.group(1)


def check_version_lockstep() -> list[str]:
    """CORE_VERSION 必须与两处 plugin.json、marketplace.json 的版本一致。

    0.2.4 发版漏 bump CORE_VERSION：自同步拿缓存目录版本和它比较，永远
    判「有新版」→ 每秒重拷 → 引导壳每秒热更新死循环。此断言防再犯。"""
    problems = []
    expected = core_version()
    sources = [(f"shared/core.cjs CORE_VERSION", expected)]
    for plugin in PLUGINS:
        manifest = ROOT / plugin / ".zcode-plugin" / "plugin.json"
        version = json.loads(manifest.read_text(encoding="utf-8")).get("version")
        sources.append((f"{plugin}/plugin.json version", str(version)))
    market = json.loads((ROOT / "marketplace.json").read_text(encoding="utf-8"))
    for entry in market.get("plugins", []):
        sources.append(
            (f"marketplace.json {entry.get('name')} version", str(entry.get("version")))
        )
    for label, version in sources:
        if version != expected:
            problems.append(
                f"FAIL  版本未锁步：{label} = {version}，但 CORE_VERSION = {expected}"
                f"（发版时必须一起 bump）"
            )
        else:
            print(f"PASS  版本锁步 {label} = {version}")
    return problems


def main() -> int:
    failed = False
    for source_rel, copy_rel in COPY_MAP:
        source = SHARED / source_rel
        for plugin in PLUGINS:
            copy = ROOT / plugin / copy_rel
            if not copy.is_file():
                print(f"FAIL  缺少副本：{plugin}/{copy_rel}")
                failed = True
                continue
            if sha(copy) != sha(source):
                print(
                    f"FAIL  副本与 shared/ 真源不一致：{plugin}/{copy_rel}"
                    f"（从 shared/{source_rel} 重新复制）"
                )
                failed = True
            else:
                print(f"PASS  {plugin}/{copy_rel}")
    problems = check_version_lockstep()
    return 1 if failed or problems else 0


if __name__ == "__main__":
    sys.exit(main())
