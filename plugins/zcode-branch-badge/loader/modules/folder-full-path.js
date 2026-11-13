/* zcode 模块：编辑项目源文件夹显示完整路径。
 *
 * 关键事实（3.18.2 bundle 实测）：name 元素的 children 是 r?t:fx(t)——
 * 非展开状态下 DOM 文本本身就是截断结果（fx(t)），完整路径只在 title
 * 属性里。因此纯 CSS 无法展开，必须用 JS 把文本替换为 title 的完整值；
 * React 重渲染会覆盖回来，靠 MutationObserver 自动补写。
 * dispose 拆除 observer 后，React 下一次重渲染自然恢复原文本。
 * 由主进程 loader 注入执行（见 shared/loader.cjs 的模块协议）。 */
(function () {
  "use strict";
  var ID = "folder-full-path";
  var STYLE_ID = "zch-" + ID + "-style";
  var NAME_SELECTOR = '[data-testid="virtual-project-root-name"]';
  var CSS =
    '[data-testid="virtual-project-root-name"]{' +
    "white-space:normal;word-break:break-all;overflow:visible;text-overflow:unset;}" +
    '[data-testid="virtual-project-root-row"]{align-items:flex-start;}';

  var observer = null;

  // 重复注入时先拆掉旧实例（observer/style），避免泄漏
  var prev = window.__zchModules && window.__zchModules[ID];
  if (prev && typeof prev.dispose === "function") prev.dispose();

  function fixSpan(span) {
    var title = span.getAttribute("title");
    if (title && span.textContent !== title) span.textContent = title;
  }

  function scan(nodes) {
    Array.prototype.forEach.call(nodes, function (node) {
      if (!(node instanceof Element)) return;
      if (node.matches(NAME_SELECTOR)) fixSpan(node);
      if (node.querySelectorAll) node.querySelectorAll(NAME_SELECTOR).forEach(fixSpan);
    });
  }

  window.__zchModules[ID] = {
    install: function () {
      var fresh = !observer;
      if (!fresh) return "already";
      var s = document.createElement("style");
      s.id = STYLE_ID;
      s.setAttribute("data-zch-module", ID);
      s.textContent = CSS;
      document.head.appendChild(s);
      observer = new MutationObserver(function (mutations) {
        mutations.forEach(function (m) {
          scan(m.addedNodes);
          // characterData/childList 更新会重置文本：受影响元素若在行内则补写
          if (m.target instanceof Element) {
            if (m.target.matches(NAME_SELECTOR)) fixSpan(m.target);
            else {
              var row = m.target.closest ? m.target.closest('[data-testid="virtual-project-root-row"]') : null;
              if (row) row.querySelectorAll(NAME_SELECTOR).forEach(fixSpan);
            }
          }
        });
      });
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      scan([document.documentElement]);
      // 诊断返回值：DOM 计数，用于真机排查
      return (
        "ok;names=" + document.querySelectorAll(NAME_SELECTOR).length +
        ";styleInDoc=" + !!document.getElementById(STYLE_ID)
      );
    },
    dispose: function () {
      if (observer) { observer.disconnect(); observer = null; }
      var s = document.getElementById(STYLE_ID);
      if (s) s.remove();
      return "ok";
    },
  };
})();
