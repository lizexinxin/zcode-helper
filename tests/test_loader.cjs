/* loader.cjs 纯逻辑测试（node --test tests/test_loader.cjs）。
 * 只测可独立运行的纯函数（enabledModules / syncFromConfig），不加载 electron。 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

/* 临时 loader 主目录：runnerFor 每次注入都从磁盘读模块文件 */
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "zch-loader-"));
fs.mkdirSync(path.join(tmpHome, "modules"), { recursive: true });
fs.writeFileSync(
  path.join(tmpHome, "modules", "folder-full-path.js"),
  '(function(){window.__zchModules["folder-full-path"]=' +
    '{install:function(){return "ok";},dispose:function(){return "ok";}};}());'
);
process.env.ZCODE_LOADER_HOME = tmpHome;

/* 临时 config：ZCode 写 config 是「写临时文件 + rename」，macOS 上 fs.watch
 * 监听的 inode 被换掉后再也收不到事件——轮询必须能兜住。 */
const tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "zch-config-"));
const tmpConfig = path.join(tmpConfigDir, "config.json");
process.env.ZCODE_LOADER_CONFIG = tmpConfig;

const loader = require(path.join(__dirname, "..", "shared", "loader.cjs"));

function writeConfigAtomic(pluginState) {
  const payload = JSON.stringify({ plugins: { enabledPlugins: pluginState } });
  const tmp = tmpConfig + ".tmp";
  fs.writeFileSync(tmp, payload);
  fs.renameSync(tmp, tmpConfig); // 与 ZCode 一致的原子替换写法
}

test("enabledModules 按插件前缀映射且忽略禁用项", () => {
  const cfg = {
    plugins: {
      enabledPlugins: {
        "zcode-folder-full-path@mp": true,
        "zcode-branch-badge@mp": false,
        "superpowers@claude-plugins-official": true,
      },
    },
  };
  assert.deepStrictEqual(loader.enabledModules(cfg), ["folder-full-path"]);
});

test("enabledModules 兼容空配置与异常输入", () => {
  assert.deepStrictEqual(loader.enabledModules({}), []);
  assert.deepStrictEqual(loader.enabledModules(null), []);
  assert.deepStrictEqual(loader.enabledModules({ plugins: {} }), []);
  assert.deepStrictEqual(loader.enabledModules("bad"), []);
});

test("MODULE_IDS 与模块文件名约定一致", () => {
  assert.deepStrictEqual(loader.MODULE_IDS, ["folder-full-path", "branch-badge"]);
});

test("runnerFor 输出合法 IIFE，install 返回 ok", () => {
  const js = loader.runnerFor("folder-full-path", true);
  assert.ok(js.startsWith("(function(){"), js);
  assert.ok(js.endsWith("})()"), js);
  // 能直接求值（若顶层 return 会在这里抛 SyntaxError）
  assert.strictEqual(vm.runInNewContext(js, { window: { __zchModules: {} } }), "ok");
});

test("runnerFor on=false 调用 dispose", () => {
  const js = loader.runnerFor("folder-full-path", false);
  assert.strictEqual(vm.runInNewContext(js, { window: { __zchModules: {} } }), "ok");
});

test("runnerFor 模块缺失时返回标记而非抛错", () => {
  const js = loader.runnerFor("no-such-module", true);
  assert.strictEqual(vm.runInNewContext(js, { window: { __zchModules: {} } }), "missing-file");
});

test("injectionsFor 按 webContents 缓存去重，不重复 dispose/install", () => {
  // 首次（state 为空）：两个模块都要注入一次
  assert.deepStrictEqual(loader.injectionsFor({}, ["folder-full-path"]), [
    { id: "folder-full-path", want: true },
    { id: "branch-badge", want: false },
  ]);

  // 已注入且状态一致：不再注入（避免每次重放都拆掉重建，徽章会闪没）
  const state = { "folder-full-path": true, "branch-badge": false };
  assert.deepStrictEqual(loader.injectionsFor(state, ["folder-full-path"]), []);

  // 只有状态变化的模块才重新注入
  assert.deepStrictEqual(loader.injectionsFor(state, ["folder-full-path", "branch-badge"]), [
    { id: "branch-badge", want: true },
  ]);
});

test("diffMarketIntent 只处理新的点击意图", () => {
  const state = { at: 0 };
  assert.strictEqual(loader.diffMarketIntent(state, null), null);
  assert.strictEqual(loader.diffMarketIntent(state, { module: "x", enabled: "yes", at: 1 }), null);
  assert.deepStrictEqual(
    loader.diffMarketIntent(state, { module: "folder-full-path", enabled: false, at: 100 }),
    { "folder-full-path": false }
  );
  // 同一个点击（at 相同）不重复处理
  assert.strictEqual(
    loader.diffMarketIntent(state, { module: "folder-full-path", enabled: false, at: 100 }),
    null
  );
  // 另一个模块的点击照常处理
  assert.deepStrictEqual(
    loader.diffMarketIntent(state, { module: "branch-badge", enabled: true, at: 200 }),
    { "branch-badge": true }
  );
});

test("BRIDGE_ID 与渲染模块文件名一致", () => {
  assert.strictEqual(loader.BRIDGE_ID, "market-switch-bridge");
  const file = path.join(__dirname, "..", "shared", "modules", loader.BRIDGE_ID + ".js");
  assert.ok(fs.existsSync(file), file);
});

test("setEnabledInConfig 原子写回 enabledPlugins，保留其他配置", () => {
  writeConfigAtomic({
    "zcode-branch-badge@mp": true,
    "context7@other": true,
  });
  loader.syncFromConfig("test"); // 建立当前状态

  const result = loader.setEnabledInConfig({ "branch-badge": false });
  assert.deepStrictEqual(result, { "branch-badge": false });

  const written = JSON.parse(fs.readFileSync(tmpConfig, "utf8"));
  assert.strictEqual(written.plugins.enabledPlugins["zcode-branch-badge@mp"], false);
  assert.strictEqual(written.plugins.enabledPlugins["context7@other"], true);

  // 写完之后 syncFromConfig 能立刻感知并返回变化
  assert.deepStrictEqual(loader.syncFromConfig("test"), ["branch-badge"]);
});

test("config 用 rename 方式替换后仍能检测到开关变化", () => {
  writeConfigAtomic({ "zcode-folder-full-path@mp": true });
  assert.deepStrictEqual(loader.syncFromConfig("test"), ["folder-full-path"]);
  // 内容不变：不重复应用
  assert.deepStrictEqual(loader.syncFromConfig("test"), []);

  // 关闭后再次 rename 覆盖（macOS 上 fs.watch 会丢这类事件，轮询必须兜住）
  writeConfigAtomic({ "zcode-folder-full-path@mp": false });
  assert.deepStrictEqual(loader.syncFromConfig("test"), ["folder-full-path"]);

  // 再次开启也必须有变化
  writeConfigAtomic({ "zcode-folder-full-path@mp": true });
  assert.deepStrictEqual(loader.syncFromConfig("test"), ["folder-full-path"]);
});

test("配置读到半截 JSON 时保持现状，不误拆模块", () => {
  // 先归零再开启，保证本用例拿到一次真实变化（测试间共享模块状态）
  writeConfigAtomic({ "zcode-folder-full-path@mp": false });
  loader.syncFromConfig("test");
  writeConfigAtomic({ "zcode-folder-full-path@mp": true });
  assert.deepStrictEqual(loader.syncFromConfig("test"), ["folder-full-path"]);

  // 模拟撞上写入中间态：非法 JSON
  const tmp = tmpConfig + ".tmp";
  fs.writeFileSync(tmp, '{"plugins": {"enabledPlugins": {"zcode-folder-');
  fs.renameSync(tmp, tmpConfig);
  assert.deepStrictEqual(loader.syncFromConfig("test"), [], "解析失败不能当成全部关闭");

  // 文件恢复完整且内容与当前一致：也不应产生变化
  writeConfigAtomic({ "zcode-folder-full-path@mp": true });
  assert.deepStrictEqual(loader.syncFromConfig("test"), []);
});

test("syncFromConfig 在配置缺失时不抛错", () => {
  fs.rmSync(tmpConfig, { force: true });
  assert.deepStrictEqual(loader.syncFromConfig("test"), []);
});