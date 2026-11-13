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
const CONFIG_PATH = path.join(os.homedir(), ".zcode", "cli", "config.json");
const LOG_PATH = path.join(HOME_DIR, "loader.log");

const MODULE_IDS = ["folder-full-path", "branch-badge"];
const PLUGIN_PREFIX = "zcode-";
const DEBOUNCE_MS = 300;
const REPLAY_DELAY_MS = 300;

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
  try {
    return enabledModules(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")));
  } catch (exc) {
    log("readEnabled 失败: " + (exc && exc.message));
    return [];
  }
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
  for (const id of MODULE_IDS) {
    const want = enabled.includes(id);
    wc.executeJavaScript(runnerFor(id, want), true)
      .then((res) => log("注入 " + id + "(" + want + ") → " + res + label))
      .catch((exc) =>
        log("注入 " + id + "(" + want + ") 失败: " + (exc && exc.message) + label)
      );
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
  /* 页面刷新/新窗口加载完成后重放；模块自身幂等，重复调用无副作用。 */
  wc.on("did-finish-load", () => {
    log("did-finish-load，300ms 后重放");
    setTimeout(() => applyToContents(wc, currentEnabled), REPLAY_DELAY_MS);
  });
}

function watchConfig() {
  try {
    fs.watch(CONFIG_PATH, () => {
      if (watchTimer) clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        const next = readEnabled();
        const changed = MODULE_IDS.filter(
          (id) => currentEnabled.includes(id) !== next.includes(id)
        );
        currentEnabled = next;
        for (const id of changed) {
          log("开关变化: " + id + " → " + (next.includes(id) ? "on" : "off"));
        }
        if (changed.length) applyAll(next, "开关变化"); // 全量注入靠模块幂等，简单可靠
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

module.exports = { activate, enabledModules, MODULE_IDS, runnerFor };

/* 独立自检：node shared/loader.cjs 打印当前启用模块与模块目录 */
if (require.main === module) {
  console.log(JSON.stringify({ enabled: readEnabled(), modulesDir: MODULES_DIR }));
}
