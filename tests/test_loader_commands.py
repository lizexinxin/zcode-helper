#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""loader CLI 命令测试（install/remove/status，仅依赖标准库）。

运行：python3 tests/test_loader_commands.py

全部走合成 asar 与临时目录，绝不触碰真实 app.asar。隔离手段：
- ZCODE_ASAR 环境变量 / --asar 参数 → 合成 asar
- ZCODE_LOADER_HOME → 临时 loader 主目录（正常为 ~/.zcode/zcode-helper）
- ZCODE_LOADER_ASSETS → 临时资产源目录（正常为插件目录 loader/）
"""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "plugins" / "zcode-branch-badge" / "scripts" / "zcode_helper.py"

_spec = importlib.util.spec_from_file_location("zcode_helper", SCRIPT)
zh = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(zh)


def make_files() -> dict:
    return {
        "package.json": b'{"name":"app","main":"out/main/index.js"}',
        "out/main/index.js": b"console.log('main');\n",
        "out/renderer/index.html": b"<html><body>hi</body></html>",
    }


def make_assets(td: Path) -> Path:
    assets = td / "assets"
    (assets / "modules").mkdir(parents=True)
    (assets / "loader.cjs").write_text("// loader stub\n", encoding="utf-8")
    (assets / "modules" / "folder-full-path.js").write_text("// module\n", encoding="utf-8")
    return assets


def run_tool(asar: Path, td: Path, *args: str, extra_env: dict | None = None) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env["ZCODE_LOADER_HOME"] = str(td / "loaderhome")
    env["ZCODE_LOADER_ASSETS"] = str(td / "assets")
    if extra_env:
        env.update(extra_env)
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--asar", str(asar), "--data-dir", str(td / "data"), *args],
        capture_output=True,
        text=True,
        env=env,
    )


def last_json(text: str) -> dict | None:
    for line in reversed(text.strip().splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except ValueError:
                continue
    return None


def read_index(asar: Path) -> bytes:
    with asar.open("rb") as fh:
        header, data_base = zh.read_header(fh)
        return zh.read_asar_file(fh, data_base, header, zh.MAIN_ENTRY) or b""


def test_install_appends_pointer_and_idempotent():
    with tempfile.TemporaryDirectory() as tmp:
        td = Path(tmp)
        asar = td / "app.asar"
        files = make_files()
        zh.write_asar(asar, files)
        make_assets(td)

        proc = run_tool(asar, td, "--json", "loader", "install", "--quiet")
        assert proc.returncode == 0, proc.stderr
        payload = last_json(proc.stdout)
        assert payload and payload["action"] == "installed", proc.stdout
        index = read_index(asar)
        assert zh.LOADER_IMPORT_MARK.encode() in index
        # 资产已拷到 LOADER_HOME
        assert (td / "loaderhome" / "loader.cjs").is_file()
        assert (td / "loaderhome" / "modules" / "folder-full-path.js").is_file()

        # 幂等：再装一次不重复写指针
        proc2 = run_tool(asar, td, "--json", "loader", "install", "--quiet")
        assert proc2.returncode == 0, proc2.stderr
        payload2 = last_json(proc2.stdout)
        assert payload2 and payload2["action"] == "already", proc2.stdout
        assert read_index(asar).count(zh.LOADER_IMPORT_MARK.encode()) == 1


def test_remove_strips_pointer():
    with tempfile.TemporaryDirectory() as tmp:
        td = Path(tmp)
        asar = td / "app.asar"
        zh.write_asar(asar, make_files())
        make_assets(td)

        run_tool(asar, td, "--json", "loader", "install", "--quiet")
        with asar.open("rb") as fh:
            header, db = zh.read_header(fh)
            before = {p: zh.read_node(fh, db, n) for p, n in zh.iter_files(header) if "offset" in n}

        proc = run_tool(asar, td, "--json", "loader", "remove")
        assert proc.returncode == 0, proc.stderr
        payload = last_json(proc.stdout)
        assert payload and payload["action"] == "removed", proc.stdout
        assert zh.LOADER_IMPORT_MARK.encode() not in read_index(asar)

        # 其余文件字节不变
        with asar.open("rb") as fh:
            header, db = zh.read_header(fh)
            after = {p: zh.read_node(fh, db, n) for p, n in zh.iter_files(header) if "offset" in n}
        for p, data in before.items():
            if p != zh.MAIN_ENTRY:
                assert after[p] == data, p

        # 未安装时 remove 报 not_installed
        proc2 = run_tool(asar, td, "--json", "loader", "remove")
        payload2 = last_json(proc2.stdout)
        assert payload2 and payload2["action"] == "not_installed"


def test_status_reports_installed_and_modules():
    with tempfile.TemporaryDirectory() as tmp:
        td = Path(tmp)
        asar = td / "app.asar"
        zh.write_asar(asar, make_files())
        make_assets(td)

        proc = run_tool(asar, td, "--json", "loader", "status")
        payload = last_json(proc.stdout)
        assert payload and payload["installed"] is False

        run_tool(asar, td, "--json", "loader", "install", "--quiet")
        payload = last_json(run_tool(asar, td, "--json", "loader", "status").stdout)
        assert payload["installed"] is True
        assert payload["loaderFile"] is True
        assert payload["modules"] == ["folder-full-path.js"]


def test_toggle_writes_enabled_plugins():
    with tempfile.TemporaryDirectory() as tmp:
        td = Path(tmp)
        asar = td / "app.asar"
        zh.write_asar(asar, make_files())
        make_assets(td)
        cfg = td / "zcode-config.json"
        cfg.write_text(
            json.dumps(
                {
                    "plugins": {
                        "enabledPlugins": {
                            "zcode-folder-full-path@zcode-helper-marketplace": True,
                            "zcode-branch-badge@zcode-helper-marketplace": True,
                        }
                    }
                }
            ),
            encoding="utf-8",
        )
        env = {"ZCODE_CONFIG": str(cfg)}

        # off
        proc = run_tool(asar, td, "--json", "loader", "toggle", "branch-badge", "off", extra_env=env)
        assert proc.returncode == 0, proc.stderr
        payload = last_json(proc.stdout)
        assert payload and payload["action"] == "toggled", proc.stdout
        assert payload["enabled"] is False and payload["previous"] is True
        data = json.loads(cfg.read_text())
        assert data["plugins"]["enabledPlugins"]["zcode-branch-badge@zcode-helper-marketplace"] is False
        # 其他插件不受影响
        assert data["plugins"]["enabledPlugins"]["zcode-folder-full-path@zcode-helper-marketplace"] is True

        # toggle（缺省）按当前值取反
        payload = last_json(
            run_tool(asar, td, "--json", "loader", "toggle", "branch-badge", extra_env=env).stdout
        )
        assert payload["enabled"] is True and payload["previous"] is False
        assert json.loads(cfg.read_text())["plugins"]["enabledPlugins"][
            "zcode-branch-badge@zcode-helper-marketplace"
        ] is True


def test_toggle_reports_error_on_broken_config():
    with tempfile.TemporaryDirectory() as tmp:
        td = Path(tmp)
        asar = td / "app.asar"
        zh.write_asar(asar, make_files())
        make_assets(td)
        cfg = td / "zcode-config.json"
        cfg.write_text("{ not json", encoding="utf-8")

        proc = run_tool(asar, td, "--json", "loader", "toggle", "branch-badge", "off", extra_env={"ZCODE_CONFIG": str(cfg)})
        assert proc.returncode == 2
        payload = last_json(proc.stdout)
        assert payload and payload["action"] == "error"


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
