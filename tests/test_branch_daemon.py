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
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DAEMON = ROOT / "plugins" / "zcode-helper" / "scripts" / "zch_branch_daemon.py"
PORT = 39501  # 测试专用端口，避免和真实服务冲突
BASE = f"http://127.0.0.1:{PORT}"


def start_daemon() -> subprocess.Popen:
    env = dict(os.environ, ZCH_BRANCH_PORTS=str(PORT))
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


def git(repo: Path, *args: str) -> str:
    out = subprocess.run(
        ["git", "-C", str(repo), *args], check=True, capture_output=True, text=True
    )
    return out.stdout.strip()


def test_daemon(tmp: Path) -> None:
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


def main() -> int:
    failed = 0
    with tempfile.TemporaryDirectory() as tmpdir:
        for name, fn in sorted(globals().items()):
            if name.startswith("test_") and callable(fn):
                try:
                    fn(Path(tmpdir))
                except Exception:
                    failed += 1
                    print(f"FAIL  {name}")
                    traceback.print_exc()
                else:
                    print(f"PASS  {name}")
    print(f"\n{failed} failed / 1 total")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
