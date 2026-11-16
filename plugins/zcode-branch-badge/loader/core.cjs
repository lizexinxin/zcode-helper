/* zch-loader 核心：ZCode 主进程的注入与开关联动逻辑。
 * 由引导壳 loader.cjs 加载；文件变更时壳会 dispose + 热重载本文件，
 * 因此本文件的更新无需重启 ZCode（壳与 asar 指针才需要）。
 * 职责：作为 observer 读插件开关的合并视图——用户级 ~/.zcode/cli/config.json
 * 打底、工作区项目文件覆盖（工作区从 agent 日志尾部的 workspacePath 发现）
 * ——与 UI 开关显示同源，结构性不漂移；用 webContents.executeJavaScript 向
 * 渲染进程注入/拆除 UI 模块（~/.zcode/zcode-helper/modules/*.js）；扫描插件
 * 缓存自同步新版本资产；每 10 秒向本地分支服务发心跳（daemon 据此在 ZCode
 * 退出后自动退场）。任何异常只写 loader.log，绝不抛向主进程。 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");

const CORE_VERSION = "0.2.7";

const HOME_DIR =
  process.env.ZCODE_LOADER_HOME || path.join(os.homedir(), ".zcode", "zcode-helper");
const MODULES_DIR = path.join(HOME_DIR, "modules");
const CONFIG_PATH =
  process.env.ZCODE_LOADER_CONFIG || path.join(os.homedir(), ".zcode", "cli", "config.json");
const LOG_PATH = path.join(HOME_DIR, "loader.log");
const ACTIVE_PATH = path.join(HOME_DIR, "active.json");
const VERSION_PATH = path.join(HOME_DIR, "version.txt");

/* 自同步：客户端把更新后的插件放到版本化缓存目录；hook 不一定有机会跑
 * （插件被禁用时不注册 hook、会话中途启用也不补注册），所以核心自己扫
 * 缓存取最新版本。目录可用 ZCODE_LOADER_CACHE 重定向（测试）。 */
const PLUGIN_CACHE_ROOT =
  process.env.ZCODE_LOADER_CACHE ||
  path.join(os.homedir(), ".zcode", "cli", "plugins", "cache");
const KNOWN_PLUGIN_DIRS = ["zcode-folder-full-path", "zcode-branch-badge"];

const MODULE_IDS = ["folder-full-path", "branch-badge"];
const PLUGIN_PREFIX = "zcode-";
const DEBOUNCE_MS = 300;
const POLL_MS = 1000;

/* 诊断通道：往 HOME_DIR/probe.js 写一段表达式，loader 下一 tick 会在渲染进程
 * 求值并把结果追加到 probe.out.log（调试完删掉该文件即可停用）。 */
const PROBE_PATH = path.join(HOME_DIR, "probe.js");
const PROBE_OUT = path.join(HOME_DIR, "probe.out.log");

/* 插件启用状态合并（observer 架构）：UI 开关点击经 renderer→window-host→agent
 * RPC（plugins/setEnabled）由 agent 原子写入用户级或工作区级 config，UI 显示
 * 的是合并视图——project 层覆盖 user 层，越靠近工作目录的文件越后合并越优先
 * （对齐 zcode.cjs 的 mergeConfigs/discoverProjectConfigPaths）。核心不再反推
 * UI、不再写 config：读同一份合并视图，显示与生效从同一数据推导，不会漂移。
 * 0.2.6 及之前的「DOM 桥接点击意图 + 写回用户级 config」链路已删除——它的
 * 前提（市场开关不写 config.json）实测是错的：开关写的是工作区级文件。 */

/* 工作区发现：app-server（agent）在本机是共享单例——进程名被改写（zcode-cli）、
 * cwd 固定为数据根（~/.zcode/plugin-workspace）、由 window-host utilityProcess
 * spawn（主进程拦不到 spawn 与 RPC）。工作区路径只出现在 agent 自己的结构化
 * 日志里（~/.zcode/cli/log/zcode-*.jsonl，每条请求的 context 都带
 * workspacePath）。日志是全部会话交错的，「最后一条」未必是当前窗口，所以
 * 不猜当前窗口：取尾部出现过的候选工作区集合，合并视图以「最后被写入的那层」
 * 为准——与用户最近一次拨开关的位置一致。格式变化时安静回落 user-only。 */
const WORKSPACE_SCAN_EVERY_TICKS = 5; // 1s tick 计数，每 5 秒扫一次日志
const MAX_PROJECT_DEPTH = 15; // workdir 向上找 .git 根的层数封顶
const LOG_FULLSCAN_CAP = 64 * 1024 * 1024; // 首扫/换文件全量读的封顶
const MAX_WS_CANDIDATES = 8; // 候选工作区数量上限（新→旧）

/* 心跳：向本地分支服务报活（daemon 的自杀依据）。daemon 只在收到过心跳后
 * 失去心跳才会退出，所以核心活着就要持续发；旧版 daemon 收到 /heartbeat
 * 返回 404 也无副作用。全部失败静默（daemon 未跑是常态）。 */
const HEARTBEAT_PORTS = [39217, 39218, 39219, 39220, 39221];
const HEARTBEAT_EVERY_TICKS = 10; // 1s tick 计数，每 10 秒发一次
const HEARTBEAT_TIMEOUT_MS = 1500;
let heartbeatPort = 0; // 上次心跳成功的端口；0 = 未知，全段重试

function tryHeartbeat(port) {
  return new Promise((resolve) => {
    let settled = false;
    const req = http.get(
      { host: "127.0.0.1", port, path: "/heartbeat", timeout: HEARTBEAT_TIMEOUT_MS },
      (res) => {
        res.resume();
        settled = true;
        resolve(res.statusCode === 200 ? port : 0);
      }
    );
    req.on("timeout", () => {
      req.destroy();
      if (!settled) { settled = true; resolve(0); }
    });
    req.on("error", () => {
      if (!settled) { settled = true; resolve(0); }
    });
  });
}

async function sendHeartbeat(ports) {
  /* 端口段可用参数覆盖（测试）；已知成功端口提到最前，减少无效请求。 */
  const base = ports || HEARTBEAT_PORTS;
  const list =
    heartbeatPort && base.indexOf(heartbeatPort) !== -1
      ? [heartbeatPort].concat(base.filter((p) => p !== heartbeatPort))
      : base;
  for (const port of list) {
    const ok = await tryHeartbeat(port);
    if (ok) {
      heartbeatPort = ok;
      return ok;
    }
  }
  heartbeatPort = 0;
  return 0;
}

let activated = false;
let currentEnabled = [];
let watchTimer = null;
let pollTimer = null;
let configWatchHandle = null;
let heartbeatTicks = 0;
let lastConfigFingerprint = null;
let pollTicks = 0;
let workspaceScanTicks = 0;
let wsCandidates = []; // agent 日志里出现过的候选工作区（LRU：最近出现的在前，封顶）
let lastWsSig = ""; // 候选集合签名（集合变化才触发重算，日志滚动不触发）
let logScanFile = null; // 增量扫描状态：当前扫到的文件与字节偏移
let logScanOffset = 0;

function log(msg) {
  try {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    fs.appendFileSync(LOG_PATH, new Date().toISOString() + " " + msg + "\n");
  } catch (_) { /* 日志失败忽略 */ }
}

function writeActive() {
  /* 激活凭证：hook 读 pid 判活，用来区分「指针已装但 ZCode 未重启」与「已生效」。
   * 每次激活（含热更新重激活）都会刷新，activatedAt 可用于验证热更新发生。 */
  try {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    const tmp = ACTIVE_PATH + ".tmp";
    fs.writeFileSync(
      tmp,
      JSON.stringify({
        pid: process.pid,
        activatedAt: new Date().toISOString(),
        version: 1,
        core: CORE_VERSION,
      })
    );
    fs.renameSync(tmp, ACTIVE_PATH); // 原子替换，避免 hook 读到半截 JSON
  } catch (exc) {
    log("写 active.json 失败: " + (exc && exc.message));
  }
}

function enabledModulesFromMap(map) {
  /* enabledPlugins 键值对（任意层级合并后的）→ 启用的模块列表。
   * 与 agent 判定一致：显式 === true 才算启用（内置插件默认启用集不适用
   * 于本插件——它们不是官方内置）。 */
  const on = new Set();
  for (const [id, enabled] of Object.entries(map || {})) {
    if (enabled !== true) continue;
    const name = String(id).split("@")[0];
    if (name.startsWith(PLUGIN_PREFIX)) on.add(name.slice(PLUGIN_PREFIX.length));
  }
  return MODULE_IDS.filter((m) => on.has(m));
}

function enabledModules(configData) {
  /* 兼容入口：完整 config 对象（{plugins:{enabledPlugins}}）→ 启用模块。
   * 插件 id 形如 "zcode-<模块名>@<market>"。 */
  if (!configData || typeof configData !== "object") return [];
  const ep = (configData.plugins && configData.plugins.enabledPlugins) || {};
  return enabledModulesFromMap(ep);
}

function readUserEnabledMap() {
  /* 用户级 config 的 enabledPlugins。读/解析失败返回 null（未知）——轮询
   * 撞上 ZCode 写 config 的中间态时，误判为「一个都没启用」会把模块全部
   * 拆掉再装回来。 */
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return (data && data.plugins && data.plugins.enabledPlugins) || {};
  } catch (exc) {
    log("读用户级 config 失败: " + (exc && exc.message));
    return null;
  }
}

function readLayerEnabledMap(file) {
  /* 单个项目层配置文件（zcode.json / .zcode/config.json）的 enabledPlugins。
   * 只收存在的文件，读/解析失败视为跳过该层（留痕，不影响其他层）。 */
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (exc) {
    log("读项目配置失败(跳过该层): " + file + " " + (exc && exc.message));
    return null;
  }
  try {
    const data = JSON.parse(raw);
    return (data && data.plugins && data.plugins.enabledPlugins) || {};
  } catch (exc) {
    log("解析项目配置失败(跳过该层): " + file + " " + (exc && exc.message));
    return null;
  }
}

function activeWorkspace() {
  /* 兼容保留：自动模式下没有单一「活动工作区」（见 mergedEnabledMap），
   * 这里返回最新的候选，仅供日志/诊断。 */
  return wsCandidates.length ? wsCandidates[0] : null;
}

function mergedViewFor(ws, user) {
  /* user 打底 + 指定工作区的项目文件按序覆盖，返回 { map, mtime, hasFiles }。
   * mtime 取该项目文件的最新修改时间（= 该层最后一次被写的时间）。 */
  const files = projectConfigFilesFor(ws);
  const map = Object.assign({}, user);
  let mtime = 0;
  for (const f of files) {
    try {
      const st = fs.statSync(f);
      if (st.mtimeMs > mtime) mtime = st.mtimeMs;
    } catch (_) {}
    const layer = readLayerEnabledMap(f);
    if (layer) Object.assign(map, layer);
  }
  return { map: map, mtime: mtime, hasFiles: files.length > 0 };
}

function projectConfigFilesFor(workdir) {
  /* 对齐 agent 的 project 配置发现：从 workdir 向上走到 .git 根（无 .git 则
   * 到 home 为止，层数封顶），根目录在前、workdir 在后；每目录按 zcode.json、
   * .zcode/config.json 顺序收集存在的文件——合并顺序即优先级，越靠近
   * workdir 越后合并、越优先。 */
  const dirs = [];
  let dir = path.resolve(workdir);
  const home = os.homedir();
  for (let depth = 0; dir && depth < MAX_PROJECT_DEPTH; depth++) {
    dirs.push(dir);
    if (fs.existsSync(path.join(dir, ".git"))) break; // 仓库根：到此为止
    const parent = path.dirname(dir);
    if (parent === dir || dir === home) break;
    dir = parent;
  }
  dirs.reverse(); // 根目录在前、workdir 在后
  const files = [];
  for (const d of dirs) {
    for (const name of ["zcode.json", path.join(".zcode", "config.json")]) {
      const f = path.join(d, name);
      try {
        if (fs.statSync(f).isFile()) files.push(f);
      } catch (_) {}
    }
  }
  return files;
}

function mergedEnabledMap(workdir) {
  /* 复刻 agent 的合并语义：user 层打底，project 层按「根→workdir」顺序覆盖。
   * 返回 null 表示用户级未知（保持不拆装语义）。
   * workdir 为字符串（测试）：直接合并该工作区；为数组（测试）：作为候选集；
   * 缺省用模块状态里日志发现出的 wsCandidates。自动模式下多会话日志交错出
   * 多个候选工作区，loader 的模块又是全局的，没法知道「当前窗口」是哪个
   * ——以「最后被写入的那层」为准，与用户最近一次拨开关的位置一致；用户级
   * 更新或候选都没有项目文件（如草稿会话）时回落 user-only。 */
  const user = readUserEnabledMap();
  if (user === null) return null;
  if (typeof workdir === "string") return mergedViewFor(workdir, user).map;
  const candidates = Array.isArray(workdir) ? workdir : wsCandidates;
  let best = null;
  let bestM = 0;
  let userM = 0;
  try {
    userM = fs.statSync(CONFIG_PATH).mtimeMs;
  } catch (_) {}
  for (const ws of candidates) {
    const v = mergedViewFor(ws, user);
    if (!v.hasFiles) continue; // 草稿等工作区没有项目文件：视图就是 user-only
    if (v.mtime > bestM) {
      bestM = v.mtime;
      best = v.map;
    }
  }
  if (userM >= bestM) return user; // 用户级是最近一次写入，或没有任何工作区写入
  return best;
}

function readEnabled() {
  const map = mergedEnabledMap();
  if (map === null) return null;
  return enabledModulesFromMap(map);
}

function configFingerprint() {
  /* 组合指纹：用户级 config + 全部候选工作区的项目层文件 + 候选集合本身，
   * 任一变化都算换过。ZCode 写 config 是「写临时文件 + rename」，rename 之后
   * inode 变化（macOS 上 fs.watch 正是因此失效），mtime/size 一并比对。
   * 用户级暂时不在时返回 null，维持「等它回来再比对」的原语义。 */
  const parts = [];
  try {
    const st = fs.statSync(CONFIG_PATH);
    parts.push("u:" + st.ino + ":" + st.mtimeMs + ":" + st.size);
  } catch (_) {
    return null;
  }
  for (const ws of wsCandidates) {
    for (const f of projectConfigFilesFor(ws)) {
      try {
        const st = fs.statSync(f);
        parts.push(f + "@" + st.ino + ":" + st.mtimeMs + ":" + st.size);
      } catch (_) {}
    }
  }
  if (wsCandidates.length) parts.push("c:" + wsCandidates.join(">"));
  return parts.join("|");
}

function syncFromConfig(why) {
  /* 幂等的状态同步：只在配置指纹变化时重读，返回本次开关发生变化的模块。
   * fs.watch 与轮询都走这里，靠指纹去重，不会重复注入。 */
  const fingerprint = configFingerprint();
  if (fingerprint === null) {
    lastConfigFingerprint = null; // 文件暂时不在：等它回来后重新比对
    return [];
  }
  if (fingerprint === lastConfigFingerprint) return [];
  const next = readEnabled();
  if (next === null) return []; // 读到半截 JSON：不动指纹，下个 tick 重试
  lastConfigFingerprint = fingerprint;
  const changed = MODULE_IDS.filter(
    (id) => currentEnabled.includes(id) !== next.includes(id)
  );
  currentEnabled = next;
  for (const id of changed) {
    log("开关变化: " + id + " → " + (next.includes(id) ? "on" : "off"));
  }
  if (changed.length) applyAll(next, why || "开关变化");
  return changed;
}

function runnerFor(id, on) {
  /* 每次注入都从磁盘现读模块文件：改模块代码，下次注入即用新版。
   * 注意 executeJavaScript 按普通脚本编译，顶层 return 是语法错误，
   * 必须整体包进 IIFE，返回值即 executeJavaScript 的 Promise 结果。 */
  const file = path.join(MODULES_DIR, id + ".js");
  let code;
  try {
    code = fs.readFileSync(file, "utf8");
  } catch (exc) {
    log("读取模块 " + id + " 失败: " + (exc && exc.message));
    return '(function(){return "missing-file";})()';
  }
  const call = on ? 'm.install()||"ok"' : 'm.dispose()||"ok"';
  return (
    "(function(){" +
    "window.__zchModules=window.__zchModules||{};(function(){" + code + "}());" +
    "var m=window.__zchModules[" + JSON.stringify(id) + "];" +
    "return m?(" + call + '):"missing";' +
    "})()"
  );
}

function injectionsFor(state, enabled) {
  /* 每个 webContents 记住各模块上次注入的开关状态，状态没变就不重复注入。
   * 重复注入会先 dispose（拆 style、移除徽章、清缓存）再 install，徽章会闪没
   * 并重新探测 daemon——重放/多时机注入时不能无条件重来。 */
  const plan = [];
  for (const id of MODULE_IDS) {
    const want = enabled.includes(id);
    if (state[id] !== want) plan.push({ id: id, want: want });
  }
  return plan;
}

function stateOf(wc) {
  if (!wc.__zchState) wc.__zchState = {};
  return wc.__zchState;
}

function applyToContents(wc, enabled) {
  if (!wc || wc.isDestroyed()) return;
  let type = "";
  try {
    type = wc.getType();
  } catch (_) {
    return;
  }
  if (type !== "window") return; // 只注主窗口类页面
  let label = "";
  try {
    label = " (" + (wc.getURL() || "").slice(-60) + ")";
  } catch (_) {}
  const state = stateOf(wc);
  const plan = injectionsFor(state, enabled);
  if (!plan.length) return; // 状态未变：什么都不做
  for (const step of plan) {
    const id = step.id;
    const want = step.want;
    // 先记状态，避免并发重复
    state[id] = want;
    wc.executeJavaScript(runnerFor(id, want), true)
      .then((res) => {
        if (typeof res === "string" && (res.indexOf("ok") === 0 || res.indexOf("already") === 0)) {
          log("注入 " + id + "(" + want + ") → " + res + label);
          return;
        }
        // missing / missing-file：页面可能还没就绪，回滚状态让下次重放重试
        delete state[id];
        log("注入 " + id + "(" + want + ") 未生效 → " + res + label);
      })
      .catch((exc) => {
        delete state[id];
        log("注入 " + id + "(" + want + ") 失败: " + (exc && exc.message) + label);
      });
  }
}

function applyAll(enabled, why) {
  try {
    const { webContents } = require("electron");
    const all = webContents.getAllWebContents();
    log("applyAll(" + (why || "") + "): 目标 " + all.length + " 个");
    for (const wc of all) applyToContents(wc, enabled);
  } catch (exc) {
    log("applyAll 失败: " + (exc && exc.message));
  }
}

function replayOnLoad(wc) {
  /* 尽早注入：dom-ready 时 DOM 已就绪、React 还没开始渲染弹窗，此时挂上
   * observer，弹窗一出现就能在 paint 前修正（等到 did-finish-load 再注入，
   * 用户若先点开「编辑项目」，会先看到截断名再被修正）。 */
  wc.on("dom-ready", () => {
    try {
      wc.__zchState = {}; // 新页面、新 JS world：模块都不在了，必须重注
    } catch (_) {
      return;
    }
    log("dom-ready，立即注入");
    applyToContents(wc, currentEnabled);
  });
  /* did-finish-load 兜底重放：dom-ready 注入失败（页面还没就绪返回 missing）
   * 时状态已回滚，这里会重试；状态一致则直接跳过，不会拆掉重建。 */
  wc.on("did-finish-load", () => {
    log("did-finish-load，兜底重放");
    applyToContents(wc, currentEnabled);
  });
}

function runProbe() {
  let code = null;
  try {
    code = fs.readFileSync(PROBE_PATH, "utf8");
  } catch (_) {
    return; // 没有探针文件：常态
  }
  try {
    fs.unlinkSync(PROBE_PATH); // 一次性，避免每 tick 重跑
  } catch (_) {}
  try {
    const { webContents } = require("electron");
    for (const wc of webContents.getAllWebContents()) {
      if (wc.isDestroyed() || wc.getType() !== "window") continue;
      const wrapped =
        "(function(){try{return JSON.stringify(" + code + ");}" +
        "catch(e){return 'PROBE_ERR:'+(e&&e.message);}})()";
      wc.executeJavaScript(wrapped, true)
        .then((res) => {
          try {
            fs.appendFileSync(PROBE_OUT, new Date().toISOString() + " " + res + "\n");
          } catch (_) {}
        })
        .catch((exc) => {
          try {
            fs.appendFileSync(PROBE_OUT, new Date().toISOString() + " 执行失败: " + (exc && exc.message) + "\n");
          } catch (_) {}
        });
    }
    log("probe 已下发");
  } catch (exc) {
    log("probe 失败: " + (exc && exc.message));
  }
}

function agentLogDir() {
  /* agent 结构化日志目录（~/.zcode/cli/log），测试可用环境变量重定向 */
  return (
    process.env.ZCODE_LOADER_LOGDIR || path.join(os.homedir(), ".zcode", "cli", "log")
  );
}

function latestAgentLogPath() {
  /* 今天的 zcode-YYYY-MM-DD.jsonl；不存在则取 mtime 最新的 jsonl（跨天边界） */
  const now = new Date();
  const ymd =
    now.getFullYear() +
    "-" +
    String(now.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(now.getDate()).padStart(2, "0");
  const today = path.join(agentLogDir(), "zcode-" + ymd + ".jsonl");
  try {
    if (fs.statSync(today).isFile()) return today;
  } catch (_) {}
  try {
    let best = null;
    let bestM = 0;
    for (const f of fs.readdirSync(agentLogDir())) {
      if (!/\.jsonl$/.test(f)) continue;
      const p = path.join(agentLogDir(), f);
      let m = 0;
      try {
        m = fs.statSync(p).mtimeMs;
      } catch (_) {
        continue;
      }
      if (m > bestM) {
        bestM = m;
        best = p;
      }
    }
    return best;
  } catch (_) {
    return null;
  }
}

function readRange(file, from, to) {
  /* 读文件 [from, to) 字节区间；出错返回空串 */
  const len = to - from;
  if (len <= 0) return "";
  const buf = Buffer.alloc(len);
  let read = 0;
  try {
    const fd = fs.openSync(file, "r");
    try {
      read = fs.readSync(fd, buf, 0, len, from);
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {
    return "";
  }
  return buf.toString("utf8", 0, read);
}

function tailText(file, bytes) {
  /* 只读文件末尾 bytes 字节（诊断用）；文件不存在返回空串 */
  let st;
  try {
    st = fs.statSync(file);
  } catch (_) {
    return "";
  }
  return readRange(file, Math.max(0, st.size - bytes), st.size);
}

function discoverAgentWorkspace() {
  /* 增量扫描 agent 日志，维护候选工作区集合（LRU，最近出现的在最前）：
   * 首扫/换日志文件/文件被截断时全量读（封顶 64MB），之后只读新增段落——
   * 日志可能很大且 workspacePath 行稀疏，固定尾巴窗口会漏。集合变化时
   * 触发重算；日志写坏或格式变化就维持现状（回落 user-only）。 */
  const file = latestAgentLogPath();
  if (!file) return;
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch (_) {
    return;
  }
  if (file !== logScanFile || size < logScanOffset) {
    logScanFile = file; // 跨天换文件 / 截断：从头扫
    logScanOffset = 0;
  }
  if (size === logScanOffset) return; // 无新内容
  const from =
    logScanOffset === 0 ? Math.max(0, size - LOG_FULLSCAN_CAP) : logScanOffset;
  const text = readRange(file, from, size);
  logScanOffset = size;
  let changed = false;
  const re = /"workspacePath":"([^"]+)"/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const idx = wsCandidates.indexOf(m[1]);
    if (idx > 0) wsCandidates.splice(idx, 1); // 已有：提到最前（LRU）
    if (idx !== 0) {
      wsCandidates.unshift(m[1]);
      changed = true;
      if (wsCandidates.length > MAX_WS_CANDIDATES) {
        wsCandidates.length = MAX_WS_CANDIDATES;
      }
    }
  }
  if (!changed) return;
  const sig = wsCandidates.join(">");
  if (sig === lastWsSig) return;
  lastWsSig = sig;
  log("候选工作区(来自 agent 日志): " + wsCandidates.join(", "));
  syncFromConfig("工作区变化");
}

function semverKey(v) {
  const parts = String(v || "").split(".");
  const num = (i) => {
    const n = parseInt(parts[i], 10);
    return isNaN(n) ? 0 : n;
  };
  return [num(0), num(1), num(2)];
}

function filesEqual(src, dst) {
  /* 逐字节比对：copyFileSync 即便内容相同也会更新 mtime，而引导壳靠
   * inode+mtime 指纹判断核心变化 → 相同内容重拷会白白触发热更新。
   * 0.2.4 发版漏 bump CORE_VERSION，版本比较永远判「有新版」，每秒
   * 重拷 + 每秒热更新死循环；内容一致就跳过拷贝，从根上掐断这类循环。 */
  try {
    const s1 = fs.statSync(src);
    const s2 = fs.statSync(dst);
    if (!s1.isFile() || !s2.isFile() || s1.size !== s2.size) return false;
    return fs.readFileSync(src).equals(fs.readFileSync(dst));
  } catch (_) {
    return false; // 任一文件读不到：当作不同，走正常拷贝
  }
}

function selfSyncFromCache() {
  /* 自同步：扫描插件缓存，发现比自己新的版本就把资产（core.cjs + modules）
   * 拷进 HOME_DIR——core.cjs 变化由引导壳热更新，模块下次注入现读。
   * 引擎侧的 hook 同步有 version.txt 防降级，两条路殊途同归、互不回退。 */
  try {
    let markets = [];
    try {
      markets = fs.readdirSync(PLUGIN_CACHE_ROOT);
    } catch (_) {
      return; // 缓存目录不存在（未装任何市场）：常态
    }
    let best = null;
    for (const market of markets) {
      for (const name of KNOWN_PLUGIN_DIRS) {
        let versions = [];
        try {
          versions = fs.readdirSync(path.join(PLUGIN_CACHE_ROOT, market, name));
        } catch (_) {
          continue;
        }
        for (const v of versions) {
          if (!/^\d+\.\d+\.\d+$/.test(v)) continue;
          const dir = path.join(PLUGIN_CACHE_ROOT, market, name, v, "loader");
          let hasCore = false;
          try {
            hasCore = fs.existsSync(path.join(dir, "core.cjs"));
          } catch (_) {}
          if (!hasCore) continue; // 旧版本缓存没有核心文件，跳过
          if (!best || semverKey(v) > semverKey(best.v)) best = { v: v, dir: dir };
        }
      }
    }
    if (!best || semverKey(best.v) <= semverKey(CORE_VERSION)) return; // 无更新
    const copied = [];
    for (const f of ["loader.cjs", "core.cjs"]) {
      const src = path.join(best.dir, f);
      try {
        if (fs.existsSync(src) && !filesEqual(src, path.join(HOME_DIR, f))) {
          fs.copyFileSync(src, path.join(HOME_DIR, f));
          copied.push(f);
        }
      } catch (_) {}
    }
    try {
      const srcModules = path.join(best.dir, "modules");
      if (fs.existsSync(srcModules)) {
        fs.mkdirSync(MODULES_DIR, { recursive: true });
        for (const f of fs.readdirSync(srcModules)) {
          if (!/\.js$/.test(f)) continue;
          const src = path.join(srcModules, f);
          if (!filesEqual(src, path.join(MODULES_DIR, f))) {
            fs.copyFileSync(src, path.join(MODULES_DIR, f));
            copied.push("modules/" + f);
          }
        }
      }
    } catch (_) {}
    /* version.txt 只在内容变化时写：它无人监听，写坏不致命，但保持零变更
     * 零落盘，日志也只在真有更新时出现。 */
    let versionLogged = false;
    try {
      const mark = best.v + "\n";
      let cur = null;
      try {
        cur = fs.readFileSync(VERSION_PATH, "utf8");
      } catch (_) {}
      if (cur !== mark) {
        fs.writeFileSync(VERSION_PATH, mark);
        versionLogged = true;
      }
    } catch (_) {}
    if (copied.length || versionLogged) {
      log(
        "自同步：发现插件缓存新版本 " + best.v + "，已更新 " +
          (copied.length ? copied.join(", ") : "无文件变化")
      );
    }
  } catch (exc) {
    log("自同步失败: " + (exc && exc.message));
  }
}

function watchConfig() {
  function schedule(why) {
    if (watchTimer) clearTimeout(watchTimer);
    watchTimer = setTimeout(() => {
      watchTimer = null;
      syncFromConfig(why);
    }, DEBOUNCE_MS);
  }
  try {
    configWatchHandle = fs.watch(CONFIG_PATH, () => schedule("fs.watch"));
  } catch (exc) {
    log("fs.watch 失败: " + (exc && exc.message));
  }
  /* 兜底轮询：ZCode 保存 config 用「临时文件 + rename」，macOS 上 fs.watch
   * 监听的 inode 被替换后收不到后续事件，只靠 watch 会出现「关了还生效 /
   * 开了不生效」。1s 一次的 stat 开销可忽略。 */
  pollTimer = setInterval(() => {
    syncFromConfig("轮询");
    runProbe();
    pollTicks += 1;
    workspaceScanTicks += 1;
    if (workspaceScanTicks >= WORKSPACE_SCAN_EVERY_TICKS) {
      workspaceScanTicks = 0;
      discoverAgentWorkspace();
    }
    selfSyncFromCache();
    heartbeatTicks += 1;
    if (heartbeatTicks >= HEARTBEAT_EVERY_TICKS) {
      heartbeatTicks = 0;
      sendHeartbeat().catch((exc) => log("心跳发送异常: " + (exc && exc.message)));
    }
  }, POLL_MS);
  if (pollTimer && typeof pollTimer.unref === "function") pollTimer.unref();
}

function activate() {
  if (activated) return "already";
  activated = true;
  writeActive();
  currentEnabled = readEnabled() || [];
  lastConfigFingerprint = configFingerprint();
  log("激活，已启用模块: " + JSON.stringify(currentEnabled));
  try {
    const { webContents } = require("electron");
    // 热更新重激活时强制重放：让新核心的逻辑对已注入页面重新生效
    for (const wc of webContents.getAllWebContents()) {
      try {
        wc.__zchState = {};
      } catch (_) {}
    }
    for (const wc of webContents.getAllWebContents()) {
      try {
        replayOnLoad(wc);
      } catch (_) { /* 已销毁的忽略 */ }
    }
    applyAll(currentEnabled, "activate");
    watchConfig();
    discoverAgentWorkspace(); // 立即发现工作区，不等第一个 5s tick
  } catch (exc) {
    log("activate 失败: " + (exc && exc.message));
  }
  return "ok";
}

function onWebContentsCreated(wc) {
  let url = "";
  try {
    url = wc.getURL() || "";
  } catch (_) {}
  log("web-contents-created: type=" + (wc.getType ? wc.getType() : "?") + " url=" + url.slice(-60));
  replayOnLoad(wc);
}

function dispose() {
  /* 热更新时由引导壳调用：停掉本核心的全部定时器/监听，不碰已注入的 DOM
   * （新核心 activate 会清状态并重放）。 */
  activated = false;
  try {
    if (watchTimer) clearTimeout(watchTimer);
  } catch (_) {}
  watchTimer = null;
  try {
    if (pollTimer) clearInterval(pollTimer);
  } catch (_) {}
  pollTimer = null;
  try {
    if (configWatchHandle) configWatchHandle.close();
  } catch (_) {}
  configWatchHandle = null;
}

module.exports = {
  activate,
  dispose,
  onWebContentsCreated,
  enabledModules,
  enabledModulesFromMap,
  mergedEnabledMap,
  projectConfigFilesFor,
  latestAgentLogPath,
  discoverAgentWorkspace,
  tailText,
  readEnabled,
  MODULE_IDS,
  CORE_VERSION,
  runnerFor,
  syncFromConfig,
  injectionsFor,
  selfSyncFromCache,
  sendHeartbeat,
  HEARTBEAT_PORTS,
  HEARTBEAT_EVERY_TICKS,
};

/* 独立自检：node shared/core.cjs 打印当前启用模块与核心版本 */
if (require.main === module) {
  console.log(JSON.stringify({ core: CORE_VERSION, enabled: readEnabled(), modulesDir: MODULES_DIR }));
}
