/* zcode 模块：编辑项目源文件夹显示完整路径。
 *
 * 关键事实（3.18.2 bundle 实测）：name 元素的 children 是 r?t:fx(t)——
 * 非展开状态下 DOM 文本本身就是截断结果（fx(t)），完整路径只在 title
 * 属性里。因此纯 CSS 无法展开，必须用 JS 把文本替换为 title 的完整值；
 * React 重渲染会覆盖回来，靠 MutationObserver 自动补写。
 *
 * 性能：ZCode 主界面 DOM 变动频繁，回调里只做「防抖调度」，真正扫描
 * 合并为每 300ms 最多一次，且不观察 characterData（避免文本流回调风暴）。
 * dispose 拆除 observer 并把替换过的文本恢复原文，关开关立即还原。
 * 由主进程 loader 注入执行（见 shared/loader.cjs 的模块协议）。 */
(function () {
  "use strict";
  var ID = "folder-full-path";
  var STYLE_ID = "zch-" + ID + "-style";
  var NAME_SELECTOR = '[data-testid="virtual-project-root-name"]';
  var MARK = "data-zch-ffp";
  var SCAN_DELAY_MS = 300;
  var CSS =
    NAME_SELECTOR + "{" +
    "white-space:normal;word-break:break-all;overflow:visible;text-overflow:unset;}";

  var observer = null;
  var scanTimer = null;

  // 重复注入时先拆掉旧实例，避免 observer/style 泄漏
  var prev = window.__zchModules && window.__zchModules[ID];
  if (prev && typeof prev.dispose === "function") prev.dispose();

  function fixSpan(span) {
    var title = span.getAttribute("title");
    if (!title || span.textContent === title) return false;
    if (!span.getAttribute(MARK)) {
      // 首次替换时记录原文，dispose 时恢复
      span.setAttribute(MARK, "1");
      span.setAttribute(MARK + "-original", span.textContent);
    }
    span.textContent = title;
    return true;
  }

  function scanAll() {
    var spans = document.querySelectorAll(NAME_SELECTOR);
    var fixed = 0;
    Array.prototype.forEach.call(spans, function (span) {
      if (fixSpan(span)) fixed += 1;
    });
    return { names: spans.length, fixed: fixed };
  }

  function schedule() {
    if (scanTimer) return; // 已排队：合并到一次
    scanTimer = setTimeout(function () {
      scanTimer = null;
      try {
        scanAll();
      } catch (exc) {
        /* 扫描失败不影响页面 */
      }
    }, SCAN_DELAY_MS);
  }

  window.__zchModules[ID] = {
    install: function () {
      if (observer) return "already";
      var s = document.createElement("style");
      s.id = STYLE_ID;
      s.setAttribute("data-zch-module", ID);
      s.textContent = CSS;
      document.head.appendChild(s);
      observer = new MutationObserver(schedule);
      observer.observe(document.documentElement, { childList: true, subtree: true });
      var r = scanAll();
      return "ok;names=" + r.names + ";fixed=" + r.fixed;
    },
    dispose: function () {
      if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
      if (observer) { observer.disconnect(); observer = null; }
      var s = document.getElementById(STYLE_ID);
      if (s) s.remove();
      // 恢复被替换的文本（React 重渲染也会自然恢复，这里保证立即生效）
      Array.prototype.forEach.call(document.querySelectorAll("[" + MARK + "]"), function (span) {
        var original = span.getAttribute(MARK + "-original");
        if (original != null) span.textContent = original;
      });
      return "ok";
    },
  };
})();