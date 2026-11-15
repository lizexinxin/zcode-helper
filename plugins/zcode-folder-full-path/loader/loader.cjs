/* zch-loader 引导壳：被 app.asar 的一行 dynamic import() 指针加载，随启动
 * 装入主进程，基本永久不变（只有它和 asar 指针需要重启才能更换）。
 * 真正的逻辑在 core.cjs：hook 同步或自同步把新版 core.cjs 写到本目录后，
 * 这里监听文件指纹、dispose 旧核心、热加载新核心并重新激活——
 * 因此插件更新（除首次安装写指针外）完全无需重启 ZCode。
 * 任何异常只写 loader.log，绝不抛向主进程。 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const HOME_DIR =
  process.env.ZCODE_LOADER_HOME || path.join(os.homedir(), ".zcode", "zcode-helper");
const CORE_PATH = path.join(__dirname, "core.cjs");
const LOG_PATH = path.join(HOME_DIR, "loader.log");
const RELOAD_DEBOUNCE_MS = 300;
const CORE_POLL_MS = 1000;

let activated = false;
let currentCore = null;
let coreFingerprint = null;
let reloadTimer = null;
let corePollTimer = null;

function log(msg) {
  try {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    fs.appendFileSync(LOG_PATH, new Date().toISOString() + " " + msg + "\n");
  } catch (_) { /* 日志失败忽略 */ }
}

function loadCore() {
  delete require.cache[require.resolve(CORE_PATH)];
  currentCore = require(CORE_PATH);
  /* 兼容导出：纯函数/常量挂到本模块导出上（测试与诊断用）；
   * activate/dispose 保持为本壳的方法。热更新后重新执行本函数刷新导出。 */
  for (const key of Object.keys(currentCore)) {
    if (key === "activate" || key === "dispose" || key === "onWebContentsCreated") continue;
    module.exports[key] = currentCore[key];
  }
}

function coreFingerprintNow() {
  /* 与 config 指纹同思路：inode + mtime + size，rename 替换后必然变化。 */
  try {
    const st = fs.statSync(CORE_PATH);
    return st.ino + ":" + st.mtimeMs + ":" + st.size;
  } catch (_) {
    return null;
  }
}

function scheduleReload() {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    const fp = coreFingerprintNow();
    if (fp === null || fp === coreFingerprint) return;
    coreFingerprint = fp;
    log("检测到 core.cjs 变化，热更新核心");
    try {
      if (currentCore && typeof currentCore.dispose === "function") currentCore.dispose();
    } catch (exc) {
      log("dispose 旧核心失败: " + (exc && exc.message));
    }
    try {
      loadCore();
    } catch (exc) {
      log("加载新核心失败: " + (exc && exc.message));
      return;
    }
    try {
      currentCore.activate();
      log("核心已热更新并重新激活 (core " + currentCore.CORE_VERSION + ")");
    } catch (exc) {
      log("重新激活失败: " + (exc && exc.message));
    }
  }, RELOAD_DEBOUNCE_MS);
}

function watchCoreFile() {
  try {
    const handle = fs.watch(CORE_PATH, scheduleReload);
    // unref：句柄不拖住进程退出（主进程常驻无影响；node 测试进程需要能退出）
    if (handle && typeof handle.unref === "function") handle.unref();
  } catch (exc) {
    log("fs.watch core 失败: " + (exc && exc.message));
  }
  /* 兜底轮询：macOS 上 rename 替换文件后 fs.watch 的 inode 会失效，
   * 与 config 监听同样的坑，1s stat 兜底。unref 保证不拖住测试进程退出。 */
  corePollTimer = setInterval(scheduleReload, CORE_POLL_MS);
  if (corePollTimer && typeof corePollTimer.unref === "function") corePollTimer.unref();
}

let wired = false;
function activate() {
  if (activated) return "already";
  activated = true;
  loadCore();
  try {
    currentCore.activate();
  } catch (exc) {
    log("核心激活失败: " + (exc && exc.message));
  }
  coreFingerprint = coreFingerprintNow();
  watchCoreFile();
  try {
    const { app } = require("electron");
    if (!wired) {
      wired = true;
      app.on("web-contents-created", (_e, wc) => {
        try {
          if (currentCore && typeof currentCore.onWebContentsCreated === "function") {
            currentCore.onWebContentsCreated(wc);
          }
        } catch (_) { /* 单次失败不影响主进程 */ }
      });
    }
  } catch (_) { /* 非 electron 环境（测试） */ }
  return "ok";
}

module.exports = { activate };
/* require 时立即加载核心，把纯函数/常量挂到导出上 */
loadCore();

/* 独立自检：node loader.cjs 打印当前核心版本 */
if (require.main === module) {
  console.log(JSON.stringify({ core: currentCore && currentCore.CORE_VERSION }));
}
