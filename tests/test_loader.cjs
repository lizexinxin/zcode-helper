/* loader.cjs 纯逻辑测试（node --test tests/test_loader.cjs）。
 * 只测可独立运行的纯函数（enabledModules），不加载 electron。 */
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

const loader = require(path.join(__dirname, "..", "shared", "loader.cjs"));

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
