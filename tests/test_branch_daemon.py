#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""zch_branch_daemon 测试：真实起服务、查临时 git 仓库，不碰任何真实数据。

运行：python3 tests/test_branch_daemon.py
"""

import json
import os
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DAEMON = ROOT / "plugins" / "zcode-branch-badge" / "scripts" / "zch_branch_daemon.py"
ENGINE = ROOT / "plugins" / "zcode-branch-badge" / "scripts" / "zcode_helper.py"
PORT = 39501  # 测试专用端口，避免和真实服务冲突
BASE = f"http://127.0.0.1:{PORT}"


def start_daemon(extra_env=None) -> subprocess.Popen:
    env = dict(os.environ, ZCH_BRANCH_PORTS=str(PORT))
    if extra_env:
        env.update(extra_env)
    proc = subprocess.Popen(
        [sys.executable, str(DAEMON)],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    for _ in range(50):
        try:
            with urllib.request.urlopen(f"{BASE}/ping", timeout=0.5) as resp:
                if resp.status == 200:
                    return proc
        except OSError:
            time.sleep(0.1)
    proc.kill()
    raise RuntimeError("daemon 启动失败")


def query(path: str) -> dict:
    url = f"{BASE}/branch?path={urllib.parse.quote(path)}"
    with urllib.request.urlopen(url, timeout=5) as resp:
        return json.loads(resp.read().decode("utf-8"))


def request_status(path: str) -> int:
    """GET 一次返回状态码；端点缺失（404）也照常返回，便于断言。"""
    try:
        with urllib.request.urlopen(f"{BASE}{path}", timeout=5) as resp:
            return resp.status
    except urllib.error.HTTPError as exc:
        return exc.code


def wait_exit(proc: subprocess.Popen, seconds: float) -> bool:
    """轮询等待进程退出；超时返回 False（不杀进程，由调用方收尾）。"""
    for _ in range(int(seconds / 0.1)):
        if proc.poll() is not None:
            return True
        time.sleep(0.1)
    return False


def git(repo: Path, *args: str) -> str:
    out = subprocess.run(
        ["git", "-C", str(repo), *args], check=True, capture_output=True, text=True
    )
    return out.stdout.strip()


def test_daemon() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        proc = start_daemon()
        try:
            repo = tmp / "repo"
            repo.mkdir()
            git(repo, "init")
            git(repo, "config", "user.email", "t@example.com")
            git(repo, "config", "user.name", "t")
            (repo / "a.txt").write_text("x")
            git(repo, "add", ".")
            git(repo, "commit", "-m", "init")
            branch = git(repo, "rev-parse", "--abbrev-ref", "HEAD")
            assert query(str(repo))["label"] == branch, f"分支应为 {branch}"

            # detached HEAD → HEAD@<短SHA>
            sha = git(repo, "rev-parse", "HEAD")
            git(repo, "checkout", "--detach", "HEAD")
            label = query(str(repo))["label"]
            assert label == f"HEAD@{sha[:7]}", f"detached 应为 HEAD@{sha[:7]}，实际 {label}"

            # 非 git 目录 / 不存在路径 → null
            plain = tmp / "plain"
            plain.mkdir()
            assert query(str(plain))["label"] is None
            assert query(str(tmp / "no-such"))["label"] is None
            assert query("")["label"] is None
        finally:
            proc.terminate()
            proc.wait(timeout=5)


def test_heartbeat_endpoint() -> None:
    proc = start_daemon()
    try:
        assert request_status("/heartbeat") == 200, "/heartbeat 应返回 200"
    finally:
        proc.terminate()
        proc.wait(timeout=5)


def test_shutdown_endpoint() -> None:
    proc = start_daemon()
    try:
        assert request_status("/shutdown") == 200, "/shutdown 应返回 200"
        assert wait_exit(proc, 3), "daemon 应在 /shutdown 后几秒内退出"
    finally:
        if proc.poll() is None:
            proc.terminate()
            proc.wait(timeout=5)


def test_heartbeat_timeout_exits() -> None:
    # 收到过心跳后心跳停止超过超时（注入 1s 超时、0.2s watchdog 步进）→ 自动退出
    proc = start_daemon({"ZCH_HEARTBEAT_TIMEOUT": "1", "ZCH_WATCHDOG_INTERVAL": "0.2"})
    try:
        assert request_status("/heartbeat") == 200
        assert wait_exit(proc, 6), "心跳停止超过超时后 daemon 应自动退出"
    finally:
        if proc.poll() is None:
            proc.terminate()
            proc.wait(timeout=5)


def test_without_heartbeat_stays_alive() -> None:
    # 从未收到过心跳（旧版宿主 / 手动启动）→ 不自杀，保持现行为
    proc = start_daemon({"ZCH_HEARTBEAT_TIMEOUT": "1", "ZCH_WATCHDOG_INTERVAL": "0.2"})
    try:
        time.sleep(2.5)
        assert proc.poll() is None, "从未收到心跳的 daemon 不应自动退出"
    finally:
        proc.terminate()
        proc.wait(timeout=5)


def run_cli_stop() -> subprocess.CompletedProcess:
    """用注入端口段跑引擎 daemon stop（避免碰真实 39217 服务）。"""
    return subprocess.run(
        [sys.executable, str(ENGINE), "daemon", "stop"],
        env=dict(os.environ, ZCH_BRANCH_PORTS=str(PORT)),
        capture_output=True,
        text=True,
        timeout=15,
    )


def test_cli_stop_kills_daemon() -> None:
    proc = start_daemon()
    try:
        out = run_cli_stop()
        assert out.returncode == 0, f"stop 应成功：{out.stdout} {out.stderr}"
        assert "已停止" in out.stdout, f"应报告已停止：{out.stdout}"
        assert wait_exit(proc, 3), "daemon 应在 stop 后退出"
    finally:
        if proc.poll() is None:
            proc.terminate()
            proc.wait(timeout=5)


def test_cli_stop_without_daemon() -> None:
    out = run_cli_stop()
    assert out.returncode == 0, f"无服务时 stop 应幂等成功：{out.stdout} {out.stderr}"
    assert "未运行" in out.stdout, f"应报告未运行：{out.stdout}"


def main() -> int:
    failed = 0
    total = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            total += 1
            try:
                fn()
            except Exception:
                failed += 1
                print(f"FAIL  {name}")
                traceback.print_exc()
            else:
                print(f"PASS  {name}")
    print(f"\n{failed} failed / {total} total")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
