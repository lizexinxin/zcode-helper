#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""shared/ 真源与各插件分发副本的同步校验（仅依赖标准库）。

运行：python3 tests/test_engine_sync.py

引擎、hook 或 loader 资产改动后，必须把 shared/ 下的真源复制到每个
插件目录（cp 命令见 README「修改引擎」），否则本测试失败。
"""

import hashlib
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
    ("modules/folder-full-path.js", "loader/modules/folder-full-path.js"),
    ("modules/branch-badge.js", "loader/modules/branch-badge.js"),
    ("modules/market-switch-bridge.js", "loader/modules/market-switch-bridge.js"),
]


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


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
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
