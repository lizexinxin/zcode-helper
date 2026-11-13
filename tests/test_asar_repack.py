#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""asar 整包重打包核心测试（仅依赖标准库）。

运行：python3 tests/test_asar_repack.py

覆盖重点：write_asar 产出的 header 布局必须能被引擎自己的 read_header
解析；repack 后逐文件字节比对；真实 app.asar 只读往返（本机有 ZCode 才跑）。
"""

import hashlib
import importlib.util
import shutil
import sys
import tempfile
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "plugins" / "zcode-branch-badge" / "scripts" / "zcode_helper.py"

_spec = importlib.util.spec_from_file_location("zcode_helper", SCRIPT)
zh = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(zh)

REAL_ASAR = Path("/Applications/ZCode.app/Contents/Resources/app.asar")


def make_files() -> dict:
    """合成 asar 的文件集：含目录结构，内容各异。"""
    return {
        "package.json": b'{"name":"app","main":"out/main/index.js"}',
        "out/main/index.js": b"console.log('main');\n",
        "out/renderer/index.html": b"<html><body>hi</body></html>",
        "out/renderer/assets/a.js": b"var a=1;",
    }


def read_all(asar: Path) -> dict:
    """只读归档内文件（无 offset 的 unpacked 节点内容在 asar 外，跳过）。"""
    with asar.open("rb") as fh:
        header, data_base = zh.read_header(fh)
        return {
            p: zh.read_node(fh, data_base, n)
            for p, n in zh.iter_files(header)
            if "offset" in n
        }


def unpacked_paths(asar: Path) -> set:
    with asar.open("rb") as fh:
        header, _ = zh.read_header(fh)
        return {p for p, n in zh.iter_files(header) if "offset" not in n}


def test_write_then_read_roundtrip():
    with tempfile.TemporaryDirectory() as tmp:
        asar = Path(tmp) / "app.asar"
        files = make_files()
        zh.write_asar(asar, files)
        assert read_all(asar) == files


def test_repack_edits_content_and_offsets():
    with tempfile.TemporaryDirectory() as tmp:
        asar = Path(tmp) / "app.asar"
        files = make_files()
        zh.write_asar(asar, files)
        new_index = files["out/main/index.js"] + b'import("/x/loader.cjs");\n'
        zh.repack_asar(asar, {"out/main/index.js": new_index})
        got = read_all(asar)
        assert got["out/main/index.js"] == new_index
        for p in files:
            if p != "out/main/index.js":
                assert got[p] == files[p], p


def test_repack_no_edit_is_noop():
    with tempfile.TemporaryDirectory() as tmp:
        asar = Path(tmp) / "app.asar"
        files = make_files()
        zh.write_asar(asar, files)
        zh.repack_asar(asar, {})
        assert read_all(asar) == files


def test_integrity_shape():
    data = b"x" * (4194304 + 10)
    i = zh.asar_integrity(data)
    assert i["algorithm"] == "SHA256"
    assert len(i["blocks"]) == 2
    assert i["hash"] == hashlib.sha256(data).hexdigest()


def test_repack_real_asar_roundtrip():
    """只读复制真实 asar → 空编辑重打包 → 逐文件字节比对。"""
    if not REAL_ASAR.is_file():
        print("      （本机无 ZCode，跳过）")
        return
    with tempfile.TemporaryDirectory() as tmp:
        copy = Path(tmp) / "app.asar"
        shutil.copyfile(REAL_ASAR, copy)
        before = read_all(copy)
        zh.repack_asar(copy, {})
        after = read_all(copy)
        assert set(after) == set(before)
        for p in before:
            assert after[p] == before[p], p
        # unpacked 节点条目必须原样保留
        if before_unpacked := unpacked_paths(REAL_ASAR):
            assert unpacked_paths(copy) >= before_unpacked


def main() -> int:
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for test in tests:
        try:
            test()
        except Exception:
            failed += 1
            print(f"FAIL  {test.__name__}")
            traceback.print_exc()
        else:
            print(f"PASS  {test.__name__}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
