/* 渲染模块协议测试（node --test tests/test_modules.cjs）。
 * 用最小 DOM stub 验证：两模块按协议注册 window.__zchModules[id]，
 * install/dispose 幂等；folder-full-path 插 style、dispose 移除；
 * branch-badge 在无匹配 DOM 时不抛异常。 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function makeDom() {
  const elements = []; // 挂到 head / document 的元素
  const dom = {
    head: { appendChild(el) { elements.push(el); } },
    documentElement: { isConnected: true },
    elements,
  };
  dom.document = {
    readyState: "complete",
    head: dom.head,
    documentElement: dom.documentElement,
    getElementById(id) {
      return elements.find((e) => e.id === id) || null;
    },
    createElement(tag) {
      return {
        tag,
        id: "",
        textContent: "",
        style: { cssText: "" },
        attrs: {},
        setAttribute(k, v) { this.attrs[k] = v; },
        getAttribute(k) { return this.attrs[k]; },
        remove() {
          const i = elements.indexOf(this);
          if (i >= 0) elements.splice(i, 1);
        },
      };
    },
    appendChild(el) { elements.push(el); },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
  dom.window = {
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    fetch() {
      return new Promise(() => {}); // 永挂起，避免测试等待网络
    },
    __zchModules: {},
  };
  return dom;
}

function runModule(id) {
  const dom = makeDom();
  const code = fs.readFileSync(
    path.join(__dirname, "..", "shared", "modules", id + ".js"),
    "utf8"
  );
  const wrapped = "window.__zchModules=window.__zchModules||{};(function(){" + code + "}());";
  vm.runInNewContext(wrapped, {
    window: dom.window,
    document: dom.document,
    Element: class {},
    MutationObserver: dom.window.MutationObserver,
    fetch: dom.window.fetch,
    setTimeout,
    clearTimeout,
    Date,
    Promise,
    Map,
  });
  return { module: dom.window.__zchModules[id], dom };
}

test("两模块都按协议注册且 install/dispose 幂等", () => {
  for (const id of ["folder-full-path", "branch-badge"]) {
    const { module: m } = runModule(id);
    assert.ok(m && typeof m.install === "function" && typeof m.dispose === "function", id);
    assert.strictEqual(m.install(), "ok");       // 首次真正安装
    assert.strictEqual(m.install(), "already");  // 幂等：重复安装不重复动作
    assert.strictEqual(m.dispose(), "ok");
    assert.strictEqual(m.dispose(), "ok");       // dispose 幂等
  }
});

test("folder-full-path 插 style、dispose 移除", () => {
  const { module: m, dom } = runModule("folder-full-path");
  m.install();
  assert.strictEqual(dom.elements.length, 1);
  const style = dom.elements[0];
  assert.strictEqual(style.tag, "style");
  assert.strictEqual(style.id, "zch-folder-full-path-style");
  assert.strictEqual(style.attrs["data-zch-module"], "folder-full-path");
  assert.ok(style.textContent.includes("virtual-project-root-name"));
  m.dispose();
  assert.strictEqual(dom.elements.length, 0);
});
