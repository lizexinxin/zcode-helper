#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""shared/ 真源与各插件分发副本的同步校验（仅依赖标准库）。

运行：python3 tests/test_engine_sync.py

引擎或 hook 改动后，必须把 shared/ 下的真源复制到每个插件目录
（cp 命令见 README「修改引擎」），否则本测试失败。
"""

import hashlib
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SHARED = ROOT / "shared"
COPIES = [
    "plugins/zcode-folder-full-path/scripts/zcode_helper.py",
    "plugins/zcode-branch-badge/scripts/zcode_helper.py",
    "plugins/zcode-folder-full-path/hooks/session-start.py",
    "plugins/zcode-branch-badge/hooks/session-start.py",
]


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    failed = False
    for rel in COPIES:
        copy = ROOT / rel
        source = SHARED / Path(rel).name
        if not copy.is_file():
            print(f"FAIL  缺少副本：{rel}")
            failed = True
            continue
        if sha(copy) != sha(source):
            print(f"FAIL  副本与 shared/ 真源不一致：{rel}（从 shared/{Path(rel).name} 重新复制）")
            failed = True
        else:
            print(f"PASS  {rel}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
