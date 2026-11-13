# 插件拆分实施计划：zcode-helper → zcode-folder-full-path + zcode-branch-badge

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把单插件 `zcode-helper` 拆成两个可独立安装/开关/还原的插件，引擎与 hook 通用化后以 `shared/` 真源 + 分发副本的形式维护。

**Architecture:** 引擎读自身 `.zcode-plugin/plugin.json` 的 `name` 派生数据目录 `~/.zcode/<插件名>/`；目录里带不带 `zch_branch_daemon.py` 决定引擎是否暴露 daemon 能力；replace 支持 `{{data_dir}}` 占位符。两个插件内的引擎/hook 与 `shared/` 真源逐字节一致，由同步测试防漂移。

**Tech Stack:** Python 3 标准库（无第三方依赖）；测试为直跑脚本风格（`python3 tests/test_xxx.py`）。

**设计文档：** `docs/superpowers/specs/2026-11-13-plugin-split-design.md`

## Global Constraints

- 所有命令都在 worktree 目录执行：`/Users/zexin.li/projects/github/lizexinxin/zcode-helper/.zcode/worktrees/worktree-lzx-plugin-split`（下文简写 `$WT`）。
- 测试绝不读写真实的 `/Applications/ZCode.app/.../app.asar` 和 `~/.zcode/`，一律用临时目录。
- `shared/zcode_helper.py`、`shared/session-start.py` 是真源；两个插件目录里的副本必须与真源逐字节相同（Task 5 的同步测试保证）。
- 分支徽章注入路径统一写 `file://{{data_dir}}/inject/branch-badge.js`，不允许出现 `/Users/zexin.li/...` 硬编码。
- 命令前缀：`/folder-full-path-apply|restore|status`、`/branch-badge-apply|restore|status`；daemon start/status 不新增命令（脚本调用 + hook 自动拉起）。
- 两个新插件版本均为 `0.1.0`；市场名保持 `zcode-helper-marketplace`。
- 提交信息用中文，沿用仓库风格（`feat:` / `docs:` / `refactor:` 前缀可选，冒号后中文描述）。
- 测试只依赖标准库；`tests/test_patch_engine.py` 的现有用例语义不得丢失（{{ident}} 通配、往返、幂等、匹配失败不改、patch JSON 与测试常量一致、payload 同步）。

---

### Task 1: 引擎通用化（数据目录派生 + `{{data_dir}}` + 可选 daemon）

**Files:**
- Modify: `plugins/zcode-helper/scripts/zcode_helper.py`（Task 3 会移到 `shared/`，先在原位改）
- Test: `tests/test_patch_engine.py`

**Interfaces:**
- Produces（后续任务依赖的引擎新接口）:
  - `resolve_plugin_name() -> str`：读 `PLUGIN_ROOT/.zcode-plugin/plugin.json` 的 `name`，缺失或无 `name` 抛 `RuntimeError`
  - `set_data_dir(path) -> None`：覆盖模块级 `DATA_DIR` / `STATE_PATH` / `CONFIG_PATH`
  - `DATA_DIR_TOKEN = "{{data_dir}}"`、`expand_replace(rep) -> str`、`HAS_DAEMON: bool`
  - CLI 新参数 `--data-dir`；`daemon` 子命令仅在 `HAS_DAEMON` 时注册

- [ ] **Step 1: 写失败测试（追加到 tests/test_patch_engine.py）**

在 `Case.__init__` 里补一行 config 隔离（紧跟现有两行 monkeypatch）：

```python
class Case:
    def __init__(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.asar = self.dir / "app.asar"
        self.state_path = self.dir / "state.json"
        # 隔离真实状态文件，测试不碰 ~/.zcode/zcode-helper/
        zh.STATE_PATH = self.state_path
        zh.DATA_DIR = self.dir
        zh.CONFIG_PATH = self.dir / "config.json"
```

在文件末尾 `def main()` 之前追加：

```python
DD_FIND = '<script src="' + "P" * 120 + '"></script>'
DD_REPLACE = '<script src="file://{{data_dir}}/inject/branch-badge.js"></script>'


def make_dd_patch() -> dict:
    return {
        "id": "data-dir-token",
        "title": "占位符补丁",
        "version": 1,
        "locate": {
            "pathPrefix": "out/renderer/",
            "pathSuffix": "index.html",
            "minSize": 1000,
            "contains": ["zcode-startup-ready"],
        },
        "replacements": [{"find": DD_FIND, "replace": DD_REPLACE, "expectedCount": 1}],
    }


def dd_fixture() -> bytes:
    return (
        b'<!doctype html><html><head><style>'
        b"body.zcode-startup-ready{opacity:1}"
        + b"/* " + b"x" * 2000 + b" */"
        + DD_FIND.encode("utf-8")
        + b"</style></head><body></body></html>"
    )


def test_data_dir_token_expansion():
    """replace 中的 {{data_dir}} 展开为 DATA_DIR 绝对路径；往返与幂等不受影响。"""
    case = Case()
    try:
        build_asar(
            case.asar,
            {
                "package.json": b'{"version":"3.18.2"}',
                INDEX_HTML_PATH: dd_fixture(),
            },
        )
        size_before = case.asar.stat().st_size
        state = zh.load_state()
        patch = make_dd_patch()
        expanded = ('<script src="file://' + str(case.dir) + '/inject/branch-badge.js"></script>').encode("utf-8")

        with zh.open_asar(case.asar) as (fh, header, data_base):
            assert zh.patch_state(fh, data_base, header, patch)[0] == "not_applied"
            result = zh.apply_patch(fh, data_base, header, patch, state)
            assert result["status"] == "applied", result

        assert case.asar.stat().st_size == size_before
        assert expanded in case.asar.read_bytes()
        assert b"{{data_dir}}" not in case.asar.read_bytes(), "占位符必须被展开"

        with zh.open_asar(case.asar) as (fh, header, data_base):
            again = zh.apply_patch(fh, data_base, header, patch, state)
            assert again["status"] == "already_applied", again["status"]

        with zh.open_asar(case.asar) as (fh, _h, _d):
            restored = zh.restore_patch(fh, patch, state, case.asar)
            assert restored["status"] == "restored", restored
        assert DD_FIND.encode("utf-8") in case.asar.read_bytes()
    finally:
        case.close()


def test_resolve_plugin_name():
    """插件名来自 .zcode-plugin/plugin.json；缺失 name 时报 RuntimeError。"""
    with tempfile.TemporaryDirectory() as tmp:
        manifest_dir = Path(tmp) / "fake-plugin"
        (manifest_dir / ".zcode-plugin").mkdir(parents=True)
        manifest = manifest_dir / ".zcode-plugin" / "plugin.json"
        manifest.write_text('{"name":"zcode-test"}', encoding="utf-8")
        old_root = zh.PLUGIN_ROOT
        zh.PLUGIN_ROOT = manifest_dir
        try:
            assert zh.resolve_plugin_name() == "zcode-test"
            manifest.write_text("{}", encoding="utf-8")
            try:
                zh.resolve_plugin_name()
            except RuntimeError:
                pass
            else:
                raise AssertionError("缺少 name 字段应抛 RuntimeError")
        finally:
            zh.PLUGIN_ROOT = old_root


def test_set_data_dir_overrides_paths():
    """set_data_dir 同时更新 DATA_DIR/STATE_PATH/CONFIG_PATH。"""
    old = (zh.DATA_DIR, zh.STATE_PATH, zh.CONFIG_PATH)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "data"
            zh.set_data_dir(target)
            assert zh.DATA_DIR == target
            assert zh.STATE_PATH == target / "state.json"
            assert zh.CONFIG_PATH == target / "config.json"
    finally:
        zh.DATA_DIR, zh.STATE_PATH, zh.CONFIG_PATH = old
```

- [ ] **Step 2: 运行确认失败**

Run: `python3 tests/test_patch_engine.py`
Expected: `test_data_dir_token_expansion`、`test_resolve_plugin_name`、`test_set_data_dir_overrides_paths` 三项 FAIL（`AttributeError` / 行为不符），其余 PASS。

- [ ] **Step 3: 实现引擎改动（plugins/zcode-helper/scripts/zcode_helper.py）**

3.1 模块 docstring 顶部一行改为（第 3 行）：

```python
"""zcode_helper：给 ZCode 桌面客户端打 UI 补丁的通用引擎（多个插件共用同一份副本）。
```

并在「通用参数」行（原第 27 行）改为：

```python
通用参数：--asar PATH  --data-dir PATH  --json  --quiet
```

3.2 替换常量区（原 63-70 行）：

旧：

```python
PLUGIN_ROOT = Path(__file__).resolve().parent.parent
PATCH_DIR = PLUGIN_ROOT / "patches"
DATA_DIR = Path.home() / ".zcode" / "zcode-helper"
STATE_PATH = DATA_DIR / "state.json"
CONFIG_PATH = DATA_DIR / "config.json"

DAEMON_PORTS = list(range(39217, 39222))
DAEMON_SCRIPT = PLUGIN_ROOT / "scripts" / "zch_branch_daemon.py"
```

新：

```python
PLUGIN_ROOT = Path(__file__).resolve().parent.parent
PATCH_DIR = PLUGIN_ROOT / "patches"

DAEMON_PORTS = list(range(39217, 39222))
DAEMON_SCRIPT = PLUGIN_ROOT / "scripts" / "zch_branch_daemon.py"
# 本目录是否携带分支服务脚本，决定引擎是否注册 daemon 子命令、
# status/doctor 是否输出分支服务行（同一份引擎在不同插件下行为自适应）。
HAS_DAEMON = DAEMON_SCRIPT.is_file()


def resolve_plugin_name() -> str:
    """从插件清单读插件名，用于派生数据目录 ~/.zcode/<插件名>/。"""
    manifest = PLUGIN_ROOT / ".zcode-plugin" / "plugin.json"
    try:
        name = json.loads(manifest.read_text(encoding="utf-8")).get("name")
    except (OSError, ValueError):
        name = None
    if not name:
        raise RuntimeError(f"无法确定插件名：读取 {manifest} 失败或缺少 name 字段")
    return name


def set_data_dir(path) -> None:
    """覆盖数据目录（CLI --data-dir；测试与非默认安装使用）。"""
    global DATA_DIR, STATE_PATH, CONFIG_PATH
    DATA_DIR = Path(path).expanduser()
    STATE_PATH = DATA_DIR / "state.json"
    CONFIG_PATH = DATA_DIR / "config.json"


PLUGIN_NAME = resolve_plugin_name()
DATA_DIR = Path.home() / ".zcode" / PLUGIN_NAME
STATE_PATH = DATA_DIR / "state.json"
CONFIG_PATH = DATA_DIR / "config.json"
```

3.3 在 `IDENT_PATTERN` 定义之后、`find_regex` 之前插入占位符支持：

```python
DATA_DIR_TOKEN = "{{data_dir}}"


def expand_replace(rep: dict) -> str:
    """replace 中的 {{data_dir}} 展开为本插件的数据目录绝对路径。

    只作用于 replace（find 按字面量匹配，不做展开）；展开后若超过命中片段
    长度，由 applied_form 的等长校验报错。
    """
    return rep["replace"].replace(DATA_DIR_TOKEN, str(DATA_DIR))
```

3.4 `applied_form` 第一处赋值：

旧：

```python
    replace = rep["replace"].encode("utf-8")
```

新：

```python
    replace = expand_replace(rep).encode("utf-8")
```

3.5 `replacement_state` 通配分支的 return（原第 232 行）：

旧：

```python
    return matches, data.count(rep["replace"].encode("utf-8"))
```

新：

```python
    return matches, data.count(expand_replace(rep).encode("utf-8"))
```

3.6 `build_parser`：`--quiet` 参数之后追加：

```python
    parser.add_argument("--data-dir", help="覆盖数据目录（默认 ~/.zcode/<插件名>）")
```

daemon 子命令注册改为条件式：

旧：

```python
    p_daemon = sub.add_parser("daemon", help="本地分支服务（start/status）")
    p_daemon.add_argument("daemon_cmd", choices=["start", "status"])
    p_daemon.set_defaults(func=cmd_daemon)
```

新：

```python
    if HAS_DAEMON:
        p_daemon = sub.add_parser("daemon", help="本地分支服务（start/status）")
        p_daemon.add_argument("daemon_cmd", choices=["start", "status"])
        p_daemon.set_defaults(func=cmd_daemon)
```

3.7 `main`：

旧：

```python
    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
```

新：

```python
    args = parser.parse_args(argv)
    if args.data_dir:
        set_data_dir(args.data_dir)
    if not getattr(args, "func", None):
```

3.8 `cmd_status` 的分支服务输出（原 546-551 行）加门控：

旧：

```python
        daemon_port = find_daemon_port(timeout=0.2)
        if daemon_port:
            print(f"分支服务  运行中（127.0.0.1:{daemon_port}）")
        else:
            print("分支服务  未运行（git 分支徽章不会显示；运行 daemon start 启动）")
        print()
```

新：

```python
        if HAS_DAEMON:
            daemon_port = find_daemon_port(timeout=0.2)
            if daemon_port:
                print(f"分支服务  运行中（127.0.0.1:{daemon_port}）")
            else:
                print("分支服务  未运行（git 分支徽章不会显示；运行 daemon start 启动）")
        print()
```

3.9 `cmd_doctor` 的分支服务行（原 744-745 行）加门控：

旧：

```python
            daemon_port = find_daemon_port(timeout=0.2)
            print(f"分支服务   {'运行中（127.0.0.1:%d）' % daemon_port if daemon_port else '未运行'}")
```

新：

```python
            if HAS_DAEMON:
                daemon_port = find_daemon_port(timeout=0.2)
                print(f"分支服务   {'运行中（127.0.0.1:%d）' % daemon_port if daemon_port else '未运行'}")
```

- [ ] **Step 4: 运行测试确认全部通过**

Run: `python3 tests/test_patch_engine.py && python3 tests/test_branch_daemon.py`
Expected: 全部 PASS（引擎测试含新增 3 项）。

- [ ] **Step 5: Commit**

```bash
git add plugins/zcode-helper/scripts/zcode_helper.py tests/test_patch_engine.py
git commit -m "refactor: 引擎通用化——数据目录按插件名派生、{{data_dir}} 占位符、daemon 改为可选扩展"
```

---

### Task 2: hook 通用化

**Files:**
- Modify: `plugins/zcode-helper/hooks/session-start.py`（Task 3 移到 `shared/`）
- Test: Create `tests/test_session_hook.py`

**Interfaces:**
- Consumes: 无（hook 独立）
- Produces: hook 脚本内 `ROOT`、`TOOL`、`DAEMON_SCRIPT`、`PLUGIN_NAME`、`CONFIG` 模块级变量与 `auto_apply_enabled()`、`ensure_daemon()`、`main()` 函数（测试直接导入使用）；`_plugin_name(root)` 在清单缺失时回退 `root.name`

- [ ] **Step 1: 写失败测试（新建 tests/test_session_hook.py）**

```python
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SessionStart hook 测试（仅依赖标准库）。

运行：python3 tests/test_session_hook.py
"""

import importlib.util
import sys
import tempfile
import traceback
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "plugins" / "zcode-helper" / "hooks" / "session-start.py"


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
        hook.DAEMON_SCRIPT = hook.ROOT / "scripts" / "zch_branch_daemon.py"
        hook.ensure_daemon()
        assert run.call_count == 1


def test_plugin_name_fallback():
    """清单缺失时回退目录名。"""
    hook = load_hook("hook_name_fallback")
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "some-plugin"
        root.mkdir()
        assert hook._plugin_name(root) == "some-plugin"


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
```

- [ ] **Step 2: 运行确认失败**

Run: `python3 tests/test_session_hook.py`
Expected: `test_daemon_start_only_when_script_present`、`test_plugin_name_fallback` FAIL（hook 没有 `DAEMON_SCRIPT`/`_plugin_name` 属性），其余 PASS。

- [ ] **Step 3: 重写 plugins/zcode-helper/hooks/session-start.py（全文替换）**

```python
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SessionStart hook：检查本插件的 UI 补丁状态（多个插件共用同一份副本）。

- 从未应用过：静默退出。
- 之前应用过、ZCode 升级后失效：自动重新应用（autoApply 默认开启），并提示重启。
- 新版本代码结构变化导致无法匹配：提示用户适配。
- 仅当本插件携带分支服务脚本（zch_branch_daemon.py）时，best-effort 拉起 daemon。

只输出简短结论到 stdout（会进入模型上下文）。
"""

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOOL = ROOT / "scripts" / "zcode_helper.py"
DAEMON_SCRIPT = ROOT / "scripts" / "zch_branch_daemon.py"


def _plugin_name(root: Path) -> str:
    """插件名来自清单；缺失时回退目录名（hook 只读 config，宽松处理）。"""
    manifest = root / ".zcode-plugin" / "plugin.json"
    try:
        name = json.loads(manifest.read_text(encoding="utf-8")).get("name")
    except (OSError, ValueError):
        name = None
    return name or root.name


PLUGIN_NAME = _plugin_name(ROOT)
CONFIG = Path.home() / ".zcode" / PLUGIN_NAME / "config.json"


def auto_apply_enabled() -> bool:
    try:
        data = json.loads(CONFIG.read_text(encoding="utf-8"))
        return data.get("autoApply", True) is not False
    except (OSError, ValueError):
        return True


def ensure_daemon() -> None:
    """best-effort 拉起本地分支服务（folder-git-branch 补丁的数据源），失败静默。

    独立于 autoApply 开关：daemon 是无害的本地只读服务，拉起失败也不影响补丁。
    仅当本插件携带 daemon 脚本时才尝试。
    """
    if not DAEMON_SCRIPT.is_file():
        return
    try:
        subprocess.run(
            [sys.executable, str(TOOL), "daemon", "start"],
            capture_output=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        pass


def main() -> int:
    if not TOOL.is_file():
        return 0
    ensure_daemon()
    if not auto_apply_enabled():
        return 0
    try:
        proc = subprocess.run(
            [sys.executable, str(TOOL), "--json", "auto"],
            capture_output=True,
            text=True,
            timeout=30,
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
    if not payload:
        return 0

    reason = payload.get("reason")
    if reason == "never_applied":
        return 0

    repaired = payload.get("repaired") or []
    broken = payload.get("broken") or []
    if repaired:
        print(
            f"[{PLUGIN_NAME}] 检测到 ZCode 升级后 UI 补丁失效，已自动重新应用："
            + "、".join(repaired)
            + "。请完全退出 ZCode 后重新打开，补丁才会生效。"
        )
    if broken:
        names = "、".join(item.get("id", "?") for item in broken)
        print(
            f"[{PLUGIN_NAME}] 以下 UI 补丁无法适配当前 ZCode 版本：{names}。"
            "需要更新补丁定义；运行对应插件的 status 命令查看详情。"
        )
    if reason == "not_writable":
        print(
            f"[{PLUGIN_NAME}] ZCode 的 app.asar 不可写，无法自动修复 UI 补丁。"
            "请运行对应插件的 apply 命令查看处理建议。"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: 运行测试确认全部通过**

Run: `python3 tests/test_session_hook.py && python3 tests/test_patch_engine.py`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add plugins/zcode-helper/hooks/session-start.py tests/test_session_hook.py
git commit -m "refactor: hook 通用化——插件名派生 config 路径，daemon 仅在脚本存在时拉起"
```

---

### Task 3: 目录重组（shared/ 真源 + 两个插件目录 + 补丁占位符 + 测试路径）

**Files:**
- Create: `shared/zcode_helper.py`、`shared/session-start.py`（真源）
- Create: `plugins/zcode-folder-full-path/{.zcode-plugin/plugin.json, patches/folder-full-path.json, scripts/zcode_helper.py, hooks/session-start.py}`
- Create: `plugins/zcode-branch-badge/{.zcode-plugin/plugin.json, patches/folder-git-branch.json, inject/branch-badge.js, scripts/zcode_helper.py, scripts/zch_branch_daemon.py, hooks/session-start.py}`
- Delete: `plugins/zcode-helper/`（整个目录）
- Modify: `plugins/zcode-branch-badge/patches/folder-git-branch.json`（注入路径改占位符）
- Modify: `tests/test_patch_engine.py`（SCRIPT 与路径常量、BRANCH_REPLACE 模板化）
- Modify: `tests/test_branch_daemon.py`（DAEMON 路径一行）
- Modify: `tests/test_session_hook.py`（SCRIPT 路径一行）

**Interfaces:**
- Consumes: Task 1/2 已通用化的引擎与 hook
- Produces: 最终目录结构（两个新插件可独立运行）；`tests/*` 指向新路径；`folder-git-branch.json` 的 replace 含 `{{data_dir}}`

- [ ] **Step 1: 建立真源与插件目录（git mv 保历史）**

```bash
mkdir -p shared
git mv plugins/zcode-helper/scripts/zcode_helper.py shared/zcode_helper.py
git mv plugins/zcode-helper/hooks/session-start.py shared/session-start.py

mkdir -p plugins/zcode-folder-full-path/.zcode-plugin \
         plugins/zcode-folder-full-path/patches \
         plugins/zcode-folder-full-path/scripts \
         plugins/zcode-folder-full-path/hooks \
         plugins/zcode-folder-full-path/commands \
         plugins/zcode-folder-full-path/skills/zcode-folder-full-path

mkdir -p plugins/zcode-branch-badge/.zcode-plugin \
         plugins/zcode-branch-badge/patches \
         plugins/zcode-branch-badge/scripts \
         plugins/zcode-branch-badge/hooks \
         plugins/zcode-branch-badge/commands \
         plugins/zcode-branch-badge/skills/zcode-branch-badge \
         plugins/zcode-branch-badge/inject

git mv plugins/zcode-helper/patches/folder-full-path.json plugins/zcode-folder-full-path/patches/
git mv plugins/zcode-helper/scripts/zch_branch_daemon.py plugins/zcode-branch-badge/scripts/
git mv plugins/zcode-helper/inject/branch-badge.js plugins/zcode-branch-badge/inject/
git mv plugins/zcode-helper/patches/folder-git-branch.json plugins/zcode-branch-badge/patches/

cp shared/zcode_helper.py plugins/zcode-folder-full-path/scripts/
cp shared/session-start.py plugins/zcode-folder-full-path/hooks/
cp shared/zcode_helper.py plugins/zcode-branch-badge/scripts/
cp shared/session-start.py plugins/zcode-branch-badge/hooks/

git rm -r plugins/zcode-helper
```

- [ ] **Step 2: 创建两个 plugin.json**

`plugins/zcode-folder-full-path/.zcode-plugin/plugin.json`：

```json
{
  "name": "zcode-folder-full-path",
  "version": "0.1.0",
  "description": "ZCode「编辑项目 → 源文件夹」列表直接显示完整路径（原只显示文件夹名），解决同名文件夹无法区分的问题。通过等长原地替换 app.asar 内的界面代码实现，可精确还原；修改后需完全退出并重新打开 ZCode。",
  "author": { "name": "zexin.li" },
  "license": "MIT",
  "keywords": ["zcode", "ui", "patch", "asar", "folder"],
  "commands": "commands",
  "skills": "skills",
  "hooks": "hooks/hooks.json"
}
```

`plugins/zcode-branch-badge/.zcode-plugin/plugin.json`：

```json
{
  "name": "zcode-branch-badge",
  "version": "0.1.0",
  "description": "ZCode「编辑项目 → 源文件夹」列表中为 git 仓库显示当前分支徽章（⎇ main）。注入本地 payload + 本地分支查询服务实现，不修改压缩 JS，失败静默不影响 ZCode 功能；修改后需完全退出并重新打开 ZCode。",
  "author": { "name": "zexin.li" },
  "license": "MIT",
  "keywords": ["zcode", "ui", "git", "branch", "patch"],
  "commands": "commands",
  "skills": "skills",
  "hooks": "hooks/hooks.json"
}
```

- [ ] **Step 3: 修改 folder-git-branch.json 的注入路径为占位符**

`plugins/zcode-branch-badge/patches/folder-git-branch.json` 的 `replace` 中：

旧：

```
</style><script src="file:///Users/zexin.li/.zcode/zcode-helper/inject/branch-badge.js"></script>
```

新：

```
</style><script src="file://{{data_dir}}/inject/branch-badge.js"></script>
```

同时把该文件的 `description` 里 `~/.zcode/zcode-helper/inject/branch-badge.js` 改为 `~/.zcode/zcode-branch-badge/inject/branch-badge.js`。

- [ ] **Step 4: 更新三个测试文件中的路径常量**

4.1 `tests/test_patch_engine.py`：

- SCRIPT：

旧：`SCRIPT = ROOT / "plugins" / "zcode-helper" / "scripts" / "zcode_helper.py"`
新：`SCRIPT = ROOT / "plugins" / "zcode-branch-badge" / "scripts" / "zcode_helper.py"`

- `BRANCH_REPLACE` 改名并模板化（`</style>` 之后一行）：

旧：

```python
    "</style>"
    '<script src="file:///Users/zexin.li/.zcode/zcode-helper/inject/branch-badge.js"></script>'
)
```

新：

```python
    "</style>"
    '<script src="file://{{data_dir}}/inject/branch-badge.js"></script>'
)


def branch_replace() -> str:
    """展开 {{data_dir}} 后的实际 replace（Case 已把 DATA_DIR 隔离到临时目录）。"""
    return BRANCH_REPLACE_TEMPLATE.replace("{{data_dir}}", str(zh.DATA_DIR))
```

（同时把 `BRANCH_REPLACE = (` 改名为 `BRANCH_REPLACE_TEMPLATE = (`。）

- `test_branch_patch_roundtrip` 里两处 `BRANCH_REPLACE` 引用改为 `branch_replace()`：

```python
        assert BRANCH_REPLACE_TEMPLATE.encode("utf-8") not in body, "原始区块应已被替换"
        assert branch_replace().encode("utf-8") in body, "应写入替换内容（压缩 CSS + script 标签）"
```

（第一处原本就是检查 find 不在 body 里，改用模板即可；实际是 `BRANCH_FIND` 的断言保持不变，只把 `assert BRANCH_REPLACE.encode("utf-8") in body` 改为 `assert branch_replace().encode("utf-8") in body`。）

- `test_patch_json_matches_test_constants`：

旧：`patch_path = ROOT / "plugins" / "zcode-helper" / "patches" / "folder-git-branch.json"`
新：`patch_path = ROOT / "plugins" / "zcode-branch-badge" / "patches" / "folder-git-branch.json"`

且断言改为：

```python
    assert rep["replace"] == BRANCH_REPLACE_TEMPLATE, "patch JSON 的 replace 与测试常量不一致"
```

- `test_sync_payload_files` 的源路径：

旧：`inject_src = ROOT / "plugins" / "zcode-helper" / "inject" / "branch-badge.js"`
新：`inject_src = ROOT / "plugins" / "zcode-branch-badge" / "inject" / "branch-badge.js"`

4.2 `tests/test_branch_daemon.py`：

旧：`DAEMON = ROOT / "plugins" / "zcode-helper" / "scripts" / "zch_branch_daemon.py"`
新：`DAEMON = ROOT / "plugins" / "zcode-branch-badge" / "scripts" / "zch_branch_daemon.py"`

4.3 `tests/test_session_hook.py`：

旧：`SCRIPT = ROOT / "plugins" / "zcode-helper" / "hooks" / "session-start.py"`
新：`SCRIPT = ROOT / "plugins" / "zcode-folder-full-path" / "hooks" / "session-start.py"`

- [ ] **Step 5: 运行全部测试**

Run: `python3 tests/test_patch_engine.py && python3 tests/test_branch_daemon.py && python3 tests/test_session_hook.py`
Expected: 全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: 拆分为 zcode-folder-full-path 与 zcode-branch-badge 两个插件，引擎/hook 真源入 shared/"
```

---

### Task 4: manifest 与文案（marketplace、hooks.json、commands、skills）

**Files:**
- Create: `plugins/zcode-folder-full-path/hooks/hooks.json`、`plugins/zcode-branch-badge/hooks/hooks.json`
- Create: `plugins/zcode-folder-full-path/commands/{folder-full-path-apply,restore,status}.md`
- Create: `plugins/zcode-branch-badge/commands/{branch-badge-apply,restore,status}.md`
- Create: `plugins/zcode-folder-full-path/skills/zcode-folder-full-path/SKILL.md`
- Create: `plugins/zcode-branch-badge/skills/zcode-branch-badge/SKILL.md`
- Modify: `marketplace.json`

**Interfaces:**
- Consumes: Task 3 的目录结构
- Produces: 插件市场可识别的完整插件包（plugin.json 已在 Task 3 就位）

- [ ] **Step 1: 两个 hooks.json**

`plugins/zcode-folder-full-path/hooks/hooks.json`：

```json
{
  "description": "zcode-folder-full-path: 会话启动时检查 ZCode UI 补丁状态。若补丁之前应用过、但 ZCode 升级后失效，则自动重新应用（可在 ~/.zcode/zcode-folder-full-path/config.json 设置 autoApply=false 关闭）；无法适配新版本时提示用户。",
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          {
            "type": "command",
            "shell": true,
            "command": "python3 \"${ZCODE_PLUGIN_ROOT}/hooks/session-start.py\" || python \"${ZCODE_PLUGIN_ROOT}/hooks/session-start.py\"",
            "timeoutMs": 30000,
            "statusMessage": "zcode-folder-full-path: 检查 UI 补丁…"
          }
        ]
      }
    ]
  }
}
```

`plugins/zcode-branch-badge/hooks/hooks.json`：同结构，`description` 与 `statusMessage` 里的插件名换成 `zcode-branch-badge`，config 路径换成 `~/.zcode/zcode-branch-badge/config.json`。

- [ ] **Step 2: 六个命令文件**

`plugins/zcode-folder-full-path/commands/folder-full-path-apply.md`：

```markdown
---
description: 给 ZCode 客户端应用「源文件夹完整路径」UI 补丁（修改 app.asar，需完全退出并重开 ZCode 生效）
---

用 Bash 运行。插件根目录优先取环境变量 `ZCODE_PLUGIN_ROOT`；若为空，用
`find ~/.zcode/cli/plugins -path '*zcode-folder-full-path/scripts/zcode_helper.py' -print -quit`
定位后取其上两级目录：

    python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" apply $ARGUMENTS

脚本会解析 app.asar，按补丁定义做等长原地替换，只写入目标位置的一小段字节，并把原始字节记录到 `~/.zcode/zcode-folder-full-path/state.json`，可随时用 /folder-full-path-restore 还原。

结果处理：

- 输出「已应用」并提示重启时：明确告诉用户必须**完全退出** ZCode（菜单 → 退出，关闭窗口不算），再重新打开，补丁才会生效。
- 输出「无需修改 / 已应用」时，说明当前已经打过了，不需要重复操作；如果用户还没重启过，仍要提醒重启。
- 输出「目标文件未找到 / 目标代码未找到」时：说明当前 ZCode 版本与补丁不匹配。原样转述错误，建议用户运行 /folder-full-path-status 查看详情，并把 ZCode 版本告诉维护者适配补丁。不要尝试自己改 app.asar。
- 没有写入权限时：原样转述脚本提示，不要自行使用 sudo。

用户附加要求：$ARGUMENTS
```

`plugins/zcode-folder-full-path/commands/folder-full-path-restore.md`：

```markdown
---
description: 还原「源文件夹完整路径」补丁对 ZCode 客户端的修改（恢复 app.asar 原始字节）
---

用 Bash 运行。插件根目录优先取环境变量 `ZCODE_PLUGIN_ROOT`；若为空，用
`find ~/.zcode/cli/plugins -path '*zcode-folder-full-path/scripts/zcode_helper.py' -print -quit`
定位后取其上两级目录：

    python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" restore $ARGUMENTS

脚本会按 `~/.zcode/zcode-folder-full-path/state.json` 中记录的原始字节精确写回。如果 ZCode 已经升级、记录位置的内容不再是补丁后的内容，脚本会跳过并提示，不会破坏新版本。

结果处理：

- 输出「已还原」：告诉用户完全退出并重新打开 ZCode 后恢复原样。
- 输出「没有本补丁的安装记录 / 无需还原」：说明当前没有可还原的补丁。
- 输出「记录位置的内容已变化」：说明 ZCode 已升级，补丁本来就已经失效，不需要（也不能）还原。

用户附加要求：$ARGUMENTS
```

`plugins/zcode-folder-full-path/commands/folder-full-path-status.md`：

```markdown
---
description: 查看「源文件夹完整路径」补丁状态（是否已应用、是否适配当前 ZCode 版本）
---

用 Bash 运行。插件根目录优先取环境变量 `ZCODE_PLUGIN_ROOT`；若为空，用
`find ~/.zcode/cli/plugins -path '*zcode-folder-full-path/scripts/zcode_helper.py' -print -quit`
定位后取其上两级目录：

    python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" status

把脚本输出原样转述给用户，不要自行推断成功率。补充说明：

- 状态含义：`已应用` 表示当前 asar 中已经是补丁后的代码；`未应用` 表示可以应用；`目标文件未找到` / `目标代码未找到` 表示 ZCode 版本变化导致补丁需要适配。
- 如果提示需要重启，提醒用户：只关闭窗口不算，必须从菜单完全退出 ZCode 再重新打开。

用户附加要求：$ARGUMENTS
```

`plugins/zcode-branch-badge/commands/branch-badge-apply.md`：

```markdown
---
description: 给 ZCode 客户端应用「git 分支徽章」UI 补丁（修改 app.asar，需完全退出并重开 ZCode 生效）
---

用 Bash 运行。插件根目录优先取环境变量 `ZCODE_PLUGIN_ROOT`；若为空，用
`find ~/.zcode/cli/plugins -path '*zcode-branch-badge/scripts/zcode_helper.py' -print -quit`
定位后取其上两级目录：

    python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" apply $ARGUMENTS

脚本会解析 app.asar，压缩 index.html 启动动画 CSS 并注入 payload 加载标签，原始字节记录到 `~/.zcode/zcode-branch-badge/state.json`，可随时用 /branch-badge-restore 还原；payload 会同步到 `~/.zcode/zcode-branch-badge/inject/`。

结果处理：

- 输出「已应用」并提示重启时：明确告诉用户必须**完全退出** ZCode（菜单 → 退出，关闭窗口不算），再重新打开，补丁才会生效。
- 输出「无需修改 / 已应用」时，说明当前已经打过了，不需要重复操作；如果用户还没重启过，仍要提醒重启。
- 输出「目标文件未找到 / 目标代码未找到」时：说明当前 ZCode 版本与补丁不匹配。原样转述错误，建议用户运行 /branch-badge-status 查看详情，并把 ZCode 版本告诉维护者适配补丁。不要尝试自己改 app.asar。
- 没有写入权限时：原样转述脚本提示，不要自行使用 sudo。

用户附加要求：$ARGUMENTS
```

`plugins/zcode-branch-badge/commands/branch-badge-restore.md`：

```markdown
---
description: 还原「git 分支徽章」补丁对 ZCode 客户端的修改（恢复 app.asar 原始字节）
---

用 Bash 运行。插件根目录优先取环境变量 `ZCODE_PLUGIN_ROOT`；若为空，用
`find ~/.zcode/cli/plugins -path '*zcode-branch-badge/scripts/zcode_helper.py' -print -quit`
定位后取其上两级目录：

    python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" restore $ARGUMENTS

脚本会按 `~/.zcode/zcode-branch-badge/state.json` 中记录的原始字节精确写回。如果 ZCode 已经升级、记录位置的内容不再是补丁后的内容，脚本会跳过并提示，不会破坏新版本。

结果处理：

- 输出「已还原」：告诉用户完全退出并重新打开 ZCode 后恢复原样。
- 输出「没有本补丁的安装记录 / 无需还原」：说明当前没有可还原的补丁。
- 输出「记录位置的内容已变化」：说明 ZCode 已升级，补丁本来就已经失效，不需要（也不能）还原。

用户附加要求：$ARGUMENTS
```

`plugins/zcode-branch-badge/commands/branch-badge-status.md`：

```markdown
---
description: 查看「git 分支徽章」补丁状态（是否已应用、分支服务是否运行）
---

用 Bash 运行。插件根目录优先取环境变量 `ZCODE_PLUGIN_ROOT`；若为空，用
`find ~/.zcode/cli/plugins -path '*zcode-branch-badge/scripts/zcode_helper.py' -print -quit`
定位后取其上两级目录：

    python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" status

把脚本输出原样转述给用户，不要自行推断成功率。补充说明：

- 状态含义：`已应用` 表示当前 asar 中已经是补丁后的代码；`未应用` 表示可以应用；`目标文件未找到` / `目标代码未找到` 表示 ZCode 版本变化导致补丁需要适配。
- 「分支服务 未运行」时徽章不会显示；可运行 `python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" daemon start` 拉起（幂等），SessionStart hook 也会自动拉起。
- 如果提示需要重启，提醒用户：只关闭窗口不算，必须从菜单完全退出 ZCode 再重新打开。

用户附加要求：$ARGUMENTS
```

- [ ] **Step 3: 两个 SKILL.md**

`plugins/zcode-folder-full-path/skills/zcode-folder-full-path/SKILL.md`：

```markdown
---
name: zcode-folder-full-path
description: ZCode 桌面客户端「源文件夹完整路径」补丁。用户想编辑项目时看到源文件夹完整路径、询问“为什么文件夹只显示名字”“同名文件夹分不清”，或想查看/还原该补丁时使用。通过等长原地替换 app.asar 内的界面代码实现，可精确还原。
---

# ZCode Folder Full Path

ZCode 的「编辑项目 → 源文件夹」列表原本只显示文件夹名（basename），hover 才能看到完整路径。
本插件把显示改为完整路径并允许换行。原理：解析 `app.asar` 头部，按补丁定义定位目标 JS
文件，对其中一小段字节做**等长原地替换**（不足部分补空格），不改变 asar 结构、大小和
文件偏移。原始字节记录在 `~/.zcode/zcode-folder-full-path/state.json`，可随时精确还原。

## 何时使用

- 用户说「编辑项目时文件夹只显示名字 / 同名文件夹分不清 / 想看全路径」→ 应用本补丁。
- 用户问补丁是否生效、ZCode 升级后补丁失效 → 查看状态并按需重新应用。
- 用户想还原客户端原始界面 → 运行还原。

## 命令

脚本位置：`${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py`（插件根目录由
`ZCODE_PLUGIN_ROOT` 环境变量提供；若为空，用 `find ~/.zcode -path '*zcode-folder-full-path*/scripts/zcode_helper.py'` 定位）。

```bash
python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" status
python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" apply
python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" restore
python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" doctor
python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" list
```

全局参数 `--asar PATH` 可指向非默认安装位置；`--json` 输出机器可读结果。

## 已内置补丁

| ID | 作用 | 验证版本 |
|---|---|---|
| `folder-full-path` | 「编辑项目 → 源文件夹」列表直接显示完整路径（允许换行） | ZCode 3.16.3、3.17.1 |

## 工作原理与安全边界

1. 只修改补丁定义中精确匹配的字节；匹配次数不符合预期时**不做任何修改**并报错。
2. 替换后长度不变（新内容不足时补空格），因此 asar header、文件 offset、总大小都不变。
3. `state.json` 保存每处修改的偏移和原始字节，还原时先校验当前位置内容确实是补丁后的内容，否则跳过。
4. 补丁只改界面显示，不涉及凭据、网络和用户数据。

## 生效条件

修改的是磁盘上的 asar；**已经运行的 ZCode 进程仍使用内存里的旧代码**。
必须完全退出 ZCode（菜单 → 退出，关闭窗口不算）再重新打开，补丁才可见。

## ZCode 升级后

SessionStart hook 会在新会话启动时调用 `auto`：补丁之前应用过、当前又变回未应用状态时
自动重新应用（默认开启，可在 `~/.zcode/zcode-folder-full-path/config.json` 中设置
`{"autoApply": false}` 关闭）。`find` 里用 `{{ident}}` 通配压缩变量名，改名类变化不受影响；
只有目标代码本身变了才需要手工更新 `find`。

## 新增补丁

在 `patches/` 下新增一个 JSON 文件即可，无需改脚本：

```json
{
  "id": "my-patch",
  "title": "补丁名称",
  "version": 1,
  "description": "作用说明",
  "locate": {
    "pathPrefix": "out/renderer/assets/",
    "pathSuffix": ".js",
    "minSize": 1000000,
    "contains": ["用于定位目标文件的唯一字符串"]
  },
  "replacements": [
    { "find": "要被替换的原始代码片段", "replace": "替换后的代码片段（不能比 find 长）", "expectedCount": 1 }
  ]
}
```

- `find` 里出现的压缩变量名用 `{{ident}}` 代替（匹配任意 JS 标识符），避免升级后失效。
- `replace` 里可用 `{{data_dir}}` 指代本插件数据目录 `~/.zcode/zcode-folder-full-path/`（只对 replace 生效，find 不展开）。
- 修改 `find`/`replace` 时保证替换后 JS 语法合法；应用前可用 `node --check <提取出来的文件>` 验证。

## 故障排查

- **没有写入权限**：把 ZCode 复制到 `~/Applications` 后用 `--asar` 指向，或用 sudo 运行。
- **目标文件/代码未找到**：ZCode 升级后 bundle 内容变化，运行 `doctor` 查看定位结果，更新 `patches/*.json`。
- **已应用但界面没变**：没有完全退出 ZCode；确认从菜单退出后重新打开。
- **想彻底移除**：`restore` 后在 **设置 → 插件** 里禁用或卸载本插件。
```

`plugins/zcode-branch-badge/skills/zcode-branch-badge/SKILL.md`：

```markdown
---
name: zcode-branch-badge
description: ZCode 桌面客户端「git 分支徽章」补丁。用户想在编辑项目的源文件夹列表里看到每个 git 仓库的当前分支（如 ⎇ main）、询问徽章为什么不显示、启动/排查本地分支服务（zch-branch-daemon），或想查看/还原该补丁时使用。
---

# ZCode Branch Badge

ZCode 的「编辑项目 → 源文件夹」列表中，本插件为每个 git 仓库文件夹在路径后显示当前
分支徽章（`⎇ main`；detached HEAD 显示 `HEAD@<短SHA>`；非 git 目录不显示）。

实现：压缩 `index.html` 启动动画的 CSS（视觉行为不变）腾出空间，注入一个 `<script>`
标签加载外部 payload `~/.zcode/zcode-branch-badge/inject/branch-badge.js` + 本地
`zch-branch-daemon` 服务查询分支。原始字节记录在
`~/.zcode/zcode-branch-badge/state.json`，可精确还原；**不修改任何压缩 JS**。

## 何时使用

- 用户想给源文件夹列表加分支显示 / 问「为什么看不到分支」→ 应用本补丁并启动分支服务。
- 用户问补丁状态、ZCode 升级后失效 → 查看状态并按需重新应用。
- 用户想还原 → 运行还原。

## 命令

脚本位置：`${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py`（若环境变量为空，用
`find ~/.zcode -path '*zcode-branch-badge*/scripts/zcode_helper.py'` 定位）。

```bash
python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" status        # 补丁 + 分支服务状态
python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" apply         # 应用补丁并同步 payload
python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" restore
python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" daemon start  # 拉起分支服务（幂等）
python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" daemon status
python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" doctor
```

## 分支服务（zch-branch-daemon）

- 只绑定 127.0.0.1，端口 39217-39221 选第一个空闲的；`GET /branch?path=<绝对路径>`
  返回 `{"label": "main" | "HEAD@xxx" | null}`，内部只做只读 `git branch --show-current`。
- SessionStart hook 会自动 best-effort 拉起；也可用上面的 `daemon start` 手动启动。
- **daemon 未运行、目录不是 git 仓库、或查询失败时徽章静默不显示**，不影响 ZCode 功能。
- 安全边界：仅监听回环地址、只做只读 git 查询；日志在 `~/.zcode/zcode-branch-badge/daemon.log`。

## 生效条件

修改的是磁盘上的 asar；**已经运行的 ZCode 进程仍使用内存里的旧代码**。必须完全退出
ZCode（菜单 → 退出，关闭窗口不算）再重新打开。

## ZCode 升级后

SessionStart hook 会自动重新应用失效的补丁（`~/.zcode/zcode-branch-badge/config.json`
的 `{"autoApply": false}` 可关闭）。补丁的 find 是字面量 CSS 区块，不涉及压缩变量名；
ZCode 更换启动动画样式时需要按新 index.html 更新 `find`。

## 故障排查

- **徽章不显示**：① 补丁是否 applied（`status`）；② 分支服务是否运行（`daemon status`，
  没运行就 `daemon start`）；③ 目录是否 git 仓库；④ 是否完全重启过 ZCode。
- **没有写入权限**：同通用引擎处理方式（`--asar` 指向用户目录副本或 sudo）。
- **想彻底移除**：`restore` 后在 **设置 → 插件** 里禁用或卸载本插件。
```

- [ ] **Step 4: 重写 marketplace.json（全文替换）**

```json
{
  "name": "zcode-helper-marketplace",
  "description": "自用 ZCode 客户端 UI 定制补丁市场，包含两个独立插件：zcode-folder-full-path（源文件夹显示完整路径）、zcode-branch-badge（git 分支徽章）。均修改 app.asar，需完全退出并重开 ZCode。",
  "owner": {
    "name": "zexin.li"
  },
  "plugins": [
    {
      "name": "zcode-folder-full-path",
      "source": "./plugins/zcode-folder-full-path",
      "version": "0.1.0",
      "description": "ZCode 编辑项目时源文件夹显示完整路径（原只显示文件夹名）。通过等长原地替换 app.asar 内的界面代码实现，可精确还原；修改后需完全退出并重新打开 ZCode。",
      "displayName": "ZCode Folder Full Path",
      "displayName_i18n": {
        "zh-CN": "ZCode 源文件夹完整路径"
      },
      "description_i18n": {
        "zh-CN": "ZCode 编辑项目时源文件夹显示完整路径（原只显示文件夹名）。通过等长原地替换 app.asar 内的界面代码实现，可精确还原；修改后需完全退出并重新打开 ZCode。"
      },
      "category": "developer-tools",
      "keywords": [
        "zcode",
        "ui",
        "patch",
        "asar"
      ]
    },
    {
      "name": "zcode-branch-badge",
      "source": "./plugins/zcode-branch-badge",
      "version": "0.1.0",
      "description": "ZCode 编辑项目时为 git 仓库源文件夹显示当前分支徽章（⎇ main）。注入本地 payload + 本地分支查询服务实现，失败静默不影响 ZCode 功能；修改后需完全退出并重新打开 ZCode。",
      "displayName": "ZCode Branch Badge",
      "displayName_i18n": {
        "zh-CN": "ZCode git 分支徽章"
      },
      "description_i18n": {
        "zh-CN": "ZCode 编辑项目时为 git 仓库源文件夹显示当前分支徽章（⎇ main）。注入本地 payload + 本地分支查询服务实现，失败静默不影响 ZCode 功能；修改后需完全退出并重新打开 ZCode。"
      },
      "category": "developer-tools",
      "keywords": [
        "zcode",
        "ui",
        "git",
        "branch"
      ]
    }
  ]
}
```

- [ ] **Step 5: 校验 JSON 合法性**

Run: `python3 -c "import json,glob; [json.load(open(p)) for p in glob.glob('plugins/*/**/*.json', recursive=True) + ['marketplace.json']]; print('ok')"`
Expected: 输出 `ok`。

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: 两个插件的 manifest、命令、技能与市场清单"
```

---

### Task 5: 副本同步校验测试

**Files:**
- Create: `tests/test_engine_sync.py`

**Interfaces:**
- Consumes: Task 3 建立的 `shared/` 与副本布局
- Produces: 防漂移校验；README 的同步命令说明（Task 6）引用本测试

- [ ] **Step 1: 新建 tests/test_engine_sync.py**

```python
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""shared/ 真源与各插件分发副本的同步校验（仅依赖标准库）。

运行：python3 tests/test_engine_sync.py

引擎或 hook 改动后，必须把 shared/ 下的真源复制到每个插件目录
（cp 命令见 README「修改引擎」），否则本测试失败。
"""

import hashlib
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SHARED = ROOT / "shared"
COPIES = [
    "plugins/zcode-folder-full-path/scripts/zcode_helper.py",
    "plugins/zcode-branch-badge/scripts/zcode_helper.py",
    "plugins/zcode-folder-full-path/hooks/session-start.py",
    "plugins/zcode-branch-badge/hooks/session-start.py",
]


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    failed = False
    for rel in COPIES:
        copy = ROOT / rel
        source = SHARED / Path(rel).name
        if not copy.is_file():
            print(f"FAIL  缺少副本：{rel}")
            failed = True
            continue
        if sha(copy) != sha(source):
            print(f"FAIL  副本与 shared/ 真源不一致：{rel}（从 shared/{Path(rel).name} 重新复制）")
            failed = True
        else:
            print(f"PASS  {rel}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: 运行确认通过**

Run: `python3 tests/test_engine_sync.py`
Expected: 4 行 PASS，退出码 0。

- [ ] **Step 3: 防漂移演练（可选但建议）**

向任一副本追加一个空格再撤销，重跑测试确认会 FAIL。演练后恢复原状（`git checkout -- <副本>`）再重跑至 PASS。

- [ ] **Step 4: Commit**

```bash
git add tests/test_engine_sync.py
git commit -m "test: shared/ 真源与插件副本的 sha256 同步校验"
```

---

### Task 6: README 重写

**Files:**
- Modify: `README.md`（全文替换）

**Interfaces:**
- Consumes: Task 1-5 的最终结构
- Produces: 面向使用者的安装、命令、原理、迁移与维护文档

- [ ] **Step 1: 全文替换 README.md**

````markdown
# zcode-helper

自用 ZCode 桌面客户端 UI 定制补丁市场，包含两个**互相独立**的插件，
可单独安装、单独开关、单独还原：

1. **ZCode 源文件夹完整路径**（`zcode-folder-full-path`）：编辑项目时，「源文件夹」
   列表直接显示完整路径（`folder-full-path` 补丁），解决不同路径下同名文件夹无法区分的问题。
2. **ZCode git 分支徽章**（`zcode-branch-badge`）：编辑项目时，git 仓库源文件夹显示
   当前分支徽章（`folder-git-branch` 补丁，如 `⎇ main`）；非 git 目录不显示。

## 效果

```
应用前：  📁 zcode-helper
应用后：  📁 /Users/you/projects/github/lizexinxin/zcode-helper  ⎇ main
```

（完整路径来自 folder-full-path；分支徽章来自 zcode-branch-badge，两者可分开使用。）

## 安装

### 1. 添加插件市场

打开 ZCode 的 **插件市场 → 添加 → 添加插件市场**，直接粘贴本仓库的 git 地址：

```
https://github.com/lizexinxin/zcode-helper.git
```

ZCode 会在仓库根目录找到 `marketplace.json`，市场名称为 `zcode-helper-marketplace`。

网络访问 GitHub 不方便时，也可以把本仓库克隆到本地后粘贴本地目录
（注意是**仓库根目录**）：

```
<path-to-clone>/zcode-helper
```

### 2. 安装插件（按需二选一或都装）

在 **Personal → zcode-helper-marketplace** 里安装想要的插件并确认已启用。
两个插件互不依赖。

### 3. 应用补丁

新开一个会话，按插件运行：

- 完整路径：`/folder-full-path-apply`
- 分支徽章：`/branch-badge-apply`

成功后**完全退出 ZCode**（菜单 → 退出，关闭窗口不算），再重新打开。
打开一个项目，进入「编辑项目」即可看到效果。

## 常用命令

| 插件 | 命令 |
|---|---|
| folder-full-path | `/folder-full-path-status` · `/folder-full-path-apply` · `/folder-full-path-restore` |
| branch-badge | `/branch-badge-status` · `/branch-badge-apply` · `/branch-badge-restore` |

分支服务（branch-badge 的数据源）：

```bash
python3 plugins/zcode-branch-badge/scripts/zcode_helper.py daemon start   # 幂等；SessionStart hook 也会自动拉起
python3 plugins/zcode-branch-badge/scripts/zcode_helper.py daemon status
```

也可以直接运行各插件脚本（把 `<插件>` 换成 `zcode-folder-full-path` 或 `zcode-branch-badge`）：

```bash
python3 plugins/<插件>/scripts/zcode_helper.py status
python3 plugins/<插件>/scripts/zcode_helper.py apply
python3 plugins/<插件>/scripts/zcode_helper.py restore
python3 plugins/<插件>/scripts/zcode_helper.py doctor
```

## 原理

ZCode 的界面代码打包在 `/Applications/ZCode.app/Contents/Resources/app.asar`。
引擎解析 asar 头部，按各插件 `patches/*.json` 中的定义定位目标文件，
对其中一小段字节做**等长原地替换**（新内容不足原长度时补空格）：

- 不改变 asar 结构、大小和任何文件 offset，不需要重打包 300MB+ 归档；
- 只写入目标位置的几百字节，并做写入后校验；
- 原始字节记录在各插件自己的 state 文件里，还原时精确写回；
- 匹配次数不符合预期时不做任何修改。

两个插件的数据目录互相独立：

```
~/.zcode/zcode-folder-full-path/state.json
~/.zcode/zcode-branch-badge/{state.json, config.json, inject/branch-badge.js, daemon.log}
```

所以还原其中一个不影响另一个的补丁。

补丁的 `find` 里可以用 `{{ident}}` 通配一个压缩后的 JS 标识符，`replace` 里可以用
`{{data_dir}}` 指代该插件的数据目录。ZCode 每次升级都会重新压缩 bundle，
`{{ident}}` 让补丁不必跟着版本逐个手改。

已验证 ZCode 版本：**3.16.3、3.17.1、3.18.2**。

## 分支徽章的工作方式

`folder-git-branch` 补丁压缩了 `index.html` 启动动画的 CSS（视觉行为不变），
腾出的空间注入一个 `<script>` 标签，加载 `~/.zcode/zcode-branch-badge/inject/branch-badge.js`：

- payload 用 MutationObserver 盯住「编辑项目」弹窗的源文件夹行
  （`data-testid` 语义钩子，不碰压缩后的应用代码）；
- 每个文件夹路径向本地服务 `zch-branch-daemon` 查询分支（`/branch?path=…`），
  daemon 执行只读的 `git branch --show-current`（detached HEAD 显示 `HEAD@<短SHA>`）；
- daemon 端口 39217-39221（仅绑定 127.0.0.1），由 branch-badge 插件的 SessionStart
  hook 自动拉起，也可手动启动（见上文）；
- daemon 未运行、目录不是 git 仓库、或查询失败时**静默不显示徽章**，
  不影响 ZCode 任何功能。

安全边界：daemon 只监听回环地址、只做只读 git 查询；本机其他进程理论上也能
调用该接口（只能查询本机目录的分支，无写操作），自用场景可接受。

### 生效条件

修改的是磁盘上的 asar。已经运行的 ZCode 进程仍使用内存里的旧代码，
必须完全退出并重新打开才会生效。

### ZCode 升级后

ZCode 自动更新会替换整个 `.app`，补丁失效。各插件的 `SessionStart` hook 会在
新会话启动时检查：如果补丁之前应用过、当前又变回未应用，会自动重新应用
（默认开启，可在各插件自己的 `~/.zcode/<插件名>/config.json` 里设置
`{"autoApply": false}` 关闭）。如果新版本代码结构变化导致补丁无法匹配，
hook 会提示需要适配。

只有压缩变量名变化的话（`find` 里已用 `{{ident}}` 通配）不需要改补丁，
`auto` 会直接重新应用；如果目标片段本身变了，仍要按新代码更新 `find`。

## 从旧版单插件迁移（一次性）

旧版是单插件 `zcode-helper`，两个补丁绑在一起。迁移步骤：

1. 旧插件运行 `/zcode-helper-restore`（还原 app.asar 原始字节）。
2. 在 **设置 → 插件** 卸载旧插件。
3. 按上文安装两个新插件（市场地址不变）并分别 apply。
4. 完全退出并重开 ZCode。
5. 删除旧数据目录 `~/.zcode/zcode-helper/`。

⚠️ 分支徽章补丁的注入路径变了，**必须先 restore 再 apply**，不能直接重新 apply 覆盖。

## 修改引擎（shared/ 真源与副本）

引擎（`zcode_helper.py`）与 SessionStart hook（`session-start.py`）的真源在
`shared/`，两个插件目录里是**逐字节相同**的分发副本。改 bug 只改 `shared/`，
然后同步到所有副本：

```bash
cp shared/zcode_helper.py plugins/zcode-folder-full-path/scripts/
cp shared/zcode_helper.py plugins/zcode-branch-badge/scripts/
cp shared/session-start.py plugins/zcode-folder-full-path/hooks/
cp shared/session-start.py plugins/zcode-branch-badge/hooks/
python3 tests/test_engine_sync.py   # 校验副本与真源一致
```

## 测试

```bash
python3 tests/test_patch_engine.py    # 补丁引擎（{{ident}}/{{data_dir}}、往返、幂等，合成 asar）
python3 tests/test_branch_daemon.py   # 本地分支服务（真实起服务、查临时 git 仓库）
python3 tests/test_session_hook.py    # SessionStart hook
python3 tests/test_engine_sync.py     # shared/ 与副本同步
```

用例不会碰真实的 `app.asar` 和 `~/.zcode/`。

## 新增补丁

在对应插件的 `patches/` 下新增一个 JSON 文件即可，脚本不需要改。
格式和定位方法见各插件 `skills/<插件名>/SKILL.md` 的「新增补丁」章节
（`replace` 里可用 `{{data_dir}}` 指代插件数据目录）。

## 风险与边界

- 会修改 `/Applications/ZCode.app` 内的 `app.asar`，属于对官方客户端的第三方修改，
  不是官方功能。ZCode 升级会覆盖它。
- 可用各插件的 restore 命令精确还原；还原后整包哈希与修改前一致。
- 只修改界面显示代码，不涉及登录凭据、网络请求和用户数据。
- macOS 上如果 `/Applications` 不可写，可把 ZCode 复制到 `~/Applications`
  后用 `--asar` 参数指向，或用 sudo 运行脚本。

## 目录结构

```
marketplace.json                     # 插件市场清单（仓库根，ZCode 添加 git 市场时在此查找）
shared/
  zcode_helper.py                    # 补丁引擎真源（两个插件各有一份逐字节相同的副本）
  session-start.py                   # SessionStart hook 真源
plugins/
  zcode-folder-full-path/            # 插件1：源文件夹完整路径
    .zcode-plugin/plugin.json
    patches/folder-full-path.json
    scripts/zcode_helper.py          # 副本
    hooks/{hooks.json, session-start.py}
    commands/  skills/
  zcode-branch-badge/                # 插件2：git 分支徽章
    .zcode-plugin/plugin.json
    patches/folder-git-branch.json
    inject/branch-badge.js           # payload（apply 时同步到 ~/.zcode/zcode-branch-badge/inject/）
    scripts/{zcode_helper.py, zch_branch_daemon.py}
    hooks/{hooks.json, session-start.py}
    commands/  skills/
tests/
  test_patch_engine.py               # 补丁引擎测试（合成 asar，不碰真实客户端）
  test_branch_daemon.py              # 分支服务测试
  test_session_hook.py               # hook 测试
  test_engine_sync.py                # shared/ 与副本同步校验
```
````

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README 重写为多插件市场结构，含迁移步骤与 shared/ 同步说明"
```

---

### Task 7: 全量回归与收尾检查

**Files:**
- 无新文件；只跑测试与检查残留引用

**Interfaces:**
- Consumes: Task 1-6 全部产出
- Produces: 可交付的 worktree 分支

- [ ] **Step 1: 跑全部测试**

```bash
python3 tests/test_patch_engine.py && \
python3 tests/test_branch_daemon.py && \
python3 tests/test_session_hook.py && \
python3 tests/test_engine_sync.py
```

Expected: 四个测试全部通过。

- [ ] **Step 2: 残留引用检查**

```bash
grep -rn "zcode-helper" --include="*.py" --include="*.json" --include="*.md" --include="*.js" \
  shared plugins tests marketplace.json README.md | grep -v "zcode-helper-marketplace"
```

Expected: 除市场名 `zcode-helper-marketplace` 外，`plugins/`、`shared/`、`tests/` 下不应再有 `zcode-helper` 引用（README 标题 `# zcode-helper` 指仓库名，属预期）。若有遗漏，逐处修正后重跑本步。

- [ ] **Step 3: 确认无真实环境副作用**

```bash
git status   # 工作区干净
ls ~/.zcode/zcode-helper 2>/dev/null   # 本任务不应创建/修改它
```

Expected: 工作区干净；真实环境目录未被本任务改动。

- [ ] **Step 4: 汇报与合并**

向用户汇报：测试结果、残留检查结果、以及**用户需要手动执行的迁移步骤**
（README「从旧版单插件迁移」：旧插件 restore → 卸载 → 安装两个新插件 → apply →
完全重启 → 删除 `~/.zcode/zcode-helper/`）。合并/推送由用户决定。

---

## Self-Review 记录

1. **Spec 覆盖**：设计文档的 ① state 目录派生化 → Task 1；② 可选扩展点（daemon 门控）→ Task 1；③ hook 通用化 → Task 2；④ shared/ 真源 + 同步测试 → Task 3/5；⑤ 目录结构与命名 → Task 3/4；⑥ `{{data_dir}}` 占位符 → Task 1（引擎）+ Task 3（补丁 JSON）；⑦ 错误处理（清单缺失报错、占位符超长由等长校验兜底）→ Task 1；⑧ 测试 → Task 1/2/3/5；⑨ 迁移步骤 → Task 6 README + Task 7 汇报。无遗漏。
2. **占位符扫描**：所有代码/文案步骤均给出完整内容，无 TBD/TODO。
3. **类型一致性**：`resolve_plugin_name`/`set_data_dir`/`expand_replace`/`HAS_DAEMON`/`DATA_DIR_TOKEN` 在 Task 1 定义，Task 2 的 hook 不依赖引擎（独立实现 `_plugin_name`），Task 3 测试常量 `BRANCH_REPLACE_TEMPLATE` 与 `branch_replace()` 命名一致；`test_engine_sync.py` 的 COPIES 路径与 Task 3 目录结构一致。
