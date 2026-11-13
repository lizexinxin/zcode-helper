#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SessionStart hook 测试（仅依赖标准库）。

运行：python3 tests/test_session_hook.py
"""

import importlib.util
import io
import sys
import tempfile
import traceback
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "plugins" / "zcode-folder-full-path" / "hooks" / "session-start.py"


def load_hook(name: str):
    spec = importlib.util.spec_from_file_location(name, SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_missing_tool_is_silent():
    """找不到引擎脚本时静默退出（升级/卸载过渡期不刷屏）。"""
    hook = load_hook("hook_missing_tool")
    old = hook.TOOL
    hook.TOOL = Path("/nonexistent/zcode_helper.py")
    try:
        assert hook.main() == 0
    finally:
        hook.TOOL = old


def test_auto_apply_disabled_reads_config():
    hook = load_hook("hook_auto_apply")
    with tempfile.TemporaryDirectory() as tmp:
        hook.CONFIG = Path(tmp) / "config.json"
        assert hook.auto_apply_enabled() is True
        hook.CONFIG.write_text('{"autoApply": false}', encoding="utf-8")
        assert hook.auto_apply_enabled() is False


def test_daemon_start_only_when_script_present():
    """只有目录里带 zch_branch_daemon.py 时才尝试拉起 daemon。"""
    hook = load_hook("hook_daemon")
    with mock.patch.object(hook.subprocess, "run") as run:
        hook.DAEMON_SCRIPT = hook.ROOT / "scripts" / "nope.py"
        hook.ensure_daemon()
        run.assert_not_called()
        with tempfile.TemporaryDirectory() as tmp:
            fake = Path(tmp) / "zch_branch_daemon.py"
            fake.write_text("# fake daemon script", encoding="utf-8")
            hook.DAEMON_SCRIPT = fake
            hook.ensure_daemon()
            assert run.call_count == 1


def test_plugin_name_fallback():
    """清单缺失时回退目录名。"""
    hook = load_hook("hook_name_fallback")
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "some-plugin"
        root.mkdir()
        assert hook._plugin_name(root) == "some-plugin"


def _fake_proc(stdout: str):
    proc = mock.Mock()
    proc.stdout = stdout
    proc.returncode = 0
    return proc


def test_main_calls_loader_install():
    """autoApply 开启时，main 应调用引擎的 loader install --quiet（幂等）。"""
    hook = load_hook("hook_loader_install")
    with mock.patch.object(hook.subprocess, "run") as run:
        run.return_value = _fake_proc('{"action": "already"}')
        with mock.patch("sys.stdout"):
            hook.main()
        assert run.call_count == 1
        argv = run.call_args[0][0]
        assert "loader" in argv and "install" in argv and "--quiet" in argv


def test_installed_prints_restart_hint():
    """首次安装（action=installed）时提示完全退出重开。"""
    hook = load_hook("hook_installed_hint")
    with mock.patch.object(hook.subprocess, "run") as run:
        run.return_value = _fake_proc('{"action": "installed", "synced": ["loader.cjs"]}')
        buf = io.StringIO()
        with mock.patch("sys.stdout", buf):
            assert hook.main() == 0
        assert "重新打开" in buf.getvalue()


def test_already_installed_is_silent():
    """loader 已在位时无输出（不刷会话上下文）。"""
    hook = load_hook("hook_already_silent")
    with mock.patch.object(hook.subprocess, "run") as run:
        run.return_value = _fake_proc('{"action": "already"}')
        buf = io.StringIO()
        with mock.patch("sys.stdout", buf):
            assert hook.main() == 0
        assert buf.getvalue() == ""


def test_subprocess_failure_is_silent():
    """引擎调用失败时静默退出，不抛异常。"""
    hook = load_hook("hook_sub_fail")
    with mock.patch.object(hook.subprocess, "run", side_effect=OSError("boom")):
        assert hook.main() == 0


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
