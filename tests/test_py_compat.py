#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Python 3.9 兼容把关（仅依赖标准库）。

hook 运行在 ZCode 提供的解释器上（本机实测为 3.9.x）。两类历史坑：

1. 3.10+ 语法（如 match、括号内多 with）→ 3.9 解析阶段直接 SyntaxError；
2. 注解里的 PEP 604 联合类型（`str | None`）且缺少 `from __future__ import
   annotations` → 3.9 在 def 时立即求值注解，抛 TypeError（真实案例：
   zch_branch_daemon.py 的 `-> str | None` 让分支服务起不来）。

运行：python3 tests/test_py_compat.py
"""

import ast
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 会随插件分发、由 hook / daemon 的解释器执行的脚本（不含 tests/ 本身）
SCRIPTS = [
    "shared/zcode_helper.py",
    "shared/session-start.py",
    "plugins/zcode-folder-full-path/scripts/zcode_helper.py",
    "plugins/zcode-folder-full-path/hooks/session-start.py",
    "plugins/zcode-branch-badge/scripts/zcode_helper.py",
    "plugins/zcode-branch-badge/hooks/session-start.py",
    "plugins/zcode-branch-badge/scripts/zch_branch_daemon.py",
]


def _has_future_annotations(tree: ast.Module) -> bool:
    for node in tree.body:
        if isinstance(node, ast.ImportFrom) and node.module == "__future__":
            for alias in node.names:
                if alias.name == "annotations":
                    return True
    return False


def _annotation_nodes(tree: ast.Module):
    """收集所有注解子树（参数、返回值、AnnAssign），只在这些位置查 PEP 604。"""
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            args = node.args
            for a in args.posonlyargs + args.args + args.kwonlyargs:
                if a.annotation is not None:
                    yield a.annotation
            if args.vararg and args.vararg.annotation:
                yield args.vararg.annotation
            if args.kwarg and args.kwarg.annotation:
                yield args.kwarg.annotation
            if node.returns is not None:
                yield node.returns
        elif isinstance(node, ast.AnnAssign) and node.annotation is not None:
            yield node.annotation


def _pep604_in_annotations(tree: ast.Module) -> int:
    """注解里 `X | Y`（BitOr）的出现次数。"""
    count = 0
    for ann in _annotation_nodes(tree):
        for sub in ast.walk(ann):
            if isinstance(sub, ast.BinOp) and isinstance(sub.op, ast.BitOr):
                count += 1
    return count


def main() -> int:
    failed = False
    for rel in SCRIPTS:
        path = ROOT / rel
        if not path.is_file():
            print(f"FAIL  缺少文件：{rel}")
            failed = True
            continue
        source = path.read_text(encoding="utf-8")
        try:
            tree = ast.parse(source, filename=str(path), feature_version=(3, 9))
        except SyntaxError as exc:
            print(f"FAIL  {rel}: Python 3.9 不兼容的语法 → {exc}")
            failed = True
            continue
        pep604 = _pep604_in_annotations(tree)
        if pep604 and not _has_future_annotations(tree):
            print(
                f"FAIL  {rel}: 注解里有 {pep604} 处 `X | Y` 且缺少 "
                f"from __future__ import annotations（3.9 会在 def 时求值崩溃）；"
                f"改用 typing.Optional 或补 future import"
            )
            failed = True
            continue
        print(f"PASS  {rel}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
