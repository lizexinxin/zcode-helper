/* 渲染模块测试用的最小 DOM（无第三方依赖）。
 *
 * 只实现被测模块实际用到的 API：textContent / childNodes / appendChild /
 * insertBefore / remove / matches / querySelector(All) / getElementById /
 * MutationObserver。selector 仅支持 [attr] 与 [attr="value"] 两种属性写法。
 *
 * 关键点：textContent 赋值必须像真 DOM 一样清空所有子节点——folder-full-path
 * 曾经用 textContent 覆盖 name span，把 branch-badge 插进去的徽章一并删掉，
 * 这里要能复现该行为。 */
"use strict";

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

function matchesSelector(el, selector) {
  const raw = String(selector).trim();
  if (raw.startsWith("#")) return el.attrs.id === raw.slice(1);
  const m = /^\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]"']*)))?\]$/.exec(raw);
  if (!m) throw new Error("mini-dom: 不支持的 selector: " + selector);
  const name = m[1];
  const want = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
  if (!Object.prototype.hasOwnProperty.call(el.attrs, name)) return false;
  return want === undefined || el.attrs[name] === want;
}

class TextNode {
  constructor(value) {
    this.nodeType = TEXT_NODE;
    this.nodeValue = String(value);
    this.parentNode = null;
  }
  get textContent() {
    return this.nodeValue;
  }
}

class Element {
  constructor(tag, attrs) {
    this.nodeType = ELEMENT_NODE;
    this.tagName = String(tag).toUpperCase();
    this.attrs = Object.assign({}, attrs || {});
    this.childNodes = [];
    this.parentNode = null;
    /* branch-badge 用 el.style.cssText / el.className 设置徽章样式 */
    this.style = { cssText: "" };
    this.className = "";
  }
  get children() {
    return this.childNodes.filter((n) => n.nodeType === ELEMENT_NODE);
  }
  get firstChild() {
    return this.childNodes[0] || null;
  }
  /* 真 DOM 里 el.id = x 会同步到 attribute，模块依赖 document.getElementById */
  get id() {
    return this.attrs.id || "";
  }
  set id(value) {
    this.attrs.id = String(value);
  }
  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === ELEMENT_NODE ? this.parentNode : null;
  }
  get textContent() {
    return this.childNodes
      .map((n) => (n.nodeType === TEXT_NODE ? n.nodeValue : n.textContent))
      .join("");
  }
  set textContent(value) {
    for (const child of this.childNodes.slice()) child.parentNode = null;
    this.childNodes.length = 0;
    const text = String(value);
    if (text !== "") this.appendChild(new TextNode(text));
  }
  setAttribute(name, value) {
    this.attrs[name] = String(value);
  }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }
  hasAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name);
  }
  removeAttribute(name) {
    delete this.attrs[name];
  }
  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
  insertBefore(node, ref) {
    if (node.parentNode) node.parentNode.removeChild(node);
    const index = ref ? this.childNodes.indexOf(ref) : -1;
    node.parentNode = this;
    if (index < 0) this.childNodes.push(node);
    else this.childNodes.splice(index, 0, node);
    return node;
  }
  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index >= 0) {
      this.childNodes.splice(index, 1);
      node.parentNode = null;
    }
    return node;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  matches(selector) {
    return matchesSelector(this, selector);
  }
  querySelectorAll(selector) {
    const found = [];
    const walk = (el) => {
      for (const child of el.childNodes) {
        if (child.nodeType !== ELEMENT_NODE) continue;
        if (matchesSelector(child, selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  get isConnected() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node === this.ownerDocument.documentElement;
  }
  set ownerDocument(doc) {
    Object.defineProperty(this, "_ownerDocument", { value: doc, writable: true, configurable: true });
  }
  get ownerDocument() {
    return this._ownerDocument;
  }
}

class MutationObserverStub {
  constructor(callback) {
    this.callback = callback;
    this.target = null;
    this.active = false;
    this.records = [];
  }
  observe(target, options) {
    this.target = target;
    this.options = options || {};
    this.active = true;
  }
  disconnect() {
    this.active = false;
  }
  takeRecords() {
    const records = this.records;
    this.records = [];
    return records;
  }
  /* 测试专用：模拟一次 DOM 变动回调，按 observe 的 options 过滤——
   * 没监听 attributes 的 observer 收不到 title 变更，与真实浏览器一致。 */
  trigger(records) {
    if (!this.active) return;
    const opts = this.options || {};
    const accepted = (records || this.takeRecords()).filter((record) => {
      if (record.type === "attributes") {
        if (!opts.attributes) return false;
        if (opts.attributeFilter && !opts.attributeFilter.includes(record.attributeName)) {
          return false;
        }
        return true;
      }
      if (record.type === "characterData") return !!opts.characterData;
      return !!opts.childList || !!(record.addedNodes || record.removedNodes);
    });
    if (accepted.length) this.callback(accepted, this);
  }
}

function createDom() {
  const html = new Element("html");
  const head = new Element("head");
  const body = new Element("body");
  html.appendChild(head);
  html.appendChild(body);

  const observers = [];
  const clickListeners = [];
  const observerClass = class extends MutationObserverStub {
    constructor(callback) {
      super(callback);
      observers.push(this);
    }
  };

  const document = {
    readyState: "complete",
    documentElement: html,
    head,
    body,
    createElement(tag) {
      const el = new Element(tag);
      el.ownerDocument = document;
      return el;
    },
    createTextNode(value) {
      return new TextNode(value);
    },
    getElementById(id) {
      const stack = [html];
      while (stack.length) {
        const el = stack.pop();
        if (el.attrs && el.attrs.id === id) return el;
        if (el.childNodes) stack.push(...el.childNodes.filter((n) => n.nodeType === ELEMENT_NODE));
      }
      return null;
    },
    querySelectorAll(selector) {
      const found = html.matches(selector) ? [html] : [];
      return found.concat(html.querySelectorAll(selector));
    },
    querySelector(selector) {
      return document.querySelectorAll(selector)[0] || null;
    },
    addEventListener(type, fn) {
      if (type === "click" && typeof fn === "function") clickListeners.push(fn);
    },
    removeEventListener(type, fn) {
      if (type !== "click") return;
      const index = clickListeners.indexOf(fn);
      if (index >= 0) clickListeners.splice(index, 1);
    },
  };
  html.ownerDocument = document;
  head.ownerDocument = document;
  body.ownerDocument = document;

  return {
    Element,
    TextNode,
    document,
    observers,
    MutationObserver: observerClass,
    /* 模拟一次 click：按捕获阶段顺序调用监听器 */
    dispatchClick(target) {
      for (const listener of clickListeners.slice()) {
        listener({ type: "click", target });
      }
    },
    /* 建一个 row 结构，与 ZCode 真实 DOM 一致：
     * div[data-testid=virtual-project-root-row] > span[data-testid=virtual-project-root-name][title] */
    makeProjectRow(fullPath, truncatedName) {
      const row = document.createElement("div");
      row.setAttribute("data-testid", "virtual-project-root-row");
      const name = document.createElement("span");
      name.setAttribute("data-testid", "virtual-project-root-name");
      name.setAttribute("title", fullPath);
      name.textContent = truncatedName;
      row.appendChild(name);
      return { row, name };
    },
    mount(node) {
      body.appendChild(node);
      return node;
    },
  };
}

module.exports = { createDom, Element, TextNode };