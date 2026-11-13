#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""zch-branch-daemon：本地 git 分支查询服务（folder-git-branch 补丁的数据源）。

- 只绑定 127.0.0.1，端口在 ZCH_BRANCH_PORTS（逗号分隔）或默认 39217-39221
  中选第一个空闲的；已被占用说明已有实例在跑，逐个尝试不会冲突。
- GET /ping                    → 200 "ok"（payload 探测用）
- GET /branch?path=<绝对路径>  → 200 {"label": "main" | "HEAD@<短SHA>" | null}
  路径必须是存在的目录；git branch --show-current 为空（detached）时改用
  rev-parse --short HEAD；git 命令失败（非仓库）→ null。
- 所有响应带 Access-Control-Allow-Origin: *，file:// 页面（null origin）可调。
- 只做只读 git 查询，无任何写操作；仅监听回环地址，自用安全边界见 README。

用法：python3 zch_branch_daemon.py    # 前台运行；由 zcode_helper.py daemon start 托管
"""

import json
import os
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

DEFAULT_PORTS = list(range(39217, 39222))


def query_branch(path: str) -> str | None:
    """返回分支名 / detached 短 SHA（HEAD@xxx）/ None（非目录或非 git 仓库）。"""
    if not path or not os.path.isabs(path) or not os.path.isdir(path):
        return None

    def git(*args: str) -> str:
        try:
            proc = subprocess.run(
                ["git", "-C", path, *args],
                capture_output=True,
                timeout=5,
            )
        except (OSError, subprocess.SubprocessError):
            return ""
        return proc.stdout.decode("utf-8", "replace").strip() if proc.returncode == 0 else ""

    branch = git("branch", "--show-current")
    if branch:
        return branch
    sha = git("rev-parse", "--short", "HEAD")
    return f"HEAD@{sha}" if sha else None


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        url = urlparse(self.path)
        if url.path == "/ping":
            body, ctype = b"ok", "text/plain; charset=utf-8"
        elif url.path == "/branch":
            path = (parse_qs(url.query).get("path") or [""])[0]
            body = json.dumps({"label": query_branch(path)}, ensure_ascii=False).encode("utf-8")
            ctype = "application/json; charset=utf-8"
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args) -> None:
        pass  # 静默，日志交给重定向方


def main() -> int:
    raw = os.environ.get("ZCH_BRANCH_PORTS", "")
    ports = [int(p) for p in raw.split(",") if p.strip()] or DEFAULT_PORTS
    server = None
    for port in ports:
        try:
            server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
            break
        except OSError:
            continue
    if server is None:
        print(f"端口段全部不可用：{ports}", file=sys.stderr)
        return 1
    print(f"listening on 127.0.0.1:{server.server_address[1]}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
