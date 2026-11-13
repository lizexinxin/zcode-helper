/* zcode 模块：编辑项目源文件夹显示完整路径。
 *
 * 关键事实（3.18.2 bundle 实测）：name 元素的 children 是 r?t:fx(t)——
 * 非展开状态下 DOM 文本本身就是截断结果（fx(t)），完整路径只在 title
 * 属性里。因此纯 CSS 无法展开，必须用 JS 把文本替换为 title 的完整值；
 * React 重渲染会覆盖回来，靠 MutationObserver 自动补写。
 *
 * 两个必须遵守的约束：
 * 1) 只改文本节点，不用 textContent 赋值。textContent 会清空所有子节点，
 *    而 branch-badge 模块把徽章 append 进同一个 name span——用 textContent
 *    会让两个模块每 300ms 互相删一次（徽章看不见）。
 * 2) MutationObserver 回调里同步修正，不要 setTimeout 延后。回调在微任务里
 *    执行、早于本次渲染的 paint，同步改完用户看不到截断名（否则会先闪一下
 *    文件夹名再变成全路径）。全量扫描只作 1s 兜底，覆盖 title 后到等漏网。
 * dispose 拆除 observer 并把替换过的文本恢复原文，关开关立即还原。
 * 由主进程 loader 注入执行（见 shared/loader.cjs 的模块协议）。 */
(function () {
  "use strict";
  var ID = "folder-full-path";
  var STYLE_ID = "zch-" + ID + "-style";
  var NAME_SELECTOR = '[data-testid="virtual-project-root-name"]';
  var MARK = "data-zch-ffp";
  var FULL_SCAN_MS = 1000;
  var CSS =
    NAME_SELECTOR + "{" +
    "white-space:normal;word-break:break-all;overflow:visible;text-overflow:unset;}";

  var observer = null;
  var fullScanTimer = null;

  // 重复注入时先拆掉旧实例，避免 observer/style 泄漏
  var prev = window.__zchModules && window.__zchModules[ID];
  if (prev && typeof prev.dispose === "function") prev.dispose();

  function textNodeOf(span) {
    var nodes = span.childNodes || [];
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].nodeType === 3) return nodes[i];
    }
    return null;
  }

  function remember(span, original) {
    // 首次替换时记录原文，dispose 时恢复；已有的标记不覆盖
    if (span.getAttribute(MARK)) return;
    span.setAttribute(MARK, "1");
    span.setAttribute(MARK + "-original", original == null ? "" : original);
  }

  function fixSpan(span) {
    if (!span || typeof span.getAttribute !== "function") return false;
    // 双保险：observer 是全页监听 title，ZCode 里其它组件（composer 模型按钮、
    // 思考强度值等）的 title 也会变化；非项目名 span 一律不碰，否则会把 title
    // 文本写进 React 管理的节点，重渲染后新旧节点叠加（2026-11-13 实测模型名
    // 被刷成三份、思考强度值出现「最高最高」）。
    if (typeof span.matches === "function" && !span.matches(NAME_SELECTOR)) return false;
    var title = span.getAttribute("title");
    if (!title) return false;

    var text = textNodeOf(span);
    if (text) {
      if (text.nodeValue === title) return false;
      remember(span, text.nodeValue);
      text.nodeValue = title; // 只动文本节点：徽章等元素子节点原样保留
      return true;
    }

    // 没有文本节点（空名等）：补一个放在最前，不碰已有子元素
    remember(span, span.textContent);
    var node = document.createTextNode(title);
    if (typeof span.insertBefore === "function") span.insertBefore(node, span.firstChild || null);
    else span.appendChild(node);
    return true;
  }

  function scanRoot(root) {
    var stats = { names: 0, fixed: 0 };
    if (!root) return stats;
    if (root.nodeType === 1 && typeof root.matches === "function" && root.matches(NAME_SELECTOR)) {
      stats.names += 1;
      if (fixSpan(root)) stats.fixed += 1;
    }
    var spans = typeof root.querySelectorAll === "function"
      ? root.querySelectorAll(NAME_SELECTOR)
      : [];
    stats.names += spans.length;
    for (var i = 0; i < spans.length; i++) {
      if (fixSpan(spans[i])) stats.fixed += 1;
    }
    return stats;
  }

  function scanAll() {
    return scanRoot(document.documentElement || document);
  }

  /* MutationObserver 回调是微任务：此时 DOM 已提交、paint 还没发生，
   * 同步修正的文本用户看不到中间态。 */
  function handleMutations(records) {
    var sawElement = false;
    for (var i = 0; i < records.length; i++) {
      var record = records[i];
      if (record.type === "attributes") {
        /* title 后到：React 可能先渲染 span（截断名、无 title）、下一次 commit
         * 才补 title。只看 childList 会漏掉这次，只能等 1s 兜底——那 1s 就是
         * 用户看到的「闪一下」。 */
        /* 必须确认 target 确实是项目名 span：这是全页 title 监听，composer 等
         * 组件的 title 变化绝不能进 fixSpan（见 fixSpan 入口注释）。 */
        var target = record.target;
        if (target && target.nodeType === 1 && typeof target.matches === "function" &&
            target.matches(NAME_SELECTOR)) {
          try { fixSpan(target); } catch (exc) { /* 单个节点失败忽略 */ }
        }
        continue;
      }
      var added = record.addedNodes || [];
      for (var j = 0; j < added.length; j++) {
        var node = added[j];
        if (!node) continue;
        if (node.nodeType === 3) {
          // React 有可能整体替换文本节点：直接修父级 name span
          var parent = node.parentNode;
          if (parent && parent.nodeType === 1 && typeof parent.matches === "function" &&
              parent.matches(NAME_SELECTOR)) {
            try { fixSpan(parent); } catch (exc) { /* 单个节点失败不影响其他 */ }
          }
        } else if (node.nodeType === 1) {
          sawElement = true;
          try { scanRoot(node); } catch (exc) { /* 以上同 */ }
        }
      }
    }
    if (sawElement) scheduleFullScan();
  }

  function scheduleFullScan() {
    if (fullScanTimer) return; // 已排队：合并成一次
    fullScanTimer = setTimeout(function () {
      fullScanTimer = null;
      try { scanAll(); } catch (exc) { /* 扫描失败不影响页面 */ }
    }, FULL_SCAN_MS);
  }

  window.__zchModules[ID] = {
    install: function () {
      if (observer) return "already";
      var s = document.createElement("style");
      s.id = STYLE_ID;
      s.setAttribute("data-zch-module", ID);
      s.textContent = CSS;
      document.head.appendChild(s);
      observer = new MutationObserver(handleMutations);
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["title"], // 路径只在 title 里；它后到也必须立刻修正
      });
      var r = scanAll();
      return "ok;names=" + r.names + ";fixed=" + r.fixed;
    },
    dispose: function () {
      if (fullScanTimer) { clearTimeout(fullScanTimer); fullScanTimer = null; }
      if (observer) { observer.disconnect(); observer = null; }
      var s = document.getElementById(STYLE_ID);
      if (s) s.remove();
      // 恢复被替换的文本节点（徽章等元素子节点不动）
      var marked = document.querySelectorAll("[" + MARK + "]");
      for (var i = 0; i < marked.length; i++) {
        var span = marked[i];
        var original = span.getAttribute(MARK + "-original");
        var text = textNodeOf(span);
        if (text && original != null) text.nodeValue = original;
        span.removeAttribute(MARK);
        span.removeAttribute(MARK + "-original");
      }
      return "ok";
    },
  };
})();