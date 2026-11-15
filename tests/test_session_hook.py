#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SessionStart / UserPromptSubmit hook 测试（仅依赖标准库）。

运行：python3 tests/test_session_hook.py
"""

import fcntl
import importlib.util
import io
import json
import os
import subprocess
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


def _dead_pid() -> int:
    """拿一个确定已退出的进程 pid（启动即退出），避免猜测不存在的 pid。"""
    proc = subprocess.Popen([sys.executable, "-c", "pass"])
    proc.wait()
    return proc.pid


def _isolated(hook, tmp: str) -> None:
    """把 hook 的所有落盘路径隔离进临时目录，避免测试碰真实的 ~/.zcode。"""
    hook.LOADER_HOME = Path(tmp) / "loaderhome"
    hook.INSTALL_LOCK = hook.LOADER_HOME / "install.lock"
    hook.ACTIVE_FILE = hook.LOADER_HOME / "active.json"


def _active_file(tmp: str, pid: int) -> Path:
    path = Path(tmp) / "active.json"
    path.write_text(json.dumps({"pid": pid, "activatedAt": "2026-01-01T00:00:00Z"}), encoding="utf-8")
    return path


def _run_main(hook) -> str:
    buf = io.StringIO()
    with mock.patch("sys.stdout", buf):
        assert hook.main() == 0
    return buf.getvalue()


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


def test_notify_disabled_reads_config():
    hook = load_hook("hook_notify")
    with tempfile.TemporaryDirectory() as tmp:
        hook.CONFIG = Path(tmp) / "config.json"
        assert hook.notify_enabled() is True
        hook.CONFIG.write_text('{"notify": false}', encoding="utf-8")
        assert hook.notify_enabled() is False


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
    """autoApply 开启时，main 应调用引擎的 loader install --quiet（幂等）。

    hook 对「already + 未激活」还会调 osascript 发系统通知——同一个
    subprocess.run mock 会被一并拦截，所以只统计引擎调用本身。
    """
    hook = load_hook("hook_loader_install")
    with tempfile.TemporaryDirectory() as tmp:
        _isolated(hook, tmp)  # ACTIVE_FILE 缺失 → 走提醒分支
        with mock.patch.object(hook.subprocess, "run") as run:
            run.return_value = _fake_proc('{"action": "already"}')
            with mock.patch("sys.stdout"):
                hook.main()
            engine_calls = [
                c for c in run.call_args_list
                if "loader" in c.args[0] and "install" in c.args[0]
            ]
            assert len(engine_calls) == 1, repr(run.call_args_list)
            assert "--quiet" in engine_calls[0].args[0], repr(engine_calls[0].args[0])


def test_installed_prints_restart_hint():
    """首次安装（action=installed）时提示完全退出重开。"""
    hook = load_hook("hook_installed_hint")
    with tempfile.TemporaryDirectory() as tmp:
        _isolated(hook, tmp)
        with mock.patch.object(hook.subprocess, "run") as run:
            run.return_value = _fake_proc('{"action": "installed", "synced": ["loader.cjs"]}')
            assert "重新打开" in _run_main(hook)


def test_installed_also_notifies():
    """首装时发 macOS 系统通知（osascript，随 subprocess mock 一并验证）。"""
    hook = load_hook("hook_installed_notify")
    with tempfile.TemporaryDirectory() as tmp:
        _isolated(hook, tmp)
        hook.CONFIG = Path(tmp) / "config.json"  # 不存在 → notify 默认开
        with mock.patch.object(hook.subprocess, "run") as run:
            run.return_value = _fake_proc('{"action": "installed"}')
            with mock.patch.object(hook.platform, "system", return_value="Darwin"):
                hook.notify("测试消息")
            argv = run.call_args[0][0]
            assert argv[0] == "osascript" and "测试消息" in argv[2]


def test_already_with_active_loader_is_silent():
    """指针已在位且 loader 激活（active.json 的 pid 活着）时零输出。"""
    hook = load_hook("hook_already_active")
    with tempfile.TemporaryDirectory() as tmp:
        _isolated(hook, tmp)
        hook.ACTIVE_FILE = _active_file(tmp, os.getpid())
        with mock.patch.object(hook.subprocess, "run") as run:
            run.return_value = _fake_proc('{"action": "already"}')
            assert _run_main(hook) == ""


def test_already_without_active_loader_prompts_restart():
    """指针已在位但 loader 从未激活（无 active.json）→ 提示重启一次。"""
    hook = load_hook("hook_already_stale")
    with tempfile.TemporaryDirectory() as tmp:
        _isolated(hook, tmp)
        with mock.patch.object(hook.subprocess, "run") as run:
            run.return_value = _fake_proc('{"action": "already"}')
            assert "重新打开" in _run_main(hook)


def test_already_with_dead_pid_prompts_restart():
    """active.json 里的 pid 已退出（ZCode 没重启成功/装完没重启）→ 提示重启。"""
    hook = load_hook("hook_already_dead")
    with tempfile.TemporaryDirectory() as tmp:
        _isolated(hook, tmp)
        hook.ACTIVE_FILE = _active_file(tmp, _dead_pid())
        with mock.patch.object(hook.subprocess, "run") as run:
            run.return_value = _fake_proc('{"action": "already"}')
            assert "重新打开" in _run_main(hook)


def test_sibling_lock_is_silent():
    """另一个插件的 hook 持有 install.lock 时静默退出，避免同波双提示。"""
    hook = load_hook("hook_sibling_lock")
    with tempfile.TemporaryDirectory() as tmp:
        _isolated(hook, tmp)
        hook.INSTALL_LOCK.parent.mkdir(parents=True, exist_ok=True)
        with open(hook.INSTALL_LOCK, "w") as held:
            fcntl.flock(held, fcntl.LOCK_EX)
            with mock.patch.object(hook.subprocess, "run") as run:
                assert _run_main(hook) == ""
                run.assert_not_called()


def test_lock_released_after_install():
    """安装完成后锁必须释放，后续触发能正常拿到。"""
    hook = load_hook("hook_lock_release")
    with tempfile.TemporaryDirectory() as tmp:
        _isolated(hook, tmp)
        with mock.patch.object(hook.subprocess, "run") as run:
            run.return_value = _fake_proc('{"action": "already"}')
            with mock.patch("sys.stdout"):
                hook.main()  # 拿锁 → 安装 → 释放
        # 释放后本进程可再次加锁（fcntl 对同一进程的不同 fd 也互斥）
        with open(hook.INSTALL_LOCK, "w") as fh:
            fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(fh, fcntl.LOCK_UN)


def test_error_action_prints_reason():
    """安装失败（如 not_writable）时输出一行简短原因，不再静默。"""
    hook = load_hook("hook_error_reason")
    with tempfile.TemporaryDirectory() as tmp:
        _isolated(hook, tmp)
        with mock.patch.object(hook.subprocess, "run") as run:
            run.return_value = _fake_proc('{"action": "error", "reason": "not_writable"}')
            output = _run_main(hook)
            assert "失败" in output and "不可写" in output


def test_no_payload_prints_hint():
    """引擎无 JSON 输出（超时/异常）时输出排查提示。"""
    hook = load_hook("hook_no_payload")
    with tempfile.TemporaryDirectory() as tmp:
        _isolated(hook, tmp)
        with mock.patch.object(hook.subprocess, "run") as run:
            run.return_value = _fake_proc("")
            assert "排查" in _run_main(hook)


def test_subprocess_failure_is_silent():
    """引擎调用失败时静默退出，不抛异常。"""
    hook = load_hook("hook_sub_fail")
    with tempfile.TemporaryDirectory() as tmp:
        _isolated(hook, tmp)
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
