/* loader.cjs 纯逻辑测试（node --test tests/test_loader.cjs）。
 * 只测可独立运行的纯函数（enabledModules），不加载 electron。 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

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
