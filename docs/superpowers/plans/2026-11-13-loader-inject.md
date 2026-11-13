# 主进程 loader 运行时注入 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把两个 UI 插件从"等长替换 app.asar 字节"迁移到"主进程 loader + 渲染层注入模块"架构，使插件市场开关拨动后运行中即时生效（零重启）。

**Architecture:** 一次性向 `out/main/index.js` 追加一行 dynamic `import()` 指针（整包重打包 asar，需重启一次），指针指向磁盘上的常驻 loader.cjs；loader 监听 `~/.zcode/cli/config.json` 的 `enabledPlugins`，通过 `webContents.executeJavaScript` 注入/拆除渲染模块（folder-full-path 纯 CSS、branch-badge 徽章 DOM）。

**Tech Stack:** Python 标准库（asar 解析/重打包）、Electron 主进程 CommonJS（loader）、原生 JS 渲染模块、pytest + node:test。

**Spec:** `docs/superpowers/specs/2026-11-13-loader-inject-design.md`

## Global Constraints

- 在 worktree `worktree-lzx-loader-inject` 内开发（基准 main）。
- 引擎真源在 `shared/`，插件目录为副本；每次改真源必须 `cp` 同步副本，`tests/test_engine_sync.py` 把关。
- Python 只用标准库；JS 只用 node 内置模块与浏览器 API，不引入任何依赖。
- 注释、文档、提交信息一律中文（沿用现有风格：`feat:` / `fix:` / `test:` / `docs:` 前缀 + 中文描述）。
- 真机（`/Applications/ZCode.app/Contents/Resources/app.asar`）只允许在 Task 7 验收阶段触碰；Task 1-6 的测试全部走合成 asar / 临时目录。fuse（`EnableEmbeddedAsarIntegrityValidation`）已验证为关闭。
- loader 常量：`LOADER_HOME = ~/.zcode/zcode-helper`、`MAIN_ENTRY = "out/main/index.js"`、asar 路径 `/Applications/ZCode.app/Contents/Resources/app.asar`（引擎已有常量的沿用现状）。
- 模块协议（所有任务共同遵守）：
  - 模块文件在 IIFE 内注册 `window.__zchModules["<id>"] = { install, dispose }`；
  - `install`/`dispose` 幂等，返回 `"ok"` 或 `"already"`；
  - 模块注入的 DOM 元素带 `data-zch-module="<id>"` 属性，style 标签 id 为 `zch-<id>-style`；
  - loader 以字符串拼接方式执行模块：`window.__zchModules=window.__zchModules||{};(function(){<模块代码>}());` 然后调用对应模块的 install/dispose。

---

### Task 1: asar 整包重打包核心

**Files:**
- Modify: `shared/zcode_helper.py`（顶部 import 区、常量区、`read_header` 附近新增函数）
- Test: `tests/test_asar_repack.py`（新建）

**Interfaces:**
- Consumes: 引擎现有 `read_header(fh) -> (header: dict, data_base: int)`、`iter_files(header) -> list[(path, node)]`、`read_node(fh, data_base, node) -> bytes`。
- Produces（Task 2 依赖）:
  - `asar_integrity(data: bytes, block_size: int = 4194304) -> dict`
  - `build_header(files: dict[str, bytes]) -> dict`
  - `write_asar(path: Path, files: dict[str, bytes]) -> None`
  - `repack_asar(asar: Path, edits: dict[str, bytes]) -> None`
  - 常量 `LOADER_HOME: Path`、`MAIN_ENTRY = "out/main/index.js"`、`LOADER_IMPORT_MARK = "__zch_loader__"`（出现在 import 行注释中，用于幂等判断）

- [ ] **Step 1: 写失败测试**（新建 `tests/test_asar_repack.py`，import 方式沿用 `test_patch_engine.py` 的 `importlib.util.spec_from_file_location` 加载 `plugins/zcode-branch-badge/scripts/zcode_helper.py`）：

```python
def make_files() -> dict[str, bytes]:
    """合成 asar 的文件集：含目录结构，内容各异。"""
    index = b"console.log('main');\n"
    return {
        "package.json": b'{"name":"app","main":"out/main/index.js"}',
        "out/main/index.js": index,
        "out/renderer/index.html": b"<html><body>hi</body></html>",
        "out/renderer/assets/a.js": b"var a=1;",
    }

def test_write_then_read_roundtrip():
    with tempfile.TemporaryDirectory() as td:
        asar = Path(td) / "app.asar"
        files = make_files()
        zh.write_asar(asar, files)
        with asar.open("rb") as fh:
            header, data_base = zh.read_header(fh)
            got = {p: zh.read_node(fh, data_base, n) for p, n in zh.iter_files(header)}
        assert got == files

def test_repack_edits_content_and_offsets():
    with tempfile.TemporaryDirectory() as td:
        asar = Path(td) / "app.asar"
        files = make_files()
        zh.write_asar(asar, files)
        new_index = files["out/main/index.js"] + b'import("/x/loader.cjs");\n'
        zh.repack_asar(asar, {"out/main/index.js": new_index})
        with asar.open("rb") as fh:
            header, data_base = zh.read_header(fh)
            got = {p: zh.read_node(fh, data_base, n) for p, n in zh.iter_files(header)}
        assert got["out/main/index.js"] == new_index
        # 其余文件字节不变
        for p in files:
            if p != "out/main/index.js":
                assert got[p] == files[p]

def test_repack_no_edit_is_noop():
    with tempfile.TemporaryDirectory() as td:
        asar = Path(td) / "app.asar"
        zh.write_asar(asar, make_files())
        zh.repack_asar(asar, {})
        with asar.open("rb") as fh:
            header, data_base = zh.read_header(fh)
            got = {p: zh.read_node(fh, data_base, n) for p, n in zh.iter_files(header)}
        assert got == make_files()

def test_integrity_shape():
    i = zh.asar_integrity(b"x" * (4194304 + 10))
    assert i["algorithm"] == "SHA256"
    assert len(i["blocks"]) == 2
    assert i["hash"] == hashlib.sha256(b"x" * (4194304 + 10)).hexdigest()
```

另加一个真实 asar 的只读往返测试（本地有 ZCode 才跑，慢测试）：

```python
REAL_ASAR = Path("/Applications/ZCode.app/Contents/Resources/app.asar")

@pytest.mark.skipif(not REAL_ASAR.is_file(), reason="本机无 ZCode")
def test_repack_real_asar_roundtrip(tmp_path):
    """只读复制真实 asar → 空编辑重打包 → 逐文件字节比对。"""
    copy = tmp_path / "app.asar"
    shutil.copyfile(REAL_ASAR, copy)
    with copy.open("rb") as fh:
        h0, db0 = zh.read_header(fh)
        before = {p: zh.read_node(fh, db0, n) for p, n in zh.iter_files(h0)}
    zh.repack_asar(copy, {})
    with copy.open("rb") as fh:
        h1, db1 = zh.read_header(fh)
        after = {p: zh.read_node(fh, db1, n) for p, n in zh.iter_files(h1)}
    assert set(after) == set(before)
    for p in before:
        assert after[p] == before[p], p
```

- [ ] **Step 2: 跑测试确认失败**：`python3 tests/test_asar_repack.py`（或 `pytest tests/test_asar_repack.py -v`），预期 `AttributeError: ... has no attribute 'write_asar'`。

- [ ] **Step 3: 实现**（`shared/zcode_helper.py`；`read_header`/`iter_files`/`read_node` 已存在，直接复用）：

```python
import hashlib
import tempfile

LOADER_HOME = Path.home() / ".zcode" / "zcode-helper"
MAIN_ENTRY = "out/main/index.js"
LOADER_IMPORT_MARK = "__zch_loader__"

def asar_integrity(data: bytes, block_size: int = 4194304) -> dict:
    """Electron asar per-file integrity 块：整文件 hash + 4MB 分块 hash。"""
    blocks = [
        hashlib.sha256(data[i : i + block_size]).hexdigest()
        for i in range(0, len(data), block_size)
    ]
    return {
        "algorithm": "SHA256",
        "hash": hashlib.sha256(data).hexdigest(),
        "blockSize": block_size,
        "blocks": blocks,
    }

def build_header(files: dict[str, bytes]) -> dict:
    """按路径排序依次分配 offset，构建 asar header（叶子节点含 integrity）。"""
    root: dict = {"files": {}}
    offset = 0
    for path in sorted(files):
        parts = path.split("/")
        node = root["files"]
        for part in parts[:-1]:
            node = node.setdefault(part, {"files": {}})["files"]
        data = files[path]
        node[parts[-1]] = {
            "size": len(data),
            "offset": str(offset),
            "integrity": asar_integrity(data),
        }
        offset += len(data)
    return root

def write_asar(path: Path, files: dict[str, bytes]) -> None:
    """从头写一个 asar（测试用）；header 布局与 read_header 严格对齐。"""
    payload = json.dumps(build_header(files), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    padding = b" " * ((-len(payload)) % 4)
    json_size = len(payload)
    header_object_size = 4 + json_size + len(padding)
    pickle_size = 8 + header_object_size
    with path.open("wb") as fh:
        fh.write(struct.pack("<4I", 4, pickle_size, header_object_size, json_size))
        fh.write(payload)
        fh.write(padding)
        for p in sorted(files):
            fh.write(files[p])

def repack_asar(asar: Path, edits: dict[str, bytes]) -> None:
    """整包重打包：edits 为 {asar 内路径: 新内容}，空 edits 等价于原样重写。

    原子替换：先写 <asar>.tmp 再 os.replace。
    """
    with asar.open("rb") as fh:
        header, data_base = read_header(fh)
        files = {p: read_node(fh, data_base, n) for p, n in iter_files(header)}
    files.update(edits)
    tmp = asar.parent / (asar.name + ".zch-repack.tmp")
    write_asar(tmp, files)
    os.replace(tmp, asar)
```

注意：`read_header` 现返回 `data_base = 8 + pickle_size`；`write_asar` 的公式（`pickle_size = 8 + header_object_size`、`header_object_size = 4 + json_size + padding`）保证 `data_base` 恰好落在补齐后的 JSON 之后。若 Step 2/4 测试证明公式与 `read_header` 不符，以真实 asar 往返测试为准修正 `write_asar`，**不得改动 `read_header`**。

- [ ] **Step 4: 跑测试确认通过**：全部 PASS，含真实 asar 往返（首次在真机上验证公式，只读不写真实文件）。

- [ ] **Step 5: 提交**：
```bash
git add shared/zcode_helper.py tests/test_asar_repack.py
git commit -m "feat: 引擎新增 asar 整包重打包核心（loader 装卸的基础）"
```

### Task 2: loader CLI 命令（install/remove/status + 资产同步）

**Files:**
- Modify: `shared/zcode_helper.py`（`cmd_daemon` 附近新增 `cmd_loader`；`main()` 的 argparse 注册）
- Test: `tests/test_loader_commands.py`（新建）

**Interfaces:**
- Consumes: Task 1 的 `repack_asar`、`LOADER_HOME`、`MAIN_ENTRY`、`LOADER_IMPORT_MARK`；引擎现有全局 `--json` 输出方式（照 `cmd_auto` 的 JSON 行输出模式）。
- Produces（Task 5 的 hook 依赖）:
  - `python3 zcode_helper.py [--json] loader install [--quiet]` → 拷贝资产到 `LOADER_HOME`（`loader.cjs`、`modules/*.js`，源为 `PLUGIN_ROOT/loader/`），asar 未装指针则追加并重打包；JSON 行 `{"action": "installed"|"already"|"error", ...}`
  - `python3 zcode_helper.py [--json] loader remove` → 剥离指针行并重打包；`{"action": "removed"|"not_installed"|"error"}`
  - `python3 zcode_helper.py [--json] loader status` → `{"installed": bool, "loaderFile": bool, "modules": [...]}`
  - 指针行常量：`LOADER_IMPORT_LINE = '\nimport("<LOADER_HOME>/loader.cjs").then(function(m){return m.activate();}).catch(function(e){console.error("[zch-loader]", e);});\n'`

- [ ] **Step 1: 写失败测试**（合成 asar 上跑，绝不碰真实 asar；`cmd_loader` 需支持注入 asar 路径，新增模块级 `ASAR_PATH` 变量并由 `--asar` 全局参数覆盖，测试直接改 `zh.ASAR_PATH`）：

```python
PLUGIN_ROOT = ROOT / "plugins" / "zcode-branch-badge"  # 测试前先创建其 loader/ 资产占位（Step 3 会真正提交资产文件；本测试在资产缺失时跳过资产断言部分）

def test_install_appends_pointer_and_idempotent(tmp_path):
    asar = tmp_path / "app.asar"
    files = make_files()  # 沿用 test_asar_repack 的构造，或内联同样构造
    zh.write_asar(asar, files)
    zh.ASAR_PATH = asar
    # 资产同步目标改到临时目录
    zh.LOADER_HOME = tmp_path / "loaderhome"
    # 造最小资产
    (PLUGIN_ROOT / "loader" / "modules").mkdir(parents=True, exist_ok=True)
    (PLUGIN_ROOT / "loader" / "loader.cjs").write_text("// loader\n", encoding="utf-8")
    rc, out = run_tool(["--json", "loader", "install", "--quiet"])  # subprocess 方式或直调 cmd_loader
    assert '"action": "installed"' in out or '"action":"installed"' in out
    with asar.open("rb") as fh:
        header, db = zh.read_header(fh)
        idx = zh.read_asar_file(fh, db, header, zh.MAIN_ENTRY)
    assert zh.LOADER_IMPORT_MARK.encode() in idx
    # 幂等：再装一次
    rc2, out2 = run_tool(["--json", "loader", "install", "--quiet"])
    assert '"already"' in out2.replace(" ", "") or "already" in out2
    with asar.open("rb") as fh:
        header, db = zh.read_header(fh)
        idx2 = zh.read_asar_file(fh, db, header, zh.MAIN_ENTRY)
    assert idx2.count(zh.LOADER_IMPORT_MARK.encode()) == 1

def test_remove_strips_pointer(tmp_path):
    # 先 install 再 remove，指针行应消失，其余文件字节不变
    ...
```

（`run_tool` 为测试内 helper：`subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True)`；`LOADER_HOME` 环境隔离通过 `--data-dir` 全局参数传 `tmp_path`。）

- [ ] **Step 2: 跑测试确认失败**：预期 `loader` 子命令不存在（argparse 报错）。

- [ ] **Step 3: 实现 `cmd_loader`**（要点，完整照此写）：

```python
def loader_import_line() -> str:
    return (
        '\nimport("' + str(LOADER_HOME / "loader.cjs") + '")'
        '.then(function(m){return m.activate();})'
        '.catch(function(e){console.error("[zch-loader]", e);});\n'
    )

def sync_loader_assets() -> list[str]:
    """PLUGIN_ROOT/loader/{loader.cjs,modules/*.js} → LOADER_HOME。"""
    copied = []
    src_loader = PLUGIN_ROOT / "loader" / "loader.cjs"
    if src_loader.is_file():
        LOADER_HOME.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src_loader, LOADER_HOME / "loader.cjs")
        copied.append("loader.cjs")
    src_modules = PLUGIN_ROOT / "loader" / "modules"
    if src_modules.is_dir():
        dst = LOADER_HOME / "modules"
        dst.mkdir(parents=True, exist_ok=True)
        for js in src_modules.glob("*.js"):
            shutil.copyfile(js, dst / js.name)
            copied.append("modules/" + js.name)
    return copied

def cmd_loader(args) -> int:
    action = args.loader_action
    with open_asar() as pair:            # 引擎现有 asar 上下文管理器
        fh, header, data_base = pair
        index = read_asar_file(fh, data_base, header, MAIN_ENTRY) or b""
    line = loader_import_line().encode()
    if action == "install":
        synced = sync_loader_assets()
        if zh.LOADER_IMPORT_MARK.encode() in index:
            result = {"action": "already", "synced": synced}
        else:
            repack_asar(ASAR_PATH, {MAIN_ENTRY: index + line})
            result = {"action": "installed", "synced": synced}
        if not getattr(args, "quiet", False):
            if result["action"] == "installed":
                print("✓ loader 指针已写入。请完全退出 ZCode 后重新打开一次（这是最后一次因安装而重启）。")
            else:
                print("· loader 已在位，无需重装。")
    elif action == "remove":
        if zh.LOADER_IMPORT_MARK.encode() not in index:
            result = {"action": "not_installed"}
        else:
            repack_asar(ASAR_PATH, {MAIN_ENTRY: index.replace(line, b"")})
            result = {"action": "removed"}
        print("✓ loader 指针已剥离。请完全退出 ZCode 后重新打开。")
    else:  # status
        loader_file = (LOADER_HOME / "loader.cjs").is_file()
        mods = sorted(p.name for p in (LOADER_HOME / "modules").glob("*.js")) if (LOADER_HOME / "modules").is_dir() else []
        result = {"installed": zh.LOADER_IMPORT_MARK.encode() in index, "loaderFile": loader_file, "modules": mods}
    if getattr(args, "json", False):
        print(json.dumps(result, ensure_ascii=False))
    return 0
```

argparse 注册（`main()` 内，紧挨 `daemon` 的注册方式，`daemon` 仅当脚本携带 daemon 脚本时注册——`loader` 两个插件都要注册，无此条件）：

```python
p_loader = sub.add_parser("loader", help="主进程 loader 装卸（install/remove/status）")
p_loader_sub = p_loader.add_subparsers(dest="loader_action", required=True)
for name in ("install", "remove", "status"):
    sp = p_loader_sub.add_parser(name)
    if name == "install":
        sp.add_argument("--quiet", action="store_true")
    sp.set_defaults(func=cmd_loader, loader_action=name)
```

- [ ] **Step 4: 跑测试确认通过**。

- [ ] **Step 5: 提交**：
```bash
git add shared/zcode_helper.py tests/test_loader_commands.py plugins/zcode-branch-badge/scripts/zcode_helper.py
git commit -m "feat: 引擎新增 loader install/remove/status 命令"
```

### Task 3: 主进程 loader.cjs

**Files:**
- Create: `shared/loader.cjs`（真源）
- Copy: `plugins/zcode-branch-badge/loader/loader.cjs`、`plugins/zcode-folder-full-path/loader/loader.cjs`（副本，Task 5 同步测试把关）
- Test: `tests/test_loader.cjs`（新建，node 内置 test runner）

**Interfaces:**
- Consumes: 模块协议（见 Global Constraints）；模块文件位于 `LOADER_HOME/modules/<id>.js`；配置 `~/.zcode/cli/config.json` → `plugins.enabledPlugins`。
- Produces（Task 4/5 依赖）:
  - `module.exports = { activate, enabledModules, MODULE_IDS }`；`activate()` 在主进程启动监听与注入，幂等（重复调用直接返回）。
  - 插件 id → 模块映射：`"zcode-<name>@<market>"` 且 enabled → 模块 `<name>`；`MODULE_IDS = ["folder-full-path", "branch-badge"]`。
  - 注入代码串（渲染层收到后依次执行）：`window.__zchModules=window.__zchModules||{};(function(){<模块文件内容>}());var m=window.__zchModules["<id>"];return m?(<install/dispose 调用>):"missing";`

- [ ] **Step 1: 写失败测试** `tests/test_loader.cjs`：

```js
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const loader = require(path.join(__dirname, "..", "shared", "loader.cjs"));

test("enabledModules 按插件前缀映射且忽略禁用项", () => {
  const cfg = { plugins: { enabledPlugins: {
    "zcode-folder-full-path@mp": true,
    "zcode-branch-badge@mp": false,
    "superpowers@claude-plugins-official": true,
  } } };
  assert.deepStrictEqual(loader.enabledModules(cfg), ["folder-full-path"]);
});

test("enabledModules 兼容空配置", () => {
  assert.deepStrictEqual(loader.enabledModules({}), []);
  assert.deepStrictEqual(loader.enabledModules(null), []);
});
```

运行：`node --test tests/test_loader.cjs`。预期 FAIL（`enabledModules` 未导出）。

- [ ] **Step 2: 实现** `shared/loader.cjs`（完整代码）：

```js
/* zch-loader：ZCode 主进程常驻 loader。
 * 由 out/main/index.js 尾部的 dynamic import() 指针加载（见引擎 loader install）。
 * 职责：监听插件开关（~/.zcode/cli/config.json 的 enabledPlugins），
 * 用 webContents.executeJavaScript 向渲染进程注入/拆除 UI 模块（LOADER_HOME/modules/*.js）。
 * 任何异常只写日志，绝不抛向主进程。 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const HOME_DIR = path.join(os.homedir(), ".zcode", "zcode-helper");
const MODULES_DIR = path.join(HOME_DIR, "modules");
const CONFIG_PATH = path.join(os.homedir(), ".zcode", "cli", "config.json");
const LOG_PATH = path.join(HOME_DIR, "loader.log");

const MODULE_IDS = ["folder-full-path", "branch-badge"];
const PLUGIN_PREFIX = "zcode-";
const DEBOUNCE_MS = 300;

let activated = false;
let currentEnabled = [];
let watchTimer = null;

function log(msg) {
  try {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    fs.appendFileSync(LOG_PATH, new Date().toISOString() + " " + msg + "\n");
  } catch (_) { /* 日志失败忽略 */ }
}

function enabledModules(configData) {
  const ep = (configData && configData.plugins && configData.plugins.enabledPlugins) || {};
  const on = new Set();
  for (const [id, enabled] of Object.entries(ep || {})) {
    if (!enabled) continue;
    const name = id.split("@")[0];
    if (name.startsWith(PLUGIN_PREFIX)) on.add(name.slice(PLUGIN_PREFIX.length));
  }
  return MODULE_IDS.filter((m) => on.has(m));
}

function readEnabled() {
  try {
    return enabledModules(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")));
  } catch (exc) {
    log("readEnabled 失败: " + (exc && exc.message));
    return [];
  }
}

function runnerFor(id, on) {
  const file = path.join(MODULES_DIR, id + ".js");
  let code;
  try {
    code = fs.readFileSync(file, "utf8");
  } catch (exc) {
    log("读取模块 " + id + " 失败: " + (exc && exc.message));
    return 'return "missing-file";';
  }
  const call = on ? 'm.install()||"ok"' : 'm.dispose()||"ok"';
  return (
    'window.__zchModules=window.__zchModules||{};(function(){' + code + '}());' +
    'var m=window.__zchModules[' + JSON.stringify(id) + '];' +
    'return m?(' + call + '):"missing";'
  );
}

function applyToContents(wc, enabled) {
  if (!wc || wc.isDestroyed()) return;
  let type = "";
  try { type = wc.getType(); } catch (_) { return; }
  if (type !== "window") return; // 只注主窗口类页面
  for (const id of MODULE_IDS) {
    const want = enabled.includes(id);
    wc.executeJavaScript(runnerFor(id, want), true)
      .catch((exc) => log("注入 " + id + "(" + want + ") 失败: " + (exc && exc.message)));
  }
}

function applyAll(enabled) {
  try {
    const { webContents } = require("electron");
    for (const wc of webContents.getAllWebContents()) applyToContents(wc, enabled);
  } catch (exc) {
    log("applyAll 失败: " + (exc && exc.message));
  }
}

function watchConfig() {
  try {
    fs.watch(CONFIG_PATH, () => {
      if (watchTimer) clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        const next = readEnabled();
        const changed = MODULE_IDS.filter((id) =>
          currentEnabled.includes(id) !== next.includes(id));
        currentEnabled = next;
        for (const id of changed) {
          log("开关变化: " + id + " → " + (next.includes(id) ? "on" : "off"));
          applyAll(next); // 只对 changed 模块注入亦可；全量注入靠模块幂等，简单可靠
        }
      }, DEBOUNCE_MS);
    });
  } catch (exc) {
    log("fs.watch 失败: " + (exc && exc.message));
  }
}

function activate() {
  if (activated) return "already";
  activated = true;
  currentEnabled = readEnabled();
  log("激活，已启用模块: " + JSON.stringify(currentEnabled));
  try {
    const { app, webContents } = require("electron");
    app.on("web-contents-created", (_e, wc) => {
      wc.on("did-finish-load", () => {
        // 页面刷新/新窗口后重放；模块自身幂等
        setTimeout(() => applyToContents(wc, currentEnabled), 300);
      });
    });
    // 兜底：loader 晚于窗口创建时，先给现有窗口补一轮
    for (const wc of webContents.getAllWebContents()) {
      try { wc.on("did-finish-load", () => setTimeout(() => applyToContents(wc, currentEnabled), 300)); } catch (_) {}
    }
    applyAll(currentEnabled);
    watchConfig();
  } catch (exc) {
    log("activate 失败: " + (exc && exc.message));
  }
  return "ok";
}

module.exports = { activate, enabledModules, MODULE_IDS };

/* 便于独立自检：node shared/loader.cjs 打印当前启用模块 */
if (require.main === module) {
  console.log(JSON.stringify({ enabled: readEnabled(), modulesDir: MODULES_DIR }));
}
```

- [ ] **Step 3: 跑 `node --test tests/test_loader.cjs`** 预期 PASS；另跑 `node shared/loader.cjs` 确认自检输出合法 JSON 且不报错（此刻 `LOADER_HOME/modules` 可能不存在，`readEnabled` 只读 config，不影响）。

- [ ] **Step 4: 拷贝副本**：`mkdir -p plugins/zcode-branch-badge/loader plugins/zcode-folder-full-path/loader && cp shared/loader.cjs plugins/zcode-branch-badge/loader/loader.cjs && cp shared/loader.cjs plugins/zcode-folder-full-path/loader/loader.cjs`。

- [ ] **Step 5: 提交**：
```bash
git add shared/loader.cjs plugins/zcode-branch-badge/loader/loader.cjs plugins/zcode-folder-full-path/loader/loader.cjs tests/test_loader.cjs
git commit -m "feat: 主进程 loader.cjs——监听插件开关并即时注入/拆除渲染模块"
```

### Task 4: 渲染模块 folder-full-path.js 与 branch-badge.js

**Files:**
- Create: `shared/modules/folder-full-path.js`、`shared/modules/branch-badge.js`
- Copy: `plugins/zcode-branch-badge/loader/modules/{folder-full-path.js,branch-badge.js}`、`plugins/zcode-folder-full-path/loader/modules/{...}`（副本）
- Test: `tests/test_modules.cjs`（新建）

**Interfaces:**
- Consumes: 模块协议（Global Constraints）；branch-badge 的分支数据来自 daemon HTTP（`127.0.0.1:39217-39221`，`/branch?path=...`），现有 `inject/branch-badge.js` 逻辑为改造基础。
- Produces（Task 3 loader 按文件名加载）: 模块 id 分别为 `"folder-full-path"`、`"branch-badge"`；文件名 `<id>.js`。

- [ ] **Step 1: 写失败测试** `tests/test_modules.cjs`（最小 DOM stub，验证两模块注册、install 幂等、dispose 拆干净）：

```js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function makeDom() {
  const elements = [];
  const dom = {
    head: { children: [], appendChild(el) { elements.push(el); } },
    documentElement: { isConnected: true },
    elements,
  };
  dom.document = {
    readyState: "complete",
    head: dom.head,
    documentElement: dom.documentElement,
    getElementById(id) { return elements.find((e) => e.id === id) || null; },
    createElement(tag) {
      return { tag, id: "", textContent: "", style: { cssText: "" }, attrs: {}, children: [],
        setAttribute(k, v) { this.attrs[k] = v; },
        getAttribute(k) { return this.attrs[k]; },
        remove() { const i = elements.indexOf(this); if (i >= 0) elements.splice(i, 1); } };
    },
    appendChild(el) { elements.push(el); },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
  dom.window = {
    MutationObserver: class { observe() {} disconnect() {} },
    fetch() { return new Promise(() => {}); }, // 永挂起即可
    __zchModules: {},
  };
  return dom;
}

function runModule(id) {
  const dom = makeDom();
  const code = fs.readFileSync(path.join(__dirname, "..", "shared", "modules", id + ".js"), "utf8");
  const wrapped = "window.__zchModules=window.__zchModules||{};(function(){" + code + "}());";
  vm.runInNewContext(wrapped, { window: dom.window, document: dom.document, Element: class {}, setTimeout, clearTimeout, Date, Promise, Map });
  return dom.window.__zchModules[id];
}

test("两模块都按协议注册且 install/dispose 幂等", () => {
  for (const id of ["folder-full-path", "branch-badge"]) {
    const m = runModule(id);
    assert.ok(m && typeof m.install === "function" && typeof m.dispose === "function", id);
    assert.strictEqual(m.install(), "ok");
    assert.strictEqual(m.install(), "ok"); // 幂等
    assert.strictEqual(m.dispose(), "ok");
    assert.strictEqual(m.dispose(), "ok"); // dispose 幂等
  }
});

test("folder-full-path install 插 style、dispose 移除", () => {
  const m = runModule("folder-full-path");
  const dom = null; // 通过全局 stub 的 elements 断言，见下
  assert.strictEqual(m.install(), "ok");
  assert.strictEqual(m.dispose(), "ok");
});
```

说明：stub 的 `document.getElementById` 从 `elements` 查找，能覆盖 style 幂等路径；徽章模块在 stub 下 install 不应抛异常（无匹配行时无 DOM 操作）。

- [ ] **Step 2: 跑 `node --test tests/test_modules.cjs`** 预期 FAIL（文件不存在）。

- [ ] **Step 3: 实现** `shared/modules/folder-full-path.js`（完整代码）：

```js
/* zcode 模块：编辑项目源文件夹显示完整路径（纯 CSS，install/dispose 可逆）。
 * 依据：路径元素有稳定钩子 [data-testid="virtual-project-root-name"]，
 * 截断由 .truncate 类（nowrap/ellipsis）实现，CSS 覆盖即可，无需改 React。 */
(function () {
  "use strict";
  var ID = "folder-full-path";
  var STYLE_ID = "zch-" + ID + "-style";
  var CSS =
    '[data-testid="virtual-project-root-name"]{' +
    "white-space:normal;word-break:break-all;overflow:visible;text-overflow:unset;}" +
    '[data-testid="virtual-project-root-row"]{align-items:flex-start;}';

  window.__zchModules[ID] = {
    install: function () {
      if (document.getElementById(STYLE_ID)) return "already";
      var s = document.createElement("style");
      s.id = STYLE_ID;
      s.setAttribute("data-zch-module", ID);
      s.textContent = CSS;
      document.head.appendChild(s);
      return "ok";
    },
    dispose: function () {
      var s = document.getElementById(STYLE_ID);
      if (s) s.remove();
      return "ok";
    },
  };
})();
```

- [ ] **Step 4: 实现** `shared/modules/branch-badge.js`（完整代码，逻辑源自 `plugins/zcode-branch-badge/inject/branch-badge.js`，改造点：注册协议、dispose 全量清理、MutationObserver 引用保存）：

```js
/* zcode 模块：编辑项目源文件夹显示 git 分支徽章（数据来自 zch-branch-daemon）。
 * 逻辑与 inject/branch-badge.js 一致，按模块协议封装为 install/dispose。 */
(function () {
  "use strict";
  var ID = "branch-badge";
  var PORTS = [39217, 39218, 39219, 39220, 39221];
  var TTL = 2000;
  var BADGE_MARK = "data-zch-branch-badge";
  var ROW_SELECTOR = '[data-testid="virtual-project-root-row"]';
  var NAME_SELECTOR = '[data-testid="virtual-project-root-name"]';

  var base = null;
  var cache = new Map();
  var inflight = new Map();
  var observer = null;

  function ping(port) {
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () { if (!done) { done = true; resolve(false); } }, 800);
      fetch("http://127.0.0.1:" + port + "/ping")
        .then(function (resp) { if (!done) { done = true; clearTimeout(timer); resolve(resp.ok); } })
        .catch(function () { if (!done) { done = true; resolve(false); } });
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
    if (hit && Date.now() - hit.at < TTL) return hit.label;
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
    el.className = "text-ui-sm text-foreground-subtle";
    el.setAttribute(BADGE_MARK, "1");
    el.setAttribute("data-zch-module", ID);
    el.textContent = "⎇ " + label;
    el.style.cssText =
      "display:block;width:fit-content;margin-top:3px;white-space:nowrap;" +
      "border:1px solid rgba(128,128,128,.35);border-radius:4px;padding:1px 6px;";
    return el;
  }

  function decorate(row) {
    if (!(row instanceof Element) || !row.matches(ROW_SELECTOR)) return;
    if (row.querySelector("[" + BADGE_MARK + "]")) return;
    var name = row.querySelector(NAME_SELECTOR);
    if (!name) return;
    var path = name.getAttribute("title") || (name.textContent || "").trim();
    if (!path || path.charCodeAt(0) !== 47) return;
    getLabel(path).then(function (label) {
      if (!label || !row.isConnected) return;
      if (row.querySelector("[" + BADGE_MARK + "]")) return;
      var target = row.querySelector(NAME_SELECTOR);
      if (!target) return;
      target.appendChild(makeBadge(label));
    });
  }

  function scan(nodes) {
    Array.prototype.forEach.call(nodes, function (node) {
      if (!(node instanceof Element)) return;
      if (node.matches(ROW_SELECTOR)) decorate(node);
      if (node.querySelectorAll) node.querySelectorAll(ROW_SELECTOR).forEach(decorate);
    });
  }

  window.__zchModules[ID] = {
    install: function () {
      if (observer) return "already";
      observer = new MutationObserver(function (mutations) {
        mutations.forEach(function (m) {
          scan(m.addedNodes);
          if (m.removedNodes.length && m.target instanceof Element) {
            var row = m.target.closest ? m.target.closest(ROW_SELECTOR) : null;
            if (row) decorate(row);
          }
        });
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      scan([document.documentElement]);
      discover(); // 后台探测 daemon；探测成功前 getLabel 返回 null
      return "ok";
    },
    dispose: function () {
      if (observer) { observer.disconnect(); observer = null; }
      Array.prototype.forEach.call(
        document.querySelectorAll("[" + BADGE_MARK + "]"),
        function (el) { el.remove(); });
      cache.clear();
      inflight.clear();
      base = null;
      return "ok";
    },
  };
})();
```

- [ ] **Step 5: 跑 `node --test tests/test_modules.cjs`** 预期 PASS。

- [ ] **Step 6: 拷贝副本**：两插件 `loader/modules/` 各放两份模块文件（`cp shared/modules/*.js plugins/zcode-branch-badge/loader/modules/ && cp shared/modules/*.js plugins/zcode-folder-full-path/loader/modules/`）。

- [ ] **Step 7: 提交**：
```bash
git add shared/modules plugins/*/loader/modules tests/test_modules.cjs
git commit -m "feat: 渲染注入模块 folder-full-path 与 branch-badge（install/dispose 可逆）"
```

### Task 5: hook 改造 + 旧补丁退役 + 同步测试扩展

**Files:**
- Modify: `shared/session-start.py`（真源）、两个插件 `hooks/session-start.py`（副本）
- Delete: `plugins/zcode-folder-full-path/patches/folder-full-path.json`、`plugins/zcode-branch-badge/patches/folder-git-branch.json`
- Modify: `tests/test_engine_sync.py`（COPIES 扩展）、`tests/test_session_hook.py`（按新 hook 行为调整）

**Interfaces:**
- Consumes: Task 2 的 `loader install --quiet --json`（hook 通过子进程调用，解析最后一行 JSON，`action == "installed"` 时打印重启提示）。
- Produces: hook 新行为——拉起 daemon（branch-badge 保留）→ autoApply 开启时执行 `loader install --quiet`（幂等）→ 仅当本次真正写入指针时提示"完全退出重开一次"。

- [ ] **Step 1: 调整 `tests/test_session_hook.py` 为失败状态**：现有测试针对旧 `auto` 补丁行为；改为断言——hook 在 autoApply 开启时调用 `loader install`（monkeypatch subprocess 记录调用参数）、`action=installed` 时输出重启提示、`action=already` 时无输出、daemon 脚本存在时调用 `daemon start`。（具体断言代码照现有测试风格改写，保持其自管临时目录机制。）

- [ ] **Step 2: 跑 hook 测试确认失败**。

- [ ] **Step 3: 改写 `shared/session-start.py`**：结构保留（`_plugin_name`/`CONFIG`/`auto_apply_enabled`/`ensure_daemon` 原样），`main()` 中把 `auto` 补丁检查段替换为：

```python
    try:
        proc = subprocess.run(
            [sys.executable, str(TOOL), "--json", "loader", "install", "--quiet"],
            capture_output=True, text=True, timeout=120,  # 首装重打包可达数十秒
        )
    except (OSError, subprocess.SubprocessError):
        return 0
    payload = None
    for line in reversed(proc.stdout.strip().splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                payload = json.loads(line)
                break
            except ValueError:
                continue
    if payload and payload.get("action") == "installed":
        print(
            f"[{PLUGIN_NAME}] 已安装 UI 注入 loader（asar 已重打包）。"
            "请完全退出 ZCode 后重新打开一次，此后插件开关即时生效、无需重启。"
        )
    return 0
```

文件头 docstring 同步改写（说明新语义：loader 健康检查与自动安装，不再做字节补丁）。

- [ ] **Step 4: 跑 hook 测试确认通过**。

- [ ] **Step 5: 删除旧补丁定义**：`git rm plugins/zcode-folder-full-path/patches/folder-full-path.json plugins/zcode-branch-badge/patches/folder-git-branch.json`（引擎 `apply/restore/auto` 保留但空补丁集下为 no-op；`inject/branch-badge.js` 一并删除——其逻辑已入模块）。

- [ ] **Step 6: 扩展 `tests/test_engine_sync.py`**：COPIES 增加 `plugins/zcode-branch-badge/loader/loader.cjs`、`plugins/zcode-folder-full-path/loader/loader.cjs`、两个插件的 `loader/modules/folder-full-path.js`、`loader/modules/branch-badge.js`，并把 `shared/session-start.py` 与两个 hook 副本纳入已有哈希比对。

- [ ] **Step 7: 同步副本**：`cp shared/zcode_helper.py plugins/zcode-branch-badge/scripts/ && cp shared/zcode_helper.py plugins/zcode-folder-full-path/scripts/ && cp shared/session-start.py plugins/zcode-branch-badge/hooks/session-start.py && cp shared/session-start.py plugins/zcode-folder-full-path/hooks/session-start.py`，然后**全量测试**：`python3 tests/test_engine_sync.py` 等 5 个测试文件全部通过。

- [ ] **Step 8: 提交**：
```bash
git add -A
git commit -m "refactor: hook 改为 loader 自动安装，等长替换补丁对两插件退役"
```

### Task 6: README 与文档更新

**Files:**
- Modify: `README.md`

- [ ] **Step 1:** 更新 README：架构说明改为"主进程 loader + 渲染模块"，补充命令 `loader install/remove/status` 用法、`~/.zcode/zcode-helper/loader.log` 排查入口、模块协议一句说明；删除已退役的补丁 JSON 相关描述。
- [ ] **Step 2:** 提交：
```bash
git add README.md
git commit -m "docs: README 更新为 loader 注入架构"
```

### Task 7: 真机验收（手动，与用户配合）

**Files:** 无代码改动；必要时修 bug 回到对应 Task。

- [ ] **Step 1:** 在真机执行 `python3 plugins/zcode-branch-badge/scripts/zcode_helper.py loader install`（或由 hook 首次会话自动触发）。
- [ ] **Step 2:** 用户完全退出 ZCode（注意退出确认弹窗选"退出"）并重开。
- [ ] **Step 3:** 验收清单（逐项确认）：
  1. 开关从关拨到开 → 编辑项目弹窗路径立即显示完整路径/徽章（<1s 无重启）；
  2. 开关从开拨到关 → 效果立即消失、无残留 DOM/style；
  3. 重启 ZCode 后状态与开关一致；
  4. `loader status` 输出 `installed: true`；
  5. 新开会话 hook 无报错、`loader.log` 无异常堆积。
- [ ] **Step 4:** 问题修复后重跑本清单；全部通过后提交收尾（如有改动）。

---

## Self-Review 记录

- Spec 覆盖：loader install/remove/status（T2）、loader 常驻与监听（T3）、两模块可逆注入（T4）、hook 改造与旧补丁退役（T5）、同步测试（T5）、错误处理（loader 全 catch + 日志；T3）、真机验收（T7）。✓ 无缺口。
- 占位符扫描：Task 5 Step 1/Step 2 的测试改写引用现有测试风格而非贴全量代码——执行者先读 `tests/test_session_hook.py` 现状再改，断言目标已明确列出；其余任务代码完整。✓
- 类型/命名一致性：模块 id `folder-full-path`/`branch-badge`、`window.__zchModules`、`LOADER_IMPORT_MARK`、`LOADER_HOME`、`MAIN_ENTRY`、`activate()` 各任务一致。✓
