# folder-git-branch 补丁实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ZCode「编辑项目 → 源文件夹」列表中，为每个 git 仓库文件夹显示当前分支徽章（如 `⎇ main`）。

**Architecture:** index.html 内一处等长替换（压缩启动动画 CSS 腾出空间注入 `<script>` 引导标签）；payload JS 放在 `~/.zcode/zcode-helper/inject/`，用 MutationObserver 盯弹窗行元素；分支数据由本地 Python 服务（127.0.0.1，端口段 39217-39221）执行只读 git 查询提供。asar 内不碰任何压缩 JS。

**Tech Stack:** Python 标准库（http.server、subprocess）、原生浏览器 JS（无构建）、现有 asar 等长替换补丁引擎。

**设计文档:** `docs/superpowers/specs/2026-11-13-folder-git-branch-design.md`

## Global Constraints

- 所有 asar 改动只能走现有等长替换引擎（find/replace 等长 + 空格补齐），不改引擎核心、不重打包。
- Python 代码只用标准库；payload 为原生 JS，无构建步骤。
- daemon 只绑定 `127.0.0.1`，端口段 `39217-39221`，可用环境变量 `ZCH_BRANCH_PORTS`（逗号分隔）覆盖。
- payload 运行时固定路径：`file:///Users/zexin.li/.zcode/zcode-helper/inject/branch-badge.js`（用户专属硬编码，spec §3 已确认）。
- 自动化测试只用合成 asar / 临时目录，绝不碰真实 `/Applications/ZCode.app/Contents/Resources/app.asar` 和真实 `~/.zcode/zcode-helper/state.json`；真实 apply 仅在 Task 5 手动执行。
- 当前 ZCode 版本 **3.18.2**（补丁 JSON 的 `verifiedZcodeVersions` 记录此值）。
- 测试沿用 `tests/test_patch_engine.py` 的自研 runner 风格（`python3 tests/xxx.py` 直接运行，不依赖 pytest）。
- 工作目录：本计划的 worktree 根 `/Users/zexin.li/projects/github/lizexinxin/zcode-helper/.zcode/worktrees/worktree-lzx-folder-git-branch`（下文相对路径均基于此）。

---

### Task 1: 本地分支服务 zch_branch_daemon.py

**Files:**
- Create: `plugins/zcode-helper/scripts/zch_branch_daemon.py`
- Test: `tests/test_branch_daemon.py`

**Interfaces:**
- Consumes: 无（独立组件）。
- Produces:
  - `GET /ping` → 200 `ok`
  - `GET /branch?path=<绝对路径>` → 200 `{"label": "main"}` / `{"label": "HEAD@8f3a2b1"}`（detached）/ `{"label": null}`（非目录/非仓库）；响应带 `Access-Control-Allow-Origin: *`
  - 端口段 `ZCH_BRANCH_PORTS`（逗号分隔）或默认 `39217-39221`，绑定第一个空闲的
  - Task 4 的 `zcode_helper.py` 以子进程方式拉起本脚本（`python3 zch_branch_daemon.py`，无参数）

- [ ] **Step 1: 写失败测试**

创建 `tests/test_branch_daemon.py`：

```python
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""zch_branch_daemon 测试：真实起服务、查临时 git 仓库，不碰任何真实数据。

运行：python3 tests/test_branch_daemon.py
"""

import json
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
    import os
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
    print(f"\n{'1 - failed' if not failed else failed} failed / 1 total")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
```

注意：`main()` 的汇总行请直接写成 `print(f"\n{failed} failed / 1 total")`（上面模板最后一处容易写花，实现时以此行为准）。

- [ ] **Step 2: 运行测试确认失败**

Run: `python3 tests/test_branch_daemon.py`
Expected: FAIL（`daemon 启动失败`，因为脚本尚不存在）

- [ ] **Step 3: 实现 daemon**

创建 `plugins/zcode-helper/scripts/zch_branch_daemon.py`：

```python
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `python3 tests/test_branch_daemon.py`
Expected: PASS（1/1）

- [ ] **Step 5: Commit**

```bash
git add plugins/zcode-helper/scripts/zch_branch_daemon.py tests/test_branch_daemon.py
git commit -m "feat: 本地 git 分支查询服务 zch-branch-daemon"
```

---

### Task 2: payload 注入脚本 branch-badge.js

**Files:**
- Create: `plugins/zcode-helper/inject/branch-badge.js`

**Interfaces:**
- Consumes: Task 1 的 daemon 接口（`/ping`、`/branch?path=`，端口 39217-39221）。
- Produces: 浏览器内效果——`[data-testid="virtual-project-root-row"]` 行的路径后出现 `⎇ <label>` 徽章。Task 3 的 script 标签按固定路径加载本文件；Task 4 的 apply 把本文件同步到 `~/.zcode/zcode-helper/inject/`。

- [ ] **Step 1: 编写 payload**

创建 `plugins/zcode-helper/inject/branch-badge.js`：

```javascript
/* zcode-helper: 编辑项目弹窗源文件夹显示 git 分支徽章。
 * 由 index.html 补丁注入的 <script> 加载（file:// 固定路径）。
 * 数据来自 zch-branch-daemon（127.0.0.1:39217-39221）；服务不在时静默降级。 */
(function () {
  "use strict";

  var PORTS = [39217, 39218, 39219, 39220, 39221];
  var TTL = 2000; // 每个路径的查询缓存毫秒数
  var BADGE_MARK = "data-zch-branch-badge";
  var ROW_SELECTOR = '[data-testid="virtual-project-root-row"]';
  var NAME_SELECTOR = '[data-testid="virtual-project-root-name"]';
  var base = null; // "http://127.0.0.1:<port>"，探测成功后设置
  var cache = new Map(); // path -> {label, at}
  var inflight = new Map(); // path -> Promise

  function ping(port) {
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () {
        if (!done) { done = true; resolve(false); }
      }, 800);
      fetch("http://127.0.0.1:" + port + "/ping")
        .then(function (resp) {
          if (!done) { done = true; clearTimeout(timer); resolve(resp.ok); }
        })
        .catch(function () {
          if (!done) { done = true; clearTimeout(timer); resolve(false); }
        });
    });
  }

  function discover() {
    var i = 0;
    function next() {
      if (i >= PORTS.length) return Promise.resolve(false);
      var port = PORTS[i++];
      return ping(port).then(function (ok) {
        if (ok) { base = "http://127.0.0.1:" + port; return true; }
        return next();
      });
    }
    return next();
  }

  function getLabel(path) {
    if (!base) return Promise.resolve(null);
    var hit = cache.get(path);
    if (hit && Date.now() - hit.at < TTL) return Promise.resolve(hit.label);
    var pending = inflight.get(path);
    if (pending) return pending;
    pending = fetch(base + "/branch?path=" + encodeURIComponent(path))
      .then(function (resp) { return resp.ok ? resp.json() : { label: null }; })
      .then(function (data) { return data.label || null; })
      .catch(function () { return null; })
      .then(function (label) {
        cache.set(path, { label: label, at: Date.now() });
        inflight.delete(path);
        return label;
      });
    inflight.set(path, pending);
    return pending;
  }

  function makeBadge(label) {
    var el = document.createElement("span");
    el.className = "text-ui-sm text-foreground-subtle"; // 复用应用全局样式表的 utility 类
    el.setAttribute(BADGE_MARK, "1");
    el.textContent = "⎇ " + label;
    el.style.cssText =
      "flex:none;margin-left:2px;white-space:nowrap;" +
      "border:1px solid rgba(128,128,128,.35);border-radius:4px;padding:1px 6px;";
    return el;
  }

  function decorate(row) {
    if (!(row instanceof Element) || !row.matches(ROW_SELECTOR)) return;
    if (row.querySelector("[" + BADGE_MARK + "]")) return;
    var name = row.querySelector(NAME_SELECTOR);
    if (!name) return;
    // title 属性始终是完整路径（不依赖 folder-full-path 补丁是否生效）
    var path = name.getAttribute("title") || (name.textContent || "").trim();
    if (!path || path.charCodeAt(0) !== 47 /* "/" */) return;
    getLabel(path).then(function (label) {
      if (!label || !row.isConnected) return;
      if (row.querySelector("[" + BADGE_MARK + "]")) return;
      var target = row.querySelector(NAME_SELECTOR);
      if (!target) return;
      target.after(makeBadge(label));
    });
  }

  function scan(nodes) {
    Array.prototype.forEach.call(nodes, function (node) {
      if (!(node instanceof Element)) return;
      if (node.matches(ROW_SELECTOR)) decorate(node);
      if (node.querySelectorAll) {
        node.querySelectorAll(ROW_SELECTOR).forEach(decorate);
      }
    });
  }

  function start() {
    var mo = new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        scan(m.addedNodes);
        // React 更新行内容可能移掉徽章：目标行仍存在时重新补挂
        if (m.removedNodes.length && m.target instanceof Element &&
            m.target.matches(ROW_SELECTOR)) {
          decorate(m.target);
        }
      });
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    scan([document.documentElement]);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }

  discover(); // 后台探测 daemon，探测成功前 getLabel 直接返回 null（无徽章）
})();
```

- [ ] **Step 2: 语法检查**

Run: `node --check plugins/zcode-helper/inject/branch-badge.js`
Expected: 无输出（语法正确）

- [ ] **Step 3: Commit**

```bash
git add plugins/zcode-helper/inject/branch-badge.js
git commit -m "feat: 编辑项目弹窗 git 分支徽章 payload"
```

（端到端效果验收在 Task 5。）

---

### Task 3: asar 补丁 folder-git-branch.json + 引擎测试

**Files:**
- Create: `plugins/zcode-helper/patches/folder-git-branch.json`
- Modify: `tests/test_patch_engine.py`（追加测试函数）

**Interfaces:**
- Consumes: 现有补丁引擎（`load_patches` 会自动加载 patches/*.json，无需注册）；payload 固定路径。
- Produces: 补丁 `folder-git-branch`（等长替换 `out/renderer/index.html` 的启动动画 CSS 区域，注入 script 标签）。Task 4/5 依赖此 id 和 payload 同步路径。

实测数据（2026-11-13，ZCode 3.18.2）：目标区块从 `      @keyframes startup-logo-pop {` 起到 `    </style>` 止，共 **593 字节**、UTF-8、LF 换行、在 index.html 中唯一；压缩后的 replace（含 script 标签）**389 字节**，放得下。

- [ ] **Step 1: 写失败测试**

在 `tests/test_patch_engine.py` 末尾（`def main()` 之前）追加：

```python
INDEX_HTML_PATH = "out/renderer/index.html"

# 与 patches/folder-git-branch.json 中的 find/replace 保持一致（Task 3 校验脚本保证）
BRANCH_FIND = (
    "      @keyframes startup-logo-pop {\n"
    "        0% {\n"
    "          opacity: 0;\n"
    "          transform: scale(0.72);\n"
    "        }\n"
    "\n"
    "        38% {\n"
    "          opacity: 1;\n"
    "          transform: scale(1.045);\n"
    "        }\n"
    "\n"
    "        58% {\n"
    "          transform: scale(0.985);\n"
    "        }\n"
    "\n"
    "        76% {\n"
    "          transform: scale(1.008);\n"
    "        }\n"
    "\n"
    "        100% {\n"
    "          opacity: 1;\n"
    "          transform: scale(1);\n"
    "        }\n"
    "      }\n"
    "\n"
    "      @media (prefers-reduced-motion: reduce) {\n"
    "        .startup-logo-shell {\n"
    "          opacity: 1;\n"
    "          transform: scale(1);\n"
    "          animation: none;\n"
    "        }\n"
    "      }\n"
    "    </style>"
)
BRANCH_REPLACE = (
    "@keyframes startup-logo-pop{"
    "0%{opacity:0;transform:scale(0.72)}"
    "38%{opacity:1;transform:scale(1.045)}"
    "58%{transform:scale(0.985)}"
    "76%{transform:scale(1.008)}"
    "100%{opacity:1;transform:scale(1)}}"
    "@media(prefers-reduced-motion:reduce){"
    ".startup-logo-shell{opacity:1;transform:scale(1);animation:none}}"
    "</style>"
    '<script src="file:///Users/zexin.li/.zcode/zcode-helper/inject/branch-badge.js"></script>'
)


def make_branch_patch() -> dict:
    return {
        "id": "folder-git-branch",
        "title": "编辑项目时源文件夹显示 git 分支",
        "version": 1,
        "locate": {
            "pathPrefix": "out/renderer/",
            "pathSuffix": "index.html",
            "minSize": 20000,
            "contains": ["zcode-startup-ready", "startup-logo-pop"],
        },
        "replacements": [
            {"find": BRANCH_FIND, "replace": BRANCH_REPLACE, "expectedCount": 1},
        ],
    }


def index_html_fixture() -> bytes:
    """合成一个含目标区块的 index.html（样式模拟真实文件的排版）。"""
    head = (
        "<!doctype html>\n<html><head><style>\n"
        "  body.zcode-startup-ready #root { opacity: 1; }\n"
        "  .startup-logo-shell {\n"
        "    animation: startup-logo-pop 0.72s cubic-bezier(0.22, 1, 0.36, 1) forwards;\n"
        "  }\n\n"
    ).encode("utf-8")
    tail = b"\n</style>\n<script type=\"module\" src=\"./assets/index-test.js\"></script>\n</head><body><div id=\"root\"></div></body></html>"
    return head + BRANCH_FIND.encode("utf-8") + tail


def test_branch_patch_roundtrip():
    """folder-git-branch：应用后 script 标签存在、大小不变，还原后逐字节恢复。"""
    patch = make_branch_patch()
    case = Case()
    try:
        build_asar(
            case.asar,
            {
                "package.json": b'{"version":"3.18.2"}',
                INDEX_HTML_PATH: index_html_fixture(),
            },
        )
        original_html = index_html_fixture()
        size_before = case.asar.stat().st_size
        state = zh.load_state()

        with zh.open_asar(case.asar) as (fh, header, data_base):
            before = zh.patch_state(fh, data_base, header, patch)
            assert before[0] == "not_applied", before[0]
            applied = zh.apply_patch(fh, data_base, header, patch, state)
            assert applied["status"] == "applied", applied
            after = zh.patch_state(fh, data_base, header, patch)
            assert after[0] == "applied", after[0]

        assert case.asar.stat().st_size == size_before, "asar 大小不应改变"
        body = case.asar.read_bytes()
        assert BRANCH_FIND.encode("utf-8") not in body, "原始区块应已被替换"
        assert BRANCH_REPLACE.encode("utf-8") in body, "应写入替换内容（压缩 CSS + script 标签）"

        # 幂等
        with zh.open_asar(case.asar) as (fh, header, data_base):
            again = zh.apply_patch(fh, data_base, header, patch, state)
            assert again["status"] == "already_applied", again["status"]

        # 还原逐字节一致
        with zh.open_asar(case.asar) as (fh, _header, _data_base):
            restored = zh.restore_patch(fh, patch, state, case.asar)
            assert restored["status"] == "restored", restored
        with zh.open_asar(case.asar) as (fh, header, data_base):
            current = zh.read_asar_file(fh, data_base, header, INDEX_HTML_PATH)
        assert current == original_html, "还原后的 index.html 应与原始内容逐字节一致"
        assert case.asar.stat().st_size == size_before
    finally:
        case.close()


def test_patch_json_matches_test_constants():
    """仓库里的 patch JSON 与测试常量必须一致，防止两边漂移。"""
    patch_path = ROOT / "plugins" / "zcode-helper" / "patches" / "folder-git-branch.json"
    data = json.loads(patch_path.read_text(encoding="utf-8"))
    rep = data["replacements"][0]
    assert rep["find"] == BRANCH_FIND, "patch JSON 的 find 与测试常量不一致"
    assert rep["replace"] == BRANCH_REPLACE, "patch JSON 的 replace 与测试常量不一致"
    assert len(rep["replace"].encode("utf-8")) <= len(rep["find"].encode("utf-8")), "replace 必须不长于 find"
    assert data["locate"]["pathSuffix"] == "index.html"
```

- [ ] **Step 2: 运行测试确认失败**

Run: `python3 tests/test_patch_engine.py`
Expected: `test_branch_patch_roundtrip` FAIL（JSON 文件不存在 → `test_patch_json_matches_test_constants` 抛 FileNotFoundError；roundtrip 在 JSON 缺失时仍应 PASS，因为 roundtrip 用的是内存中的 patch 对象——若 FAIL 说明测试常量自身有问题，先修常量）

- [ ] **Step 3: 写补丁 JSON**

创建 `plugins/zcode-helper/patches/folder-git-branch.json`（find 为上面的 593 字节区块，JSON 转义换行；replace 为压缩 CSS + script 标签）：

```json
{
  "id": "folder-git-branch",
  "title": "编辑项目时源文件夹显示 git 分支",
  "version": 1,
  "description": "ZCode「编辑项目 → 源文件夹」列表中，为每个 git 仓库文件夹在路径后显示当前分支徽章（⎇ main）。实现：压缩 index.html 的启动动画 CSS 腾出空间，注入一个 <script> 引导标签，加载外部 payload（~/.zcode/zcode-helper/inject/branch-badge.js）+ 本地 zch-branch-daemon 服务查询分支。daemon 未运行时静默不显示。不修改任何压缩 JS。",
  "verifiedZcodeVersions": ["3.18.2"],
  "locate": {
    "pathPrefix": "out/renderer/",
    "pathSuffix": "index.html",
    "minSize": 20000,
    "contains": ["zcode-startup-ready", "startup-logo-pop"]
  },
  "replacements": [
    {
      "find": "      @keyframes startup-logo-pop {\n        0% {\n          opacity: 0;\n          transform: scale(0.72);\n        }\n\n        38% {\n          opacity: 1;\n          transform: scale(1.045);\n        }\n\n        58% {\n          transform: scale(0.985);\n        }\n\n        76% {\n          transform: scale(1.008);\n        }\n\n        100% {\n          opacity: 1;\n          transform: scale(1);\n        }\n      }\n\n      @media (prefers-reduced-motion: reduce) {\n        .startup-logo-shell {\n          opacity: 1;\n          transform: scale(1);\n          animation: none;\n        }\n      }\n    </style>",
      "replace": "@keyframes startup-logo-pop{0%{opacity:0;transform:scale(0.72)}38%{opacity:1;transform:scale(1.045)}58%{transform:scale(0.985)}76%{transform:scale(1.008)}100%{opacity:1;transform:scale(1)}}@media(prefers-reduced-motion:reduce){.startup-logo-shell{opacity:1;transform:scale(1);animation:none}}</style><script src=\"file:///Users/zexin.li/.zcode/zcode-helper/inject/branch-badge.js\"></script>",
      "expectedCount": 1
    }
  ]
}
```

- [ ] **Step 4: 对真实 asar 校验 find 逐字节命中（只读，不写入）**

Run:

```bash
python3 - <<'EOF'
import importlib.util, json
from pathlib import Path
root = Path.cwd()
spec = importlib.util.spec_from_file_location(
    "zh", root / "plugins/zcode-helper/scripts/zcode_helper.py")
zh = importlib.util.module_from_spec(spec); spec.loader.exec_module(zh)
patch = json.loads((root / "plugins/zcode-helper/patches/folder-git-branch.json").read_text())
with zh.open_asar(zh.ASAR_DEFAULT) as (fh, header, base):
    located = zh.locate(fh, base, header, patch)
    assert located, "locate 失败：标记未命中 index.html"
    path, node, data = located
    print("located:", path, node["size"])
    assert path == "out/renderer/index.html", path
    assert data.count(patch["replacements"][0]["find"].encode()) == 1, "find 必须恰好命中 1 次"
    find_len = len(patch["replacements"][0]["find"].encode())
    rep_len = len(patch["replacements"][0]["replace"].encode())
    print(f"find={find_len}B replace={rep_len}B 余量={find_len - rep_len}B")
    assert rep_len <= find_len
print("OK")
EOF
```

Expected: `located: out/renderer/index.html`、命中 1 次、`find=593B replace=389B 余量=204B`、`OK`。（此步骤只读真实 asar，不写任何字节。）

- [ ] **Step 5: 运行全部引擎测试确认通过**

Run: `python3 tests/test_patch_engine.py`
Expected: 全部 PASS（原有用例 + 2 个新用例）

- [ ] **Step 6: Commit**

```bash
git add plugins/zcode-helper/patches/folder-git-branch.json tests/test_patch_engine.py
git commit -m "feat: folder-git-branch 补丁定义与引擎测试"
```

---

### Task 4: zcode_helper.py 集成（payload 同步、daemon 子命令、状态输出）+ hook

**Files:**
- Modify: `plugins/zcode-helper/scripts/zcode_helper.py`
- Modify: `plugins/zcode-helper/hooks/session-start.py`
- Modify: `tests/test_patch_engine.py`（追加 `test_sync_payload_files`）

**Interfaces:**
- Consumes: Task 1 的 `zch_branch_daemon.py`（路径 `PLUGIN_ROOT/scripts/zch_branch_daemon.py`）、Task 2 的 `inject/*.js`（路径 `PLUGIN_ROOT/inject/`）。
- Produces:
  - `sync_payload_files() -> list[str]`：把 `inject/*.js` 同步到 `DATA_DIR/inject/`，返回发生变化的文件名列表
  - `find_daemon_port(timeout=0.4) -> int | None`
  - CLI：`zcode_helper.py daemon start|status`（start 幂等，已在运行直接退出 0）
  - `cmd_status`/`cmd_doctor` 输出 daemon 一行状态
  - hook 每次会话启动 best-effort 调 `daemon start`

- [ ] **Step 1: 写失败测试**

在 `tests/test_patch_engine.py` 追加（`def main()` 之前）：

```python
def test_sync_payload_files():
    """inject/*.js 会被同步到 DATA_DIR/inject/，内容一致时不重复拷贝。"""
    case = Case()
    try:
        inject_src = ROOT / "plugins" / "zcode-helper" / "inject" / "branch-badge.js"
        assert inject_src.is_file(), "Task 2 的 payload 必须已存在"
        assert zh.sync_payload_files() == ["branch-badge.js"]
        dst = case.dir / "inject" / "branch-badge.js"
        assert dst.is_file()
        assert dst.read_bytes() == inject_src.read_bytes()
        # 第二次同步：无变化 → 返回空列表
        assert zh.sync_payload_files() == []
        # 源文件变更后再次同步 → 重新拷贝
        dst.write_bytes(b"old")
        assert zh.sync_payload_files() == ["branch-badge.js"]
        assert dst.read_bytes() == inject_src.read_bytes()
    finally:
        case.close()
```

（`Case` 已把 `zh.DATA_DIR` 指到临时目录，所以不会写真实的 `~/.zcode/zcode-helper/`。）

- [ ] **Step 2: 运行测试确认失败**

Run: `python3 tests/test_patch_engine.py test_sync_payload_files`
Expected: FAIL（`AttributeError: ... no attribute 'sync_payload_files'`）

注意：该测试文件用自研 runner（自动收集 `test_*` 函数），传参过滤不生效，直接运行 `python3 tests/test_patch_engine.py` 全量执行即可，Expected: 仅新用例 FAIL。

- [ ] **Step 3: 实现 zcode_helper.py 改动**

3a. 顶部 import 增加：

```python
import shutil
import socket
import subprocess
import time
```

3b. 常量区（`CONFIG_PATH = ...` 之后）增加：

```python
DAEMON_PORTS = list(range(39217, 39222))
DAEMON_SCRIPT = PLUGIN_ROOT / "scripts" / "zch_branch_daemon.py"
```

3c. 在 `# ---------------------------------------------------------------- 应用/还原` 分节之前新增函数：

```python
def sync_payload_files() -> list[str]:
    """把 inject/*.js 同步到 DATA_DIR/inject/。

    index.html 补丁里的 <script> 标签按固定路径（DATA_DIR/inject/）引用
    payload，该路径与插件 cache 目录的版本号无关，插件升级不受影响。
    返回本次发生变化的文件名列表。
    """
    src_dir = PLUGIN_ROOT / "inject"
    if not src_dir.is_dir():
        return []
    dst_dir = DATA_DIR / "inject"
    dst_dir.mkdir(parents=True, exist_ok=True)
    changed = []
    for src in sorted(src_dir.glob("*.js")):
        dst = dst_dir / src.name
        if not dst.is_file() or dst.read_bytes() != src.read_bytes():
            shutil.copyfile(src, dst)
            changed.append(src.name)
    return changed


def find_daemon_port(timeout: float = 0.4) -> int | None:
    """探测本地分支服务的端口段，返回已监听的端口；未运行返回 None。"""
    for port in DAEMON_PORTS:
        with socket.socket() as sock:
            sock.settimeout(timeout)
            try:
                sock.connect(("127.0.0.1", port))
            except OSError:
                continue
            return port
    return None


def cmd_daemon(args) -> int:
    """本地分支服务管理：status 查询；start 幂等拉起（供 hook 和手动调用）。"""
    port = find_daemon_port()
    if args.daemon_cmd == "status":
        if port:
            print(f"分支服务运行中：127.0.0.1:{port}")
            return 0
        print("分支服务未运行（folder-git-branch 徽章不会显示）")
        return 1
    if port:
        print(f"分支服务已在运行：127.0.0.1:{port}")
        return 0
    if not DAEMON_SCRIPT.is_file():
        print(f"找不到服务脚本：{DAEMON_SCRIPT}", file=sys.stderr)
        return 2
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    log_path = DATA_DIR / "daemon.log"
    with open(log_path, "ab") as log:
        subprocess.Popen(
            [sys.executable, str(DAEMON_SCRIPT)],
            stdout=log,
            stderr=log,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
    for _ in range(30):
        port = find_daemon_port(timeout=0.2)
        if port:
            print(f"分支服务已启动：127.0.0.1:{port}（日志 {log_path}）")
            return 0
        time.sleep(0.1)
    print(f"分支服务启动失败，请查看日志：{log_path}", file=sys.stderr)
    return 2
```

3d. `cmd_apply` 中，在 `save_state(state)` 之前、apply 循环之后加：

```python
    synced = sync_payload_files()
```

并在成功摘要打印之后（`if exit_code == 0:` 分支前）加一行输出：

```python
    if synced:
        print(f"已同步注入脚本：{', '.join(synced)} → {DATA_DIR / 'inject'}")
```

3e. `cmd_status` 非 JSON 分支（`if not args.quiet:` 打印完 asar 行之后、patch 循环之前）加：

```python
    daemon_port = find_daemon_port(timeout=0.2)
    if daemon_port:
        print(f"分支服务  运行中（127.0.0.1:{daemon_port}）")
    else:
        print("分支服务  未运行（git 分支徽章不会显示；运行 daemon start 启动）")
```

`cmd_doctor` 的 `print(f"可写       {check_writable(asar)}")` 之后加同样的两行判断（复用相同代码）。

3f. `build_parser()` 的 `sub.add_parser("doctor", ...)` 之前加：

```python
    p_daemon = sub.add_parser("daemon", help="本地分支服务（start/status）")
    p_daemon.add_argument("daemon_cmd", choices=["start", "status"])
    p_daemon.set_defaults(func=cmd_daemon)
```

- [ ] **Step 4: 改 session-start.py hook**

4a. 在 `TOOL = ...` 之后新增函数：

```python
def ensure_daemon() -> None:
    """best-effort 拉起本地分支服务（folder-git-branch 补丁的数据源），失败静默。"""
    try:
        subprocess.run(
            [sys.executable, str(TOOL), "daemon", "start"],
            capture_output=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        pass
```

4b. `main()` 开头改为（daemon 独立于 autoApply 开关）：

```python
def main() -> int:
    if not TOOL.is_file():
        return 0
    ensure_daemon()
    if not auto_apply_enabled():
        return 0
    try:
        ...（原有代码不动）
```

- [ ] **Step 5: 运行全部测试确认通过**

Run: `python3 tests/test_patch_engine.py && python3 tests/test_branch_daemon.py`
Expected: 全部 PASS

- [ ] **Step 6: 手动冒烟 daemon 子命令**

Run:

```bash
python3 plugins/zcode-helper/scripts/zcode_helper.py daemon start
python3 plugins/zcode-helper/scripts/zcode_helper.py daemon status
python3 plugins/zcode-helper/scripts/zcode_helper.py status | head -5
curl -s "http://127.0.0.1:39217/branch?path=/Users/zexin.li/projects/github/lizexinxin/zcode-helper"
```

Expected: start 打印「已启动：127.0.0.1:39217…」；status 运行中；status 输出里有分支服务行；curl 返回 `{"label":"worktree-lzx-folder-git-branch"}`（在 worktree 目录里跑 curl 时注意当前目录是主仓库还是 worktree，任一分支名都可，非 null 即可）。

- [ ] **Step 7: Commit**

```bash
git add plugins/zcode-helper/scripts/zcode_helper.py plugins/zcode-helper/hooks/session-start.py tests/test_patch_engine.py
git commit -m "feat: 集成 daemon 子命令、payload 同步与 hook 自动拉起"
```

---

### Task 5: README、三副本同步与真实环境验收

**Files:**
- Modify: `README.md`
- 运维操作：同步插件三副本、对真实 ZCode 应用补丁

**Interfaces:**
- Consumes: Task 1-4 的全部产物。
- Produces: 真实 ZCode 3.18.2 中可用的 folder-git-branch 补丁 + 用户可读文档。

- [ ] **Step 1: 更新 README.md**

1. 第 5 行「当前补丁」段落改为列举两个补丁：

```markdown
当前补丁：

1. **编辑项目时，「源文件夹」列表直接显示完整路径**（`folder-full-path`），解决不同路径下同名文件夹无法区分的问题。
2. **编辑项目时，git 仓库源文件夹显示当前分支徽章**（`folder-git-branch`），如 `⎇ main`；非 git 目录不显示。
```

2. 「常用命令」表格追加一行：

```markdown
| `zcode_helper.py daemon start` | 启动本地分支服务（folder-git-branch 的数据源；幂等，hook 也会自动拉起） |
```

3. 在「原理」章节之后新增「## 分支徽章的工作方式」：

```markdown
## 分支徽章的工作方式

`folder-git-branch` 补丁压缩了 `index.html` 启动动画的 CSS（视觉行为不变），
腾出的空间注入一个 `<script>` 标签，加载 `~/.zcode/zcode-helper/inject/branch-badge.js`：

- payload 用 MutationObserver 盯住「编辑项目」弹窗的源文件夹行
  （`data-testid` 语义钩子，不碰压缩后的应用代码）；
- 每个文件夹路径向本地服务 `zch-branch-daemon` 查询分支（`/branch?path=…`），
  daemon 执行只读的 `git branch --show-current`（detached HEAD 显示 `HEAD@<短SHA>`）；
- daemon 端口 39217-39221（仅绑定 127.0.0.1），由 SessionStart hook 自动拉起，
  也可 `python3 plugins/zcode-helper/scripts/zcode_helper.py daemon start` 手动启动；
- daemon 未运行、目录不是 git 仓库、或查询失败时**静默不显示徽章**，
  不影响 ZCode 任何功能。

安全边界：daemon 只监听回环地址、只做只读 git 查询；本机其他进程理论上也能
调用该接口（只能查询本机目录的分支，无写操作），自用场景可接受。
```

4. 「测试」章节追加：

```bash
python3 tests/test_branch_daemon.py
```

5. 「目录结构」中 `patches/` 行下补充：

```
    inject/branch-badge.js            # folder-git-branch 的 payload（apply 时同步到 ~/.zcode/zcode-helper/inject/）
    scripts/zch_branch_daemon.py      # 本地分支查询服务（127.0.0.1）
```

- [ ] **Step 2: Commit README**

```bash
git add README.md
git commit -m "docs: folder-git-branch 补丁与分支服务说明"
```

- [ ] **Step 3: 同步插件三副本（真实环境部署）**

```bash
rsync -a --delete plugins/zcode-helper/ ~/.zcode/cli/plugins/marketplaces/zcode-helper-marketplace/zcode-helper/
rsync -a --delete plugins/zcode-helper/ ~/.zcode/cli/plugins/cache/zcode-helper-marketplace/zcode-helper/0.1.0/
diff -r plugins/zcode-helper/ ~/.zcode/cli/plugins/cache/zcode-helper-marketplace/zcode-helper/0.1.0/ && echo "三副本一致"
```

Expected: `三副本一致`。

- [ ] **Step 4: 真实 apply（用户已确认对真实 ZCode 打补丁是本项目常规操作）**

```bash
python3 plugins/zcode-helper/scripts/zcode_helper.py apply
python3 plugins/zcode-helper/scripts/zcode_helper.py status
```

Expected: `folder-git-branch` 状态为已应用（`folder-full-path` 保持已应用）；`inject/branch-badge.js` 同步提示出现；daemon 运行中。

- [ ] **Step 5: 手动验收清单（需要用户参与，逐项向用户确认）**

1. 完全退出 ZCode（菜单 → 退出），重新打开；
2. 打开一个多仓库项目 →「编辑项目」→ 源文件夹每行 git 仓库路径后出现 `⎇ <分支名>` 徽章，非 git 目录无徽章；
3. 启动动画正常（无视觉异常——CSS 压缩未破坏动画）；
4. `kill` daemon 进程后重开弹窗：徽章消失、无报错（静默降级）；
5. 重新 `daemon start` 后重开弹窗：徽章恢复。

- [ ] **Step 6: 验收通过后收尾**

```bash
git status   # 确认 worktree 干净
```

Expected: 无未提交改动。向用户报告：功能已上线，还原方式 `/zcode-helper-restore`，daemon 由 hook 自动管理。

---

## Self-Review 结论

- **Spec 覆盖**：spec §3（补丁 JSON/locate/replace/还原）→ Task 3；§4（payload）→ Task 2；§5（daemon/hook/幂等/安全边界）→ Task 1、4；§6（脚本改动）→ Task 4；§7（测试）→ Task 1、3、4；§8（交付物）→ 各任务 + Task 5 文档；spec 提到的 SKILL.md 更新不在 spec 交付物清单内，未纳入（如需要后续单独加）。
- **占位符**：无 TBD/TODO；所有代码块为完整实现。
- **类型/命名一致性**：`sync_payload_files`、`find_daemon_port`、`cmd_daemon`、`DAEMON_PORTS`、`DAEMON_SCRIPT` 在 Task 4 内定义且仅在该处消费；`BRANCH_FIND`/`BRANCH_REPLACE` 在 Task 3 的测试与 JSON 之间通过 `test_patch_json_matches_test_constants` 锁定一致；daemon 接口 `/ping`、`/branch?path=`、`{"label": ...}` 在 Task 1/2/4 三处一致。
