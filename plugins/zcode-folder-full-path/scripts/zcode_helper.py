#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""zcode_helper：给 ZCode 桌面客户端打 UI 补丁的通用引擎（多个插件共用同一份副本）。

原理
----
ZCode 的界面代码打包在 app.asar 里。本工具解析 asar 头部，按补丁定义定位
目标 JS 文件，对其中一小段字节做**等长原地替换**（新内容不足原长度时用空格
补齐）。因为不改变文件大小和任何 offset，所以不需要重打包 300MB+ 的归档，
只写入目标位置的几百字节；原始字节记录在 state.json 中，可随时精确还原。

补丁的 find 里可以用 {{ident}} 通配一个压缩后的 JS 标识符（函数名等）。
ZCode 每次升级都会重新压缩 bundle 导致这些名字变化，用通配符后补丁不必
跟着版本逐个手改。

用法
----
    python3 zcode_helper.py status             # 查看补丁状态
    python3 zcode_helper.py list               # 列出可用补丁
    python3 zcode_helper.py apply              # 应用全部补丁
    python3 zcode_helper.py apply --patch ID   # 只应用指定补丁
    python3 zcode_helper.py restore            # 还原全部已应用补丁
    python3 zcode_helper.py restore --patch ID # 只还原指定补丁
    python3 zcode_helper.py auto               # 仅修复“曾应用过但已失效”的补丁（供 hook 调用）
    python3 zcode_helper.py doctor             # 诊断 asar 结构与补丁定位

通用参数：--asar PATH  --data-dir PATH  --json  --quiet

退出码
------
status/auto/doctor: 0 表示所有补丁已应用或无需处理；1 表示有未应用/失效补丁；
                    2 表示读取或写入失败。
apply/restore:      0 成功；1 部分失败；2 失败。
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import shutil
import socket
import struct
import subprocess
import sys
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

IS_WIN = sys.platform == "win32"
IS_MAC = sys.platform == "darwin"

if IS_MAC:
    ASAR_DEFAULT = Path("/Applications/ZCode.app/Contents/Resources/app.asar")
elif IS_WIN:
    ASAR_DEFAULT = Path(r"C:\Program Files\ZCode\resources\app.asar")
else:
    ASAR_DEFAULT = Path("/opt/ZCode/resources/app.asar")

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

HEADER_PREFIX = 4
STATE_SCHEMA = 1

# ------------------------------------------------ 主进程 loader（运行时注入）
# asar 内只装一行 dynamic import() 指针，loader 本体与渲染模块都在磁盘上，
# 之后改功能代码不再触碰 asar。LOADER_HOME 固定旧引擎数据目录，与 spec 一致；
# 资产源默认为本插件目录的 loader/，测试可用环境变量重定向到临时目录。
LOADER_HOME = Path(os.environ.get("ZCODE_LOADER_HOME") or Path.home() / ".zcode" / "zcode-helper")
LOADER_ASSETS_DIR = Path(os.environ.get("ZCODE_LOADER_ASSETS") or PLUGIN_ROOT / "loader")
MAIN_ENTRY = "out/main/index.js"
LOADER_IMPORT_MARK = "__zch_loader__"
# ZCode 自己保存插件开关的位置（loader 监听它）。注意：实测 ZCode 插件市场的
# 开关 UI 在这个版本里并不写这个文件，所以另提供 `loader toggle` 直接写它。
ZCODE_CONFIG_PATH = Path(
    os.environ.get("ZCODE_CONFIG") or Path.home() / ".zcode" / "cli" / "config.json"
)


class AsarError(RuntimeError):
    pass


# ---------------------------------------------------------------- asar 读取


def read_header(fh) -> tuple[dict, int]:
    """返回 (header dict, 数据区起始偏移)。"""
    fh.seek(0)
    raw = fh.read(16)
    if len(raw) != 16:
        raise AsarError("文件太小，不是有效的 asar")
    prefix, pickle_size, _header_object_size, json_size = struct.unpack("<4I", raw)
    if prefix != HEADER_PREFIX:
        raise AsarError(f"asar pickle 前缀异常: {prefix}")
    if json_size <= 0 or json_size > 64 * 1024 * 1024:
        raise AsarError(f"asar header 长度异常: {json_size}")
    payload = fh.read(json_size)
    if len(payload) != json_size:
        raise AsarError("asar header 被截断")
    try:
        header = json.loads(payload)
    except ValueError as exc:
        raise AsarError(f"asar header 不是合法 JSON: {exc}") from exc
    return header, 8 + pickle_size


def iter_files(node: dict, prefix: str = ""):
    """yield (asar 内路径, 文件节点)。路径不带前导斜杠。"""
    for name, child in node.get("files", {}).items():
        path = f"{prefix}/{name}" if prefix else name
        if "files" in child:
            yield from iter_files(child, path)
        else:
            yield path, child


def read_node(fh, data_base: int, node: dict) -> bytes:
    size = int(node["size"])
    fh.seek(data_base + int(node["offset"]))
    data = fh.read(size)
    if len(data) != size:
        raise AsarError("读取 asar 文件内容时被截断")
    return data


def read_asar_file(fh, data_base: int, header: dict, want: str) -> bytes | None:
    for path, node in iter_files(header):
        if path == want.lstrip("/"):
            return read_node(fh, data_base, node)
    return None


def zcode_version(fh, data_base: int, header: dict) -> str | None:
    raw = read_asar_file(fh, data_base, header, "package.json")
    if not raw:
        return None
    try:
        return json.loads(raw.decode("utf-8")).get("version")
    except (ValueError, UnicodeDecodeError):
        return None


# ---------------------------------------------------------------- asar 整包重打包


def asar_integrity(data: bytes, block_size: int = 4194304) -> dict:
    """Electron asar per-file integrity 块：整文件 hash + 分块 hash。"""
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


def build_header(files: dict[str, bytes], unpacked: dict[str, dict] | None = None) -> dict:
    """按路径排序依次分配 offset，构建 asar header。

    unpacked：{"unpacked": true} 等无 offset 的节点，原样保留（内容在
    app.asar.unpacked 目录，不在归档内，重打包不得丢失条目）。
    """
    unpacked = unpacked or {}
    root: dict = {"files": {}}
    offset = 0
    for path in sorted({**files, **unpacked}):
        parts = path.split("/")
        node = root["files"]
        for part in parts[:-1]:
            node = node.setdefault(part, {"files": {}})["files"]
        if path in unpacked:
            node[parts[-1]] = unpacked[path]
            continue
        data = files[path]
        node[parts[-1]] = {
            "size": len(data),
            "offset": str(offset),
            "integrity": asar_integrity(data),
        }
        offset += len(data)
    return root


def write_asar(path: Path, files: dict[str, bytes], unpacked: dict[str, dict] | None = None) -> None:
    """从头写一个 asar（repack 与测试共用）。

    header 布局与 read_header 严格对齐：prefix=4，
    pickle_size = 4 + header_object_size，
    data_base = 8 + pickle_size = 16 + json_size + padding。
    """
    payload = json.dumps(
        build_header(files, unpacked), ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    padding = b" " * ((-len(payload)) % 4)
    json_size = len(payload)
    header_object_size = 4 + json_size + len(padding)
    pickle_size = HEADER_PREFIX + header_object_size
    with path.open("wb") as fh:
        fh.write(struct.pack("<4I", HEADER_PREFIX, pickle_size, header_object_size, json_size))
        fh.write(payload)
        fh.write(padding)
        for p in sorted(files):
            fh.write(files[p])


def repack_asar(asar: Path, edits: dict[str, bytes]) -> None:
    """整包重打包：edits 为 {asar 内路径: 新内容}，空 edits 等价于原样重写。

    无 offset 的 unpacked 节点原样保留。原子替换：先写同目录 .tmp 再
    os.replace。重算全部 integrity（fuse 虽已关闭，重算可兜底未来变化）。
    """
    with asar.open("rb") as fh:
        header, data_base = read_header(fh)
        files: dict[str, bytes] = {}
        unpacked: dict[str, dict] = {}
        for p, n in iter_files(header):
            if "offset" not in n:
                unpacked[p] = dict(n)
                continue
            files[p] = read_node(fh, data_base, n)
    files.update(edits)
    tmp = asar.parent / (asar.name + ".zch-repack.tmp")
    write_asar(tmp, files, unpacked)
    os.replace(tmp, asar)


# ---------------------------------------------------------------- 补丁定义


def load_patches(patch_dir: Path = PATCH_DIR) -> list[dict]:
    patches = []
    for path in sorted(patch_dir.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise AsarError(f"读取补丁定义失败 {path}: {exc}") from exc
        data.setdefault("id", path.stem)
        patches.append(data)
    return patches


def candidates(header: dict, locate: dict) -> list[tuple[str, dict]]:
    prefix = locate.get("pathPrefix", "")
    suffix = locate.get("pathSuffix", "")
    min_size = int(locate.get("minSize", 0))
    found = []
    for path, node in iter_files(header):
        if "size" not in node or node.get("unpacked"):
            continue
        if prefix and not path.startswith(prefix):
            continue
        if suffix and not path.endswith(suffix):
            continue
        if int(node["size"]) < min_size:
            continue
        found.append((path, node))
    found.sort(key=lambda item: int(item[1]["size"]), reverse=True)
    return found


def locate(fh, data_base: int, header: dict, patch: dict):
    """返回 (路径, 节点, 内容) 或 None。"""
    markers = [m.encode("utf-8") for m in patch.get("locate", {}).get("contains", [])]
    for path, node in candidates(header, patch.get("locate", {})):
        data = read_node(fh, data_base, node)
        if all(marker in data for marker in markers):
            return path, node, data
    return None


IDENT_TOKEN = "{{ident}}"
# JS 标识符：{{ident}} 可匹配到的形态（压缩后的函数名，如 kv、ey、aBc）
IDENT_PATTERN = rb"[A-Za-z_$][A-Za-z0-9_$]*"


def find_regex(rep: dict) -> "re.Pattern | None":
    """find 含 {{ident}} 时返回正则，否则返回 None（按字面量匹配）。

    ZCode 每次升级都会重新压缩 bundle，被调用函数的名字会变
    （3.16.3 是 kv，3.17.1 是 ey）。用 {{ident}} 把这一段写成通配，
    补丁就不必跟着版本逐个手改。
    """
    find = rep["find"]
    if IDENT_TOKEN not in find:
        return None
    parts = [re.escape(part.encode("utf-8")) for part in find.split(IDENT_TOKEN)]
    return re.compile(IDENT_PATTERN.join(parts))


def find_matches(data: bytes, rep: dict) -> list[bytes]:
    """返回 find 在 data 中命中的片段（通配符按实际字节展开）。"""
    pattern = find_regex(rep)
    if pattern is None:
        needle = rep["find"].encode("utf-8")
        if not needle:
            raise AsarError("补丁 find 为空")
        return [needle] * data.count(needle)
    return [match.group(0) for match in pattern.finditer(data)]


DATA_DIR_TOKEN = "{{data_dir}}"


def expand_replace(rep: dict) -> str:
    """replace 中的 {{data_dir}} 展开为本插件的数据目录绝对路径。

    只作用于 replace（find 按字面量匹配，不做展开）；展开后若超过命中片段
    长度，由 applied_form 的等长校验报错。
    """
    return rep["replace"].replace(DATA_DIR_TOKEN, str(DATA_DIR))


def applied_form(rep: dict, matched: bytes) -> bytes:
    """把 replace 用空格补到与命中片段等长，用于等长原地替换。"""
    replace = expand_replace(rep).encode("utf-8")
    if len(replace) > len(matched):
        raise AsarError(
            f"补丁 replace（{len(replace)} 字节）比目标片段（{len(matched)} 字节）长，"
            "无法等长原地替换"
        )
    return replace + b" " * (len(matched) - len(replace))


def replacement_state(data: bytes, rep: dict) -> tuple[list[bytes], int]:
    """返回 (find 命中片段列表, 已应用片段出现次数)。"""
    matches = find_matches(data, rep)
    if find_regex(rep) is None:
        return matches, data.count(applied_form(rep, rep["find"].encode("utf-8")))
    # 通配命中的长度随压缩变量名变化，没法用固定补齐后的字节计数，
    # 改为统计固定的 replace 前缀（已应用时其后跟若干补位空格）。
    return matches, data.count(expand_replace(rep).encode("utf-8"))


def patch_state(fh, data_base: int, header: dict, patch: dict) -> tuple[str, str | None, dict | None]:
    """返回 (状态, 目标文件路径, 定位到的 (path,node,data))。

    状态：applied / not_applied / partial / target_not_found / pattern_not_found
    """
    located = locate(fh, data_base, header, patch)
    if located is None:
        return "target_not_found", None, None
    path, node, data = located
    applied_count = 0
    missing = 0
    for rep in patch.get("replacements", []):
        matches, n_applied = replacement_state(data, rep)
        n_find = len(matches)
        if n_applied >= 1 and n_find == 0:
            applied_count += 1
        elif n_find >= 1:
            missing += 1
        else:
            return "pattern_not_found", path, located
    if missing == 0 and applied_count == len(patch.get("replacements", [])):
        return "applied", path, located
    if applied_count == 0:
        return "not_applied", path, located
    return "partial", path, located


# ---------------------------------------------------------------- 状态文件


def load_state() -> dict:
    try:
        data = json.loads(STATE_PATH.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            data.setdefault("patches", {})
            return data
    except (OSError, ValueError):
        pass
    return {"schemaVersion": STATE_SCHEMA, "patches": {}}


def save_state(state: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    state["schemaVersion"] = STATE_SCHEMA
    tmp = STATE_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, STATE_PATH)


def load_config() -> dict:
    try:
        data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


# ---------------------------------------------------------------- payload 与本地服务


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


# ---------------------------------------------------------------- 应用/还原


def check_writable(asar: Path) -> bool:
    return os.access(asar, os.W_OK)


def apply_patch(fh, data_base: int, header: dict, patch: dict, state: dict) -> dict:
    """应用单个补丁；返回 {id, status, applied:[...], message}。"""
    patch_id = patch["id"]
    result = {"id": patch_id, "title": patch.get("title", patch_id), "applied": [], "skipped": []}

    located = locate(fh, data_base, header, patch)
    if located is None:
        result["status"] = "target_not_found"
        result["message"] = "未找到目标文件（ZCode 版本可能已变化，补丁需要适配）"
        return result

    path, node, _data = located
    records = []
    for rep in patch.get("replacements", []):
        # 每次都重新读取，避免同一文件多条替换时相互影响
        data = read_node(fh, data_base, node)
        matches, n_applied = replacement_state(data, rep)
        expected = int(rep.get("expectedCount", 1))
        if not matches and n_applied >= 1:
            result["skipped"].append({"reason": "already_applied"})
            continue
        if len(matches) != expected:
            result["status"] = "pattern_not_found"
            result["message"] = (
                f"目标片段出现 {len(matches)} 次（预期 {expected} 次），"
                "ZCode 代码可能已变化，未做任何修改"
            )
            return result
        original = matches[0]
        applied = applied_form(rep, original)
        index = data.find(original)
        absolute = data_base + int(node["offset"]) + index
        fh.seek(absolute)
        fh.write(applied)
        fh.flush()
        os.fsync(fh.fileno())
        fh.seek(absolute)
        if fh.read(len(applied)) != applied:
            result["status"] = "write_failed"
            result["message"] = "写入后校验失败，未继续修改"
            return result
        records.append(
            {
                "file": path,
                "offset": absolute,
                "size": len(original),
                "original": base64.b64encode(original).decode("ascii"),
                "applied": base64.b64encode(applied).decode("ascii"),
            }
        )
        result["applied"].append({"file": path, "offset": absolute})

    if records:
        result["status"] = "applied"
        entry = state.setdefault("patches", {}).setdefault(patch_id, {})
        new_keys = {(record["file"], record["offset"]) for record in records}
        kept = [
            record
            for record in entry.get("records", [])
            if (record["file"], record["offset"]) not in new_keys
        ]
        entry["records"] = kept + records
        entry["version"] = patch.get("version", 1)
        entry["appliedAt"] = now_iso()
        entry["zcodeVersion"] = zcode_version(fh, data_base, header)
        entry["asar"] = str(fh.name)
    elif result["skipped"]:
        result["status"] = "already_applied"
    else:
        result["status"] = "noop"
    return result


def restore_patch(fh, patch: dict, state: dict, asar: Path) -> dict:
    patch_id = patch["id"]
    entry = state.get("patches", {}).get(patch_id)
    result = {"id": patch_id, "title": patch.get("title", patch_id), "restored": [], "skipped": []}
    if not entry or not entry.get("records"):
        result["status"] = "not_applied"
        result["message"] = "没有本补丁的安装记录"
        return result

    for record in entry["records"]:
        size = int(record["size"])
        original = base64.b64decode(record["original"])
        applied = base64.b64decode(record["applied"])
        fh.seek(int(record["offset"]))
        current = fh.read(size)
        if current == applied:
            fh.seek(int(record["offset"]))
            fh.write(original)
            fh.flush()
            os.fsync(fh.fileno())
            result["restored"].append({"file": record["file"], "offset": record["offset"]})
        elif current == original:
            result["skipped"].append({"reason": "already_restored"})
        else:
            result["skipped"].append(
                {"reason": "content_changed", "file": record["file"], "offset": record["offset"]}
            )

    if result["restored"]:
        state.get("patches", {}).pop(patch_id, None)
        result["status"] = "restored"
    elif result["skipped"] and all(s["reason"] == "already_restored" for s in result["skipped"]):
        state.get("patches", {}).pop(patch_id, None)
        result["status"] = "already_restored"
    else:
        result["status"] = "mismatch"
        result["message"] = "记录位置的内容已变化（ZCode 可能已升级），未做修改"
    return result


# ---------------------------------------------------------------- 命令实现


@contextmanager
def open_asar(path: Path):
    if not path.is_file():
        raise AsarError(f"找不到 app.asar: {path}")
    fh = open(path, "r+b")
    try:
        header, data_base = read_header(fh)
        yield fh, header, data_base
    finally:
        fh.close()


def cmd_status(args) -> int:
    asar = Path(args.asar)
    try:
        with open_asar(asar) as pair:
            fh, header, data_base = pair
            version = zcode_version(fh, data_base, header)
            rows = []
            needs_attention = False
            for patch in load_patches():
                state, path, _located = patch_state(fh, data_base, header, patch)
                if state in ("not_applied", "partial", "pattern_not_found"):
                    needs_attention = True
                rows.append(
                    {
                        "id": patch["id"],
                        "title": patch.get("title", patch["id"]),
                        "description": patch.get("description", ""),
                        "state": state,
                        "file": path,
                    }
                )
    except (OSError, AsarError) as exc:
        print(f"读取失败：{exc}", file=sys.stderr)
        return 2

    if args.json:
        print(
            json.dumps(
                {
                    "ok": True,
                    "asar": str(asar),
                    "zcodeVersion": version,
                    "patches": rows,
                    "needsAttention": needs_attention,
                },
                ensure_ascii=False,
            )
        )
        return 1 if needs_attention else 0

    if not args.quiet:
        print(f"ZCode {version or '未知版本'}")
        print(f"asar  {asar}")
        if HAS_DAEMON:
            daemon_port = find_daemon_port(timeout=0.2)
            if daemon_port:
                print(f"分支服务  运行中（127.0.0.1:{daemon_port}）")
            else:
                print("分支服务  未运行（git 分支徽章不会显示；运行 daemon start 启动）")
        print()
    labels = {
        "applied": "已应用",
        "not_applied": "未应用",
        "partial": "部分应用",
        "target_not_found": "目标文件未找到（需要适配新版本）",
        "pattern_not_found": "目标代码未找到（需要适配新版本）",
    }
    for row in rows:
        mark = {"applied": "✓", "not_applied": "·"}.get(row["state"], "!")
        print(f"[{mark}] {row['title']}  ({row['id']})")
        print(f"    状态：{labels.get(row['state'], row['state'])}")
        if row["file"]:
            print(f"    文件：{row['file']}")
    if not args.quiet:
        print()
        print("提示：应用补丁后需要完全退出并重新打开 ZCode 才会生效。")
    return 1 if needs_attention else 0


def cmd_apply(args) -> int:
    asar = Path(args.asar)
    if not check_writable(asar):
        print(
            f"没有写入权限：{asar}\n"
            "可以把 ZCode 拖到用户目录（如 ~/Applications）后使用 --asar 指向它，"
            "或用 sudo 运行本脚本。",
            file=sys.stderr,
        )
        return 2
    patches = load_patches()
    if args.patch:
        patches = [p for p in patches if p["id"] == args.patch]
        if not patches:
            print(f"找不到补丁：{args.patch}", file=sys.stderr)
            return 2

    state = load_state()
    results = []
    try:
        with open_asar(asar) as pair:
            fh, header, data_base = pair
            for patch in patches:
                results.append(apply_patch(fh, data_base, header, patch, state))
            save_state(state)
    except (OSError, AsarError) as exc:
        print(f"应用失败：{exc}", file=sys.stderr)
        return 2

    synced = sync_payload_files()

    exit_code = 0
    for result in results:
        status = result["status"]
        if status in ("applied", "already_applied"):
            detail = ""
            if result["applied"]:
                detail = " → " + ", ".join(item["file"] for item in result["applied"])
            print(f"✓ {result['title']}：已应用{detail}")
        elif status == "target_not_found":
            print(f"! {result['title']}：{result['message']}", file=sys.stderr)
            exit_code = 1
        elif status == "pattern_not_found":
            print(f"! {result['title']}：{result['message']}", file=sys.stderr)
            exit_code = 1
        else:
            print(f"· {result['title']}：无需修改")
    if synced:
        print(f"已同步注入脚本：{', '.join(synced)} → {DATA_DIR / 'inject'}")
    if exit_code == 0:
        print()
        print("完成。请完全退出 ZCode（菜单 → 退出），再重新打开，补丁才会生效。")
    return exit_code


def cmd_restore(args) -> int:
    asar = Path(args.asar)
    if not check_writable(asar):
        print(f"没有写入权限：{asar}", file=sys.stderr)
        return 2
    patches = load_patches()
    if args.patch:
        patches = [p for p in patches if p["id"] == args.patch]
        if not patches:
            print(f"找不到补丁：{args.patch}", file=sys.stderr)
            return 2

    state = load_state()
    results = []
    try:
        with open_asar(asar) as pair:
            fh, _header, _data_base = pair
            for patch in patches:
                results.append(restore_patch(fh, patch, state, asar))
            save_state(state)
    except (OSError, AsarError) as exc:
        print(f"还原失败：{exc}", file=sys.stderr)
        return 2

    exit_code = 0
    for result in results:
        status = result["status"]
        if status == "restored":
            print(f"✓ {result['title']}：已还原（{len(result['restored'])} 处）")
        elif status in ("already_restored", "not_applied"):
            print(f"· {result['title']}：{result.get('message') or '无需还原'}")
        else:
            print(f"! {result['title']}：{result.get('message') or status}", file=sys.stderr)
            exit_code = 1
    if exit_code == 0:
        print()
        print("完成。请完全退出 ZCode 后重新打开。")
    return exit_code


def cmd_auto(args) -> int:
    """只修复 state 中记录过、但当前失效的补丁（用于 SessionStart hook）。"""
    asar = Path(args.asar)
    state = load_state()
    patches = load_patches()
    known = set(state.get("patches", {}))
    if not known:
        if args.json:
            print(json.dumps({"ok": True, "action": "none", "reason": "never_applied"}))
        return 0
    if not check_writable(asar):
        if args.json:
            print(json.dumps({"ok": False, "action": "none", "reason": "not_writable"}))
        return 1

    repaired = []
    broken = []
    try:
        with open_asar(asar) as pair:
            fh, header, data_base = pair
            for patch in patches:
                if patch["id"] not in known:
                    continue
                state_now, _path, _located = patch_state(fh, data_base, header, patch)
                if state_now in ("applied", "target_not_found", "pattern_not_found"):
                    if state_now != "applied":
                        broken.append({"id": patch["id"], "state": state_now})
                    continue
                result = apply_patch(fh, data_base, header, patch, state)
                if result["status"] in ("applied", "already_applied"):
                    repaired.append(patch["id"])
                else:
                    broken.append({"id": patch["id"], "state": result["status"]})
            save_state(state)
    except (OSError, AsarError) as exc:
        if args.json:
            print(json.dumps({"ok": False, "action": "none", "reason": str(exc)}))
        return 1

    if args.json:
        print(
            json.dumps(
                {
                    "ok": True,
                    "action": "repaired" if repaired else "none",
                    "repaired": repaired,
                    "broken": broken,
                },
                ensure_ascii=False,
            )
        )
    else:
        if repaired:
            print(f"已自动修复补丁：{', '.join(repaired)}")
        if broken:
            print(f"以下补丁需要适配新版本：{', '.join(b['id'] for b in broken)}")
    return 0 if not broken else 1


def cmd_list(args) -> int:
    for patch in load_patches():
        print(f"{patch['id']}\t{patch.get('version', 1)}\t{patch.get('title', '')}")
    return 0


# ---------------------------------------------------------------- 主进程 loader 命令


def loader_import_line() -> str:
    """写入 out/main/index.js 尾部的 dynamic import() 指针行。

    activate() 由 loader.cjs 导出；失败只打日志，不影响主进程。
    """
    return (
        "\n// " + LOADER_IMPORT_MARK + "\n"
        'import("' + str(LOADER_HOME / "loader.cjs") + '")'
        ".then(function(m){return m.activate();})"
        '.catch(function(e){console.error("[zch-loader]", e);});\n'
    )


def sync_loader_assets() -> list[str]:
    """把 loader 资产（loader.cjs + modules/*.js）拷到 LOADER_HOME。"""
    copied: list[str] = []
    src_loader = LOADER_ASSETS_DIR / "loader.cjs"
    if src_loader.is_file():
        LOADER_HOME.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src_loader, LOADER_HOME / "loader.cjs")
        copied.append("loader.cjs")
    src_modules = LOADER_ASSETS_DIR / "modules"
    if src_modules.is_dir():
        dst = LOADER_HOME / "modules"
        dst.mkdir(parents=True, exist_ok=True)
        for js in sorted(src_modules.glob("*.js")):
            shutil.copyfile(js, dst / js.name)
            copied.append("modules/" + js.name)
    return copied


def module_plugin_key(enabled_map: dict, module: str) -> str:
    """找该 module 在 enabledPlugins 里的插件 id（形如 zcode-<module>@<market>）。"""
    for key in enabled_map:
        if key == "zcode-" + module or key.startswith("zcode-" + module + "@"):
            return key
    return "zcode-" + module + "@zcode-helper-marketplace"


def set_module_enabled(module: str, state: str) -> dict:
    """直接写 ZCode config 的 plugins.enabledPlugins，loader 1s 内拾取生效。

    state: on / off / toggle（缺省按当前值取反）。
    用「临时文件 + os.replace」原子替换，与 ZCode 自己的写法一致。
    """
    try:
        data = json.loads(ZCODE_CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return {"action": "error", "reason": f"读取 {ZCODE_CONFIG_PATH} 失败: {exc}"}
    if not isinstance(data, dict):
        return {"action": "error", "reason": "config.json 结构异常"}
    plugins = data.setdefault("plugins", {})
    if not isinstance(plugins, dict):
        return {"action": "error", "reason": "config.plugins 结构异常"}
    enabled_map = plugins.setdefault("enabledPlugins", {})
    if not isinstance(enabled_map, dict):
        return {"action": "error", "reason": "config.plugins.enabledPlugins 结构异常"}

    key = module_plugin_key(enabled_map, module)
    current = bool(enabled_map.get(key))
    target = (not current) if state == "toggle" else (state == "on")
    enabled_map[key] = target

    tmp = ZCODE_CONFIG_PATH.with_name(ZCODE_CONFIG_PATH.name + ".zch-tmp")
    try:
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, ZCODE_CONFIG_PATH)
    except OSError as exc:
        return {"action": "error", "reason": f"写入 {ZCODE_CONFIG_PATH} 失败: {exc}"}

    return {
        "action": "toggled",
        "module": module,
        "plugin": key,
        "enabled": target,
        "previous": current,
    }


def cmd_loader(args) -> int:
    action = args.loader_action
    if action == "toggle":
        result = set_module_enabled(args.module, args.state)
        if result.get("action") == "error":
            print(f"loader toggle 失败：{result.get('reason')}", file=sys.stderr)
        elif not args.json:
            print(
                f"✓ {result['module']} 已{'开启' if result['enabled'] else '关闭'}"
                f"（{result['plugin']}）。loader 会在 1 秒内应用；"
                "若 2 秒后仍无变化，查看 ~/.zcode/zcode-helper/loader.log。"
            )
        if args.json:
            print(json.dumps(result, ensure_ascii=False))
        return 0 if result.get("action") != "error" else 2

    asar = Path(args.asar)
    try:
        with open_asar(asar) as pair:
            fh, header, data_base = pair
            index = read_asar_file(fh, data_base, header, MAIN_ENTRY) or b""
        line = loader_import_line().encode()

        if action == "install":
            synced = sync_loader_assets()
            if LOADER_IMPORT_MARK.encode() in index:
                result = {"action": "already", "synced": synced}
            else:
                if not check_writable(asar):
                    result = {"action": "error", "reason": "not_writable"}
                else:
                    repack_asar(asar, {MAIN_ENTRY: index + line})
                    result = {"action": "installed", "synced": synced}
        elif action == "remove":
            if LOADER_IMPORT_MARK.encode() not in index:
                result = {"action": "not_installed"}
            else:
                if not check_writable(asar):
                    result = {"action": "error", "reason": "not_writable"}
                else:
                    repack_asar(asar, {MAIN_ENTRY: index.replace(line, b"")})
                    result = {"action": "removed"}
        else:  # status
            modules_dir = LOADER_HOME / "modules"
            result = {
                "installed": LOADER_IMPORT_MARK.encode() in index,
                "loaderFile": (LOADER_HOME / "loader.cjs").is_file(),
                "modules": sorted(p.name for p in modules_dir.glob("*.js")) if modules_dir.is_dir() else [],
            }
    except (OSError, AsarError) as exc:
        result = {"action": "error", "reason": str(exc)}

    if result.get("action") == "error":
        print(f"loader {action} 失败：{result.get('reason')}", file=sys.stderr)
    elif action == "install" and result["action"] == "installed":
        print("✓ loader 指针已写入 app.asar。请完全退出 ZCode 后重新打开一次"
              "（此后插件开关即时生效，不再需要重启）。")
    elif action == "remove" and result["action"] == "removed":
        print("✓ loader 指针已剥离。请完全退出 ZCode 后重新打开。")
    elif action == "status" and not args.json:
        state = "已安装" if result["installed"] else "未安装"
        print(f"loader   {state}   loader 文件：{'在位' if result['loaderFile'] else '缺失'}"
              f"   模块：{', '.join(result['modules']) or '无'}")

    if args.json:
        print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("action") != "error" else 2


def cmd_doctor(args) -> int:
    asar = Path(args.asar)
    try:
        with open(asar, "rb") as fh:
            header, data_base = read_header(fh)
            version = zcode_version(fh, data_base, header)
            file_count = sum(1 for _ in iter_files(header))
            print(f"asar       {asar}")
            print(f"大小       {asar.stat().st_size} bytes")
            print(f"数据区偏移 {data_base}")
            print(f"文件数     {file_count}")
            print(f"ZCode      {version or '未知'}")
            print(f"可写       {check_writable(asar)}")
            if HAS_DAEMON:
                daemon_port = find_daemon_port(timeout=0.2)
                print(f"分支服务   {'运行中（127.0.0.1:%d）' % daemon_port if daemon_port else '未运行'}")
            for patch in load_patches():
                state, path, _located = patch_state(fh, data_base, header, patch)
                print(f"补丁       {patch['id']}: {state} ({path or '未定位'})")
    except (OSError, AsarError) as exc:
        print(f"诊断失败：{exc}", file=sys.stderr)
        return 2
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="ZCode 客户端 UI 补丁工具")
    parser.add_argument(
        "--asar",
        default=os.environ.get("ZCODE_ASAR") or str(ASAR_DEFAULT),
        help="app.asar 路径（也可用 ZCODE_ASAR 环境变量）",
    )
    parser.add_argument("--json", action="store_true", help="输出 JSON")
    parser.add_argument("--quiet", action="store_true", help="精简输出")
    parser.add_argument("--data-dir", help="覆盖数据目录（默认 ~/.zcode/<插件名>）")

    sub = parser.add_subparsers(dest="command")
    sub.add_parser("status", help="查看补丁状态").set_defaults(func=cmd_status)

    p_apply = sub.add_parser("apply", help="应用补丁")
    p_apply.add_argument("--patch", help="只处理指定补丁 ID")
    p_apply.set_defaults(func=cmd_apply)

    p_restore = sub.add_parser("restore", help="还原补丁")
    p_restore.add_argument("--patch", help="只处理指定补丁 ID")
    p_restore.set_defaults(func=cmd_restore)

    p_auto = sub.add_parser("auto", help="自动修复曾应用过但已失效的补丁")
    p_auto.set_defaults(func=cmd_auto)

    p_loader = sub.add_parser("loader", help="主进程 loader 装卸（install/remove/status）")
    p_loader_sub = p_loader.add_subparsers(dest="loader_action", required=True)
    p_loader_install = p_loader_sub.add_parser("install", help="同步资产并写入指针（幂等）")
    p_loader_install.add_argument("--quiet", action="store_true", help="成功时不打印提示")
    p_loader_install.set_defaults(func=cmd_loader, loader_action="install")
    p_loader_sub.add_parser("remove", help="剥离指针（对称回滚）").set_defaults(func=cmd_loader, loader_action="remove")
    p_loader_sub.add_parser("status", help="查看 loader 安装状态").set_defaults(func=cmd_loader, loader_action="status")
    p_loader_toggle = p_loader_sub.add_parser(
        "toggle", help="开关某个 UI 模块（直接写 ZCode config，1s 内生效）"
    )
    p_loader_toggle.add_argument("module", choices=["folder-full-path", "branch-badge"])
    p_loader_toggle.add_argument(
        "state", nargs="?", default="toggle", choices=["on", "off", "toggle"]
    )
    p_loader_toggle.set_defaults(func=cmd_loader, loader_action="toggle")

    if HAS_DAEMON:
        p_daemon = sub.add_parser("daemon", help="本地分支服务（start/status）")
        p_daemon.add_argument("daemon_cmd", choices=["start", "status"])
        p_daemon.set_defaults(func=cmd_daemon)

    sub.add_parser("list", help="列出可用补丁").set_defaults(func=cmd_list)
    sub.add_parser("doctor", help="诊断 asar 与补丁定位").set_defaults(func=cmd_doctor)
    return parser


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.data_dir:
        set_data_dir(args.data_dir)
    if not getattr(args, "func", None):
        parser.print_help()
        return 0
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())