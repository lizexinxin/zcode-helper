#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""zcode_helper 补丁引擎测试（仅依赖标准库）。

运行：python3 tests/test_patch_engine.py

覆盖重点：`find` 中的 `{{ident}}` 通配符。ZCode 每次升级都会重新压缩
bundle，被调用函数的名字会变（3.16.3 是 `kv`，3.17.1 变成 `ey`），
补丁必须在这一变化下依然命中。
"""

import importlib.util
import json
import struct
import sys
import tempfile
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "plugins" / "zcode-helper" / "scripts" / "zcode_helper.py"

_spec = importlib.util.spec_from_file_location("zcode_helper", SCRIPT)
zh = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(zh)

TARGET_PATH = "out/renderer/assets/styles-test.js"
CLS = "`min-w-0 flex-1 break-all text-ui-base`"
CLS_TRUNCATE = "`min-w-0 flex-1 truncate text-ui-base`"
TESTID = '`virtual-project-root-name`'

REPLACE = (
    f"className:{CLS},title:t,"
    f'"data-testid":{TESTID},children:t'
)
FIND_TEMPLATE = (
    f"className:r?{CLS}:{CLS_TRUNCATE},title:t,"
    f'"data-testid":{TESTID},children:r?t:{{{{ident}}}}(t)'
)


def snippet(ident: str) -> str:
    return (
        f"className:r?{CLS}:{CLS_TRUNCATE},title:t,"
        f'"data-testid":{TESTID},children:r?t:{ident}(t)'
    )


def make_patch(find=FIND_TEMPLATE) -> dict:
    return {
        "id": "test-patch",
        "title": "测试补丁",
        "version": 1,
        "locate": {
            "pathPrefix": "out/renderer/assets/",
            "pathSuffix": ".js",
            "minSize": 1000,
            "contains": ["virtual-project-root-name"],
        },
        "replacements": [
            {"find": find, "replace": REPLACE, "expectedCount": 1},
        ],
    }


def build_bundle(ident: str) -> bytes:
    """构造一个 >1MB 的假 bundle，目标片段只出现一次。"""
    head = b"var filler_1=\"" + b"x" * 600_000 + b"\";"
    mid = ("function X(e){return " + snippet(ident) + "}").encode("utf-8")
    tail = b"var filler_2=\"" + b"y" * 600_000 + b"\";"
    return head + mid + tail


def build_asar(path: Path, files: dict) -> None:
    """按 asar 格式写一个最小归档：16 字节头 + JSON header + 文件数据区。"""
    header = {"files": {}}
    offset = 0
    blobs = []
    for name, data in files.items():
        parts = name.split("/")
        node = header
        for part in parts[:-1]:
            child = node["files"].get(part)
            if child is None:
                child = node["files"][part] = {"files": {}}
            node = child
        node["files"][parts[-1]] = {"size": len(data), "offset": str(offset)}
        offset += len(data)
        blobs.append(data)
    raw = json.dumps(header, separators=(",", ":")).encode("utf-8")
    pad = (-len(raw)) % 4
    pickle_size = 8 + len(raw) + pad
    head = struct.pack("<4I", 4, pickle_size, pickle_size, len(raw))
    path.write_bytes(head + raw + b"\x00" * pad + b"".join(blobs))


class Case:
    def __init__(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.asar = self.dir / "app.asar"
        self.state_path = self.dir / "state.json"
        # 隔离真实状态文件，测试不碰 ~/.zcode/zcode-helper/
        zh.STATE_PATH = self.state_path
        zh.DATA_DIR = self.dir

    def close(self):
        self._tmp.cleanup()


def run_flow(ident: str, patch=None):
    """对一个含指定标识符的假 bundle 完成 not_applied → applied → 还原。"""
    patch = patch or make_patch()
    case = Case()
    try:
        build_asar(
            case.asar,
            {
                "package.json": b'{"version":"3.17.1"}',
                TARGET_PATH: build_bundle(ident),
            },
        )
        size_before = case.asar.stat().st_size
        state = zh.load_state()

        with zh.open_asar(case.asar) as (fh, header, data_base):
            before = zh.patch_state(fh, data_base, header, patch)
            assert before[0] == "not_applied", f"[{ident}] 初始状态应为 not_applied，实际 {before[0]}"
            applied = zh.apply_patch(fh, data_base, header, patch, state)
            assert applied["status"] == "applied", f"[{ident}] 应用失败：{applied}"
            after = zh.patch_state(fh, data_base, header, patch)
            assert after[0] == "applied", f"[{ident}] 应用后状态应为 applied，实际 {after[0]}"

        assert case.asar.stat().st_size == size_before, f"[{ident}] asar 大小不应改变"
        body = case.asar.read_bytes()
        assert snippet(ident).encode("utf-8") not in body, f"[{ident}] 原始片段应已被替换"
        assert REPLACE.encode("utf-8") in body, f"[{ident}] 应写入替换后的片段"

        # 幂等：再跑一次不应重复写入
        with zh.open_asar(case.asar) as (fh, header, data_base):
            again = zh.apply_patch(fh, data_base, header, patch, state)
            assert again["status"] == "already_applied", f"[{ident}] 重复应用应为 already_applied，实际 {again['status']}"

        # 还原回原始字节
        with zh.open_asar(case.asar) as (fh, _header, _data_base):
            restored = zh.restore_patch(fh, patch, state, case.asar)
            assert restored["status"] == "restored", f"[{ident}] 还原失败：{restored}"
        body = case.asar.read_bytes()
        assert snippet(ident).encode("utf-8") in body, f"[{ident}] 还原后应恢复原始片段"
        assert case.asar.stat().st_size == size_before, f"[{ident}] 还原后 asar 大小不应改变"
    finally:
        case.close()


def test_ident_kv():
    """3.16.3 的形态。"""
    run_flow("kv")


def test_ident_ey():
    """3.17.1 的形态——上一轮手工适配的就是这个。"""
    run_flow("ey")


def test_ident_other_lengths():
    """任意长度/形态的标识符都能命中（升级后名字可能变成别的）。"""
    for ident in ("a", "aBcDef", "$x", "_min"):
        run_flow(ident)


def test_literal_find_still_works():
    """不含 {{ident}} 的旧式 find 保持原有行为。"""
    run_flow("kv", make_patch(find=snippet("kv")))


def test_ident_token_in_replace_is_not_expanded():
    """{{ident}} 只作用于 find；replace 里的花括号按字面量处理。"""
    patch = make_patch()
    patch["replacements"][0]["replace"] = REPLACE + "/*{{ident}}*/"
    # replace 变长后仍是等长范围，能正常应用
    run_flow("ey", patch)


def test_pattern_not_found_is_reported():
    """目标片段不存在时报 pattern_not_found，且不修改文件。"""
    case = Case()
    try:
        build_asar(
            case.asar,
            {"package.json": b'{"version":"3.17.1"}', TARGET_PATH: build_bundle("kv")},
        )
        patch = make_patch(find=FIND_TEMPLATE.replace("children:r?t:", "children:zz:"))
        size_before = case.asar.stat().st_size
        with zh.open_asar(case.asar) as (fh, header, data_base):
            result = zh.apply_patch(fh, data_base, header, patch, zh.load_state())
            assert result["status"] == "pattern_not_found", result
        assert case.asar.stat().st_size == size_before
        assert snippet("kv").encode("utf-8") in case.asar.read_bytes()
    finally:
        case.close()


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