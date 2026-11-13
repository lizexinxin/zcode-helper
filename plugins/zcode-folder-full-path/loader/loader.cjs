/* zch-loader：ZCode 主进程常驻 loader。
 * 由 out/main/index.js 尾部的 dynamic import() 指针加载（见引擎 loader install）。
 * 职责：监听插件开关（~/.zcode/cli/config.json 的 enabledPlugins），
 * 用 webContents.executeJavaScript 向渲染进程注入/拆除 UI 模块
 * （~/.zcode/zcode-helper/modules/*.js）。
 * 任何异常只写 loader.log，绝不抛向主进程。 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const HOME_DIR =
  process.env.ZCODE_LOADER_HOME || path.join(os.homedir(), ".zcode", "zcode-helper");
const MODULES_DIR = path.join(HOME_DIR, "modules");
const CONFIG_PATH =
  process.env.ZCODE_LOADER_CONFIG || path.join(os.homedir(), ".zcode", "cli", "config.json");
const LOG_PATH = path.join(HOME_DIR, "loader.log");

const MODULE_IDS = ["folder-full-path", "branch-badge"];
const PLUGIN_PREFIX = "zcode-";
const DEBOUNCE_MS = 300;
const POLL_MS = 1000;

/* 诊断通道：往 HOME_DIR/probe.js 写一段表达式，loader 下一 tick 会在渲染进程
 * 求值并把结果追加到 probe.out.log（调试完删掉该文件即可停用）。 */
const PROBE_PATH = path.join(HOME_DIR, "probe.js");
const PROBE_OUT = path.join(HOME_DIR, "probe.out.log");

/* 插件市场开关联动：ZCode 的开关不写 config，渲染侧的 market-switch-bridge
 * 模块在点击开关后把意图写进 window.__zchMarketIntent，loader 每 2s 读一次。
 * 只认真实点击，不依赖元素身份（React 重建会让「值变化」推断失效）。 */
const MARKET_INTENT_JS = "window.__zchMarketIntent||null";
const BRIDGE_ID = "market-switch-bridge";
const MARKET_POLL_MS = 2000; // 市场开关探测间隔（用 POLL_MS 的 tick 计数实现）

let activated = false;
let currentEnabled = [];
let watchTimer = null;
let lastConfigFingerprint = null;
let pollTicks = 0;

function log(msg) {
  try {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    fs.appendFileSync(LOG_PATH, new Date().toISOString() + " " + msg + "\n");
  } catch (_) { /* 日志失败忽略 */ }
}

function enabledModules(configData) {
  /* 插件 id 形如 "zcode-<模块名>@<market>"，enabled 时映射到对应模块。 */
  if (!configData || typeof configData !== "object") return [];
  const ep = (configData.plugins && configData.plugins.enabledPlugins) || {};
  const on = new Set();
  for (const [id, enabled] of Object.entries(ep || {})) {
    if (!enabled) continue;
    const name = String(id).split("@")[0];
    if (name.startsWith(PLUGIN_PREFIX)) on.add(name.slice(PLUGIN_PREFIX.length));
  }
  return MODULE_IDS.filter((m) => on.has(m));
}

function readEnabled() {
  /* 读/解析失败返回 null（未知），不要当成「一个都没启用」——轮询撞上
   * ZCode 写 config 的中间态时，误判为 [] 会把模块全部拆掉再装回来。 */
  try {
    return enabledModules(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")));
  } catch (exc) {
    log("readEnabled 失败: " + (exc && exc.message));
    return null;
  }
}

function configFingerprint() {
  /* 用 inode + mtime + size 判断文件是否换过：ZCode 写 config 是「写临时文件
   * + rename」，rename 之后 inode 变化（macOS 上 fs.watch 正是因此失效）。 */
  try {
    const st = fs.statSync(CONFIG_PATH);
    return st.ino + ":" + st.mtimeMs + ":" + st.size;
  } catch (_) {
    return null;
  }
}

function diffMarketIntent(state, intent) {
  /* intent 由渲染侧 market-switch-bridge 写入，带 at 时间戳；同一个点击只处理一次。
   * 返回 { moduleId: enabled } 或 null。 */
  if (!intent || typeof intent !== "object") return null;
  if (!intent.module || typeof intent.enabled !== "boolean") return null;
  if (!intent.at || state.at === intent.at) return null;
  state.at = intent.at;
  const changed = {};
  changed[intent.module] = intent.enabled;
  return changed;
}

function setEnabledInConfig(changes) {
  /* 把 UI 开关状态写回 ZCode config（原子替换），返回实际生效的模块。
   * 写完后由 syncFromConfig 感知并注入/拆除，loader 自身也监听这个文件。 */
  const applied = {};
  let data;
  try {
    data = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (exc) {
    log("写 config 前读取失败: " + (exc && exc.message));
    return applied;
  }
  const plugins = (data && data.plugins) || (data.plugins = {});
  const enabledMap = plugins.enabledPlugins || (plugins.enabledPlugins = {});
  let dirty = false;
  for (const key of Object.keys(changes)) {
    const prefix = "zcode-" + key;
    const pluginId = Object.keys(enabledMap).find(
      (id) => id === prefix || id.indexOf(prefix + "@") === 0
    );
    if (!pluginId) {
      log("config 里没有插件 " + key + "，跳过 UI 开关同步");
      continue;
    }
    if (enabledMap[pluginId] !== changes[key]) {
      enabledMap[pluginId] = changes[key];
      applied[key] = changes[key];
      dirty = true;
    }
  }
  if (!dirty) return applied;
  const tmp = CONFIG_PATH + ".zch-ui-tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, CONFIG_PATH); // 原子替换，避免写一半被读到
  } catch (exc) {
    log("写 config 失败: " + (exc && exc.message));
    return {};
  }
  return applied;
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
  if (state.__bridge !== true) plan.unshift({ id: BRIDGE_ID, want: true });
  if (!plan.length) return; // 状态未变：什么都不做
  for (const step of plan) {
    const id = step.id;
    const want = step.want;
    const isBridge = id === BRIDGE_ID;
    // 先记状态，避免并发重复
    if (isBridge) state.__bridge = true;
    else state[id] = want;
    wc.executeJavaScript(runnerFor(id, want), true)
      .then((res) => {
        if (typeof res === "string" && (res.indexOf("ok") === 0 || res.indexOf("already") === 0)) {
          log("注入 " + id + "(" + want + ") → " + res + label);
          return;
        }
        // missing / missing-file：页面可能还没就绪，回滚状态让下次重放重试
        if (isBridge) delete state.__bridge;
        else delete state[id];
        log("注入 " + id + "(" + want + ") 未生效 → " + res + label);
      })
      .catch((exc) => {
        if (isBridge) delete state.__bridge;
        else delete state[id];
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

function pollMarketSwitches() {
  /* 每 2s 读一次渲染侧记录的「点击意图」；有新的就写回 config 并立即应用。 */
  let webContents;
  try {
    ({ webContents } = require("electron"));
  } catch (_) {
    return; // 非主进程环境（测试）
  }
  for (const wc of webContents.getAllWebContents()) {
    if (!wc || wc.isDestroyed()) continue;
    let type = "";
    try {
      type = wc.getType();
    } catch (_) {
      continue;
    }
    if (type !== "window") continue;
    const state = wc.__zchMarketState || (wc.__zchMarketState = { at: 0 });
    wc.executeJavaScript(MARKET_INTENT_JS, true)
      .then((intent) => {
        const changed = diffMarketIntent(state, intent);
        if (!changed) return;
        log("市场开关点击: " + JSON.stringify(changed));
        const applied = setEnabledInConfig(changed);
        if (!Object.keys(applied).length) {
          log("市场开关点击未能写入 config");
          return;
        }
        syncFromConfig("市场开关");
      })
      .catch(() => {
        /* 页面在导航等：忽略 */
      });
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
    fs.watch(CONFIG_PATH, () => schedule("fs.watch"));
  } catch (exc) {
    log("fs.watch 失败: " + (exc && exc.message));
  }
  /* 兜底轮询：ZCode 保存 config 用「临时文件 + rename」，macOS 上 fs.watch
   * 监听的 inode 被替换后收不到后续事件，只靠 watch 会出现「关了还生效 /
   * 开了不生效」。1s 一次的 stat 开销可忽略。 */
  const timer = setInterval(() => {
    syncFromConfig("轮询");
    runProbe();
    pollTicks += 1;
    if (pollTicks * POLL_MS >= MARKET_POLL_MS) {
      pollTicks = 0;
      pollMarketSwitches(); // 每 ~2s 读一次插件市场开关
    }
  }, POLL_MS);
  if (timer && typeof timer.unref === "function") timer.unref();
}

function activate() {
  if (activated) return "already";
  activated = true;
  currentEnabled = readEnabled() || [];
  lastConfigFingerprint = configFingerprint();
  log("激活，已启用模块: " + JSON.stringify(currentEnabled));
  try {
    const { app, webContents } = require("electron");
    app.on("web-contents-created", (_e, wc) => {
      let url = "";
      try {
        url = wc.getURL() || "";
      } catch (_) {}
      log("web-contents-created: type=" + (wc.getType ? wc.getType() : "?") + " url=" + url.slice(-60));
      replayOnLoad(wc);
    });
    // 兜底：loader 晚于已有窗口创建时，先给现有窗口补挂重放
    for (const wc of webContents.getAllWebContents()) {
      try {
        replayOnLoad(wc);
      } catch (_) { /* 已销毁的忽略 */ }
    }
    applyAll(currentEnabled, "activate");
    watchConfig();
  } catch (exc) {
    log("activate 失败: " + (exc && exc.message));
  }
  return "ok";
}

module.exports = {
  activate,
  enabledModules,
  MODULE_IDS,
  runnerFor,
  syncFromConfig,
  injectionsFor,
  diffMarketIntent,
  setEnabledInConfig,
  BRIDGE_ID,
};

/* 独立自检：node shared/loader.cjs 打印当前启用模块与模块目录 */
if (require.main === module) {
  console.log(JSON.stringify({ enabled: readEnabled(), modulesDir: MODULES_DIR }));
}
