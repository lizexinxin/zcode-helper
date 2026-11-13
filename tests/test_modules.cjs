/* 渲染模块协议测试（node --test tests/test_modules.cjs）。
 *
 * 用 mini-dom 复现真实页面结构（row > name span[title]），覆盖：
 * - 两模块注册/install/dispose 幂等
 * - folder-full-path 只改文本节点，保留 branch-badge 插入的徽章
 * - folder-full-path 的 MutationObserver 回调同步生效（不等 300ms 定时器）
 * - branch-badge 在 daemon 探测完成后主动补扫（不依赖后续 DOM 变动） */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createDom } = require("./helpers/mini-dom.cjs");

const BADGE = "[data-zch-branch-badge]";
const FULL_PATH = "/Users/zexin.li/projects/github/lizexinxin/zcode-helper";

function fakeFetch(url) {
  if (String(url).endsWith("/ping")) return Promise.resolve({ ok: true, json: async () => ({}) });
  return Promise.resolve({ ok: true, json: async () => ({ label: "main" }) });
}

function makeDom() {
  const dom = createDom();
  dom.fetch = fakeFetch;
  return dom;
}

/* 在同一个 document / window.__zchModules 上执行模块代码，模拟主进程连续注入 */
function runModuleIn(dom, id) {
  const code = fs.readFileSync(
    path.join(__dirname, "..", "shared", "modules", id + ".js"),
    "utf8"
  );
  const windowObj = dom.window || (dom.window = { __zchModules: {} });
  const sandbox = {
    window: windowObj,
    document: dom.document,
    Element: dom.Element,
    MutationObserver: dom.MutationObserver,
    fetch: dom.fetch,
    setTimeout,
    clearTimeout,
    Date,
    Promise,
    Map,
    console,
  };
  vm.runInNewContext("(function(){" + code + "}());", sandbox);
  return windowObj.__zchModules[id];
}

function activeObserver(dom) {
  return dom.observers.filter((o) => o.active);
}

async function settle() {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

test("两模块都按协议注册且 install/dispose 幂等", () => {
  for (const id of ["folder-full-path", "branch-badge"]) {
    const dom = makeDom();
    const m = runModuleIn(dom, id);
    assert.ok(m && typeof m.install === "function" && typeof m.dispose === "function", id);
    assert.ok(String(m.install()).startsWith("ok"), id); // 首次真正安装
    assert.ok(String(m.install()).startsWith("already"), id); // 幂等：重复安装不重复动作
    assert.strictEqual(m.dispose(), "ok");
    assert.strictEqual(m.dispose(), "ok"); // dispose 幂等
  }
});

test("folder-full-path 插 style、dispose 移除并恢复截断名", () => {
  const dom = makeDom();
  const { row, name } = dom.makeProjectRow(FULL_PATH, "zcode-helper");
  dom.mount(row);

  const m = runModuleIn(dom, "folder-full-path");
  assert.ok(String(m.install()).startsWith("ok"));
  const style = dom.document.head.querySelector("#zch-folder-full-path-style");
  assert.ok(style, "style 应插入 head");
  assert.strictEqual(style.getAttribute("data-zch-module"), "folder-full-path");
  assert.ok(style.textContent.includes("virtual-project-root-name"));
  assert.strictEqual(name.textContent, FULL_PATH);

  m.dispose();
  assert.strictEqual(dom.document.head.querySelector("#zch-folder-full-path-style"), null);
  assert.strictEqual(name.textContent, "zcode-helper");
});

test("folder-full-path 修文本时保留 branch-badge 的徽章", async () => {
  const dom = makeDom();
  const { row, name } = dom.makeProjectRow(FULL_PATH, "zcode-helper");
  dom.mount(row);

  const ffp = runModuleIn(dom, "folder-full-path");
  const bb = runModuleIn(dom, "branch-badge");
  ffp.install();
  bb.install();
  await settle();
  assert.ok(row.querySelector(BADGE), "徽章应已插入");

  // 模拟 React 文本更新（commitTextUpdate 只改 nodeValue，不重建子节点）
  const text = name.childNodes.find((n) => n.nodeType === 3);
  text.nodeValue = "zcode-helper";
  const folderObserver = activeObserver(dom)[0];
  folderObserver.trigger([{ addedNodes: [text] }]);

  assert.strictEqual(text.nodeValue, FULL_PATH, "文本节点应被修正");
  assert.ok(row.querySelector(BADGE), "徽章不能被 textContent 覆盖删掉");
});

test("folder-full-path 的 observer 回调同步修正，不依赖定时器", () => {
  const dom = makeDom();
  const { row, name } = dom.makeProjectRow(FULL_PATH, "zcode-helper");
  dom.mount(row);

  const ffp = runModuleIn(dom, "folder-full-path");
  ffp.install();
  name.textContent = "zcode-helper"; // 模拟 React 重新渲染出截断名

  activeObserver(dom)[0].trigger([{ addedNodes: [row] }]);
  assert.strictEqual(name.textContent, FULL_PATH, "回调内同步修正，paint 前完成");
});

test("folder-full-path 在 title 后到时立即修正（attributes 变更）", () => {
  const dom = makeDom();
  const row = dom.document.createElement("div");
  row.setAttribute("data-testid", "virtual-project-root-row");
  const name = dom.document.createElement("span");
  name.setAttribute("data-testid", "virtual-project-root-name");
  name.textContent = "zcode-helper"; // React 先渲染出截断名，title 还没有
  row.appendChild(name);
  dom.mount(row);

  const ffp = runModuleIn(dom, "folder-full-path");
  ffp.install();
  assert.strictEqual(name.textContent, "zcode-helper", "没有 title 时不应改动");

  // React 之后（可能晚一次 commit）才补上 title 属性
  name.setAttribute("title", FULL_PATH);
  const observer = activeObserver(dom)[0];
  observer.trigger([{ type: "attributes", target: name, attributeName: "title", addedNodes: [] }]);

  assert.strictEqual(name.textContent, FULL_PATH, "title 到位后应同步修正");
});

test("branch-badge 在 title 后到时补出徽章（attributes 变更）", async () => {
  const dom = makeDom();
  const { row, name } = dom.makeProjectRow(FULL_PATH, "zcode-helper");
  name.removeAttribute("title"); // 先没有 title
  dom.mount(row);

  const bb = runModuleIn(dom, "branch-badge");
  bb.install();
  await settle();
  assert.strictEqual(row.querySelector(BADGE), null, "没 title 时无徽章");

  name.setAttribute("title", FULL_PATH);
  activeObserver(dom)[0].trigger([
    { type: "attributes", target: name, attributeName: "title", addedNodes: [] },
  ]);
  // 不等 300ms 防抖：title 到位后应立即修饰（只留本地 fetch 的微任务时间）
  await settle();
  assert.ok(row.querySelector(BADGE), "title 到位后应立即补出徽章");
});

test("branch-badge 在 row 插入时立即修饰，不等防抖", async () => {
  const dom = makeDom();
  const bb = runModuleIn(dom, "branch-badge");
  bb.install();
  await settle(); // 让 daemon 探测完成

  const { row } = dom.makeProjectRow(FULL_PATH, "zcode-helper");
  dom.mount(row);
  activeObserver(dom)[0].trigger([{ type: "childList", addedNodes: [row], target: dom.document.body }]);
  await settle(); // 仅微任务 + 0ms 定时器，不足以跑完 300ms 防抖
  assert.ok(row.querySelector(BADGE), "row 一出现就该有徽章");
});

test("branch-badge 在 daemon 探测完成后主动补扫，无需后续 DOM 变动", async () => {
  const dom = makeDom();
  const bb = runModuleIn(dom, "branch-badge");
  bb.install(); // 此时弹窗还没打开，页面上没有 row

  const { row } = dom.makeProjectRow(FULL_PATH, "zcode-helper");
  dom.mount(row); // 只挂载，不触发任何 MutationObserver 回调
  await settle();

  assert.ok(row.querySelector(BADGE), "探测成功后应补扫一次并插入徽章");
});

test("market-switch-bridge 记录点击意图（target 是内部子元素也能识别）", async () => {
  const dom = makeDom();
  const makeSwitch = (label) => {
    const button = dom.document.createElement("button");
    button.setAttribute("data-testid", "plugin-store-enabled-switch");
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-checked", "true");
    const inner = dom.document.createElement("span");
    button.appendChild(inner);
    dom.mount(button);
    return { button, inner };
  };
  const folder = makeSwitch("停用 ZCode 源文件夹完整路径");
  const badge = makeSwitch("停用 ZCode git 分支徽章");

  const bridge = runModuleIn(dom, "market-switch-bridge");
  assert.strictEqual(bridge.install(), "ok");

  // 模拟用户点击：点在内层 span 上，React 提交后 aria-checked 变 false
  folder.button.setAttribute("aria-checked", "false");
  dom.dispatchClick(folder.inner);
  await new Promise((resolve) => setTimeout(resolve, 200));
  let intent = dom.window.__zchMarketIntent;
  assert.strictEqual(intent.module, "folder-full-path");
  assert.strictEqual(intent.enabled, false);

  // 另一个开关也能记录，且时间戳更新
  const firstAt = intent.at;
  badge.button.setAttribute("aria-checked", "false");
  dom.dispatchClick(badge.button);
  await new Promise((resolve) => setTimeout(resolve, 200));
  intent = dom.window.__zchMarketIntent;
  assert.strictEqual(intent.module, "branch-badge");
  assert.strictEqual(intent.enabled, false);
  assert.ok(intent.at >= firstAt);

  // dispose 后不再记录
  bridge.dispose();
  folder.button.setAttribute("aria-checked", "true");
  dom.dispatchClick(folder.button);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.strictEqual(dom.window.__zchMarketIntent, null);
});

test("branch-badge dispose 移除徽章并断开 observer", async () => {
  const dom = makeDom();
  const { row } = dom.makeProjectRow(FULL_PATH, "zcode-helper");
  dom.mount(row);

  const bb = runModuleIn(dom, "branch-badge");
  bb.install();
  await settle();
  assert.ok(row.querySelector(BADGE));

  bb.dispose();
  assert.strictEqual(row.querySelector(BADGE), null);
  assert.deepStrictEqual(activeObserver(dom), []);
});