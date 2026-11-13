/* zcode 模块：编辑项目源文件夹显示 git 分支徽章（数据来自 zch-branch-daemon）。
 * 逻辑与原 inject/branch-badge.js 一致，按模块协议封装为 install/dispose：
 * dispose 断开 observer、移除全部徽章 DOM、清缓存重置探测结果。
 * 由主进程 loader 注入执行（见 shared/loader.cjs 的模块协议）。 */
(function () {
  "use strict";
  var ID = "branch-badge";
  var PORTS = [39217, 39218, 39219, 39220, 39221];
  var TTL = 2000; // 每个路径的查询缓存毫秒数
  var BADGE_MARK = "data-zch-branch-badge";
  var ROW_SELECTOR = '[data-testid="virtual-project-root-row"]';
  var NAME_SELECTOR = '[data-testid="virtual-project-root-name"]';

  var base = null; // "http://127.0.0.1:<port>"，探测成功后设置
  var cache = new Map(); // path -> {label, at}
  var inflight = new Map(); // path -> Promise
  var observer = null;

  function ping(port) {
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () {
        if (!done) { done = true; resolve(false); }
      }, 800);
      try {
        fetch("http://127.0.0.1:" + port + "/ping")
          .then(function (resp) {
            if (!done) { done = true; clearTimeout(timer); resolve(resp.ok); }
          })
          .catch(function () {
            if (!done) { done = true; resolve(false); }
          });
      } catch (exc) {
        // fetch 不可用等同步异常：视为探测失败
        if (!done) { done = true; resolve(false); }
      }
    });
  }

  function discover() {
    var i = 0;
    function next() {
      if (i >= PORTS.length) return Promise.resolve(false);
      var port = PORTS[i++];
      return ping(port).then(function (ok) {
        if (ok) { base = "http://127.0.0.1:" + port; return true; }
        return next();
      });
    }
    return next();
  }

  function getLabel(path) {
    if (!base) return Promise.resolve(null);
    var hit = cache.get(path);
    if (hit && Date.now() - hit.at < TTL) return Promise.resolve(hit.label);
    var pending = inflight.get(path);
    if (pending) return pending;
    pending = fetch(base + "/branch?path=" + encodeURIComponent(path))
      .then(function (resp) { return resp.ok ? resp.json() : { label: null }; })
      .then(function (data) { return data.label || null; })
      .catch(function () { return null; })
      .then(function (label) {
        cache.set(path, { label: label, at: Date.now() });
        inflight.delete(path);
        return label;
      });
    inflight.set(path, pending);
    return pending;
  }

  function makeBadge(label) {
    var el = document.createElement("span");
    el.className = "text-ui-sm text-foreground-subtle"; // 复用应用全局样式表的 utility 类
    el.setAttribute(BADGE_MARK, "1");
    el.setAttribute("data-zch-module", ID);
    el.textContent = "⎇ " + label;
    el.style.cssText =
      "display:block;width:fit-content;margin-top:3px;white-space:nowrap;" +
      "border:1px solid rgba(128,128,128,.35);border-radius:4px;padding:1px 6px;";
    return el;
  }

  function decorate(row) {
    if (!(row instanceof Element) || !row.matches(ROW_SELECTOR)) return;
    if (row.querySelector("[" + BADGE_MARK + "]")) return;
    var name = row.querySelector(NAME_SELECTOR);
    if (!name) return;
    // title 属性始终是完整路径（不依赖 folder-full-path 模块是否启用）
    var path = name.getAttribute("title") || (name.textContent || "").trim();
    if (!path || path.charCodeAt(0) !== 47 /* "/" */) return;
    getLabel(path).then(function (label) {
      if (!label || !row.isConnected) return;
      if (row.querySelector("[" + BADGE_MARK + "]")) return;
      var target = row.querySelector(NAME_SELECTOR);
      if (!target) return;
      // 插入 name span 内部并 display:block，徽章换行显示在路径正下方
      target.appendChild(makeBadge(label));
    });
  }

  function scan(nodes) {
    Array.prototype.forEach.call(nodes, function (node) {
      if (!(node instanceof Element)) return;
      if (node.matches(ROW_SELECTOR)) decorate(node);
      if (node.querySelectorAll) {
        node.querySelectorAll(ROW_SELECTOR).forEach(decorate);
      }
    });
  }

  window.__zchModules[ID] = {
    install: function () {
      if (observer) return "already";
      observer = new MutationObserver(function (mutations) {
        mutations.forEach(function (m) {
          scan(m.addedNodes);
          // React 更新行内容（含 name span 内部文本）可能移掉徽章：
          // 目标行仍存在时重新补挂
          if (m.removedNodes.length && m.target instanceof Element) {
            var row = m.target.closest ? m.target.closest(ROW_SELECTOR) : null;
            if (row) decorate(row);
          }
        });
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      scan([document.documentElement]);
      discover(); // 后台探测 daemon；探测成功前 getLabel 直接返回 null（无徽章）
      return "ok";
    },
    dispose: function () {
      if (observer) { observer.disconnect(); observer = null; }
      Array.prototype.forEach.call(
        document.querySelectorAll("[" + BADGE_MARK + "]"),
        function (el) { el.remove(); }
      );
      cache.clear();
      inflight.clear();
      base = null;
      return "ok";
    },
  };
})();
