/* zcode 模块：把插件市场开关的点击意图交给主进程 loader。
 *
 * 背景（实测）：ZCode 的插件市场开关不写 config.json，loader 只能从 UI 反推。
 * 早先用「每 2s 读 aria 状态 + 元素打标记」推断值变化，但 React 会重建这些
 * button，标记随之丢失，导致某些开关（实测 folder-full-path）的拨动永远检测
 * 不到。改为在 click 阶段记录意图：只认真实点击，不依赖元素身份。
 *
 * 协议：点击后等 React 提交（120ms）再读 aria-checked，把意图**追加**进
 * window.__zchMarketIntents 队列（带递增 seq，loader 按水位排水）——短时间
 * 连拨多个/同一个开关不会互相覆盖。同时保留写旧槽位 window.__zchMarketIntent
 * （单意图，会被覆盖）：兼容「桥接已更新、loader 未重启」的过渡窗口。
 * dispose 只摘监听、清旧槽位；队列保留（同页面世界的未排水意图不丢）。 */
(function () {
  "use strict";
  var ID = "market-switch-bridge";
  var SWITCH_SELECTOR = '[data-testid="plugin-store-enabled-switch"]';
  var COMMIT_DELAY_MS = 120;

  var prev = window.__zchModules && window.__zchModules[ID];
  if (prev && typeof prev.dispose === "function") prev.dispose();

  var onClick = null;

  function moduleOf(label) {
    if (!label) return null;
    var text = String(label);
    if (text.indexOf("分支") >= 0) return "branch-badge";
    if (text.indexOf("完整路径") >= 0 || text.indexOf("源文件夹") >= 0) return "folder-full-path";
    return null;
  }

  function switchFrom(target) {
    var node = target;
    while (node && node.nodeType === 1) {
      if (node.matches && node.matches(SWITCH_SELECTOR)) return node;
      node = node.parentNode;
    }
    return null;
  }

  function record(el) {
    var mod = moduleOf(el.getAttribute("aria-label"));
    if (!mod) return;
    // click 阶段 aria-checked 还是旧值，等 React 提交后再读
    setTimeout(function () {
      if (!el.isConnected) return;
      var checked = el.getAttribute("aria-checked");
      if (checked !== "true" && checked !== "false") return;
      window.__zchMarketSeq = (window.__zchMarketSeq || 0) + 1;
      var intent = {
        module: mod,
        enabled: checked === "true",
        seq: window.__zchMarketSeq,
        at: Date.now(),
      };
      // 队列：loader 按水位逐条排水，连拨不丢；封顶 50 条防止页面长期开着涨内存
      if (!Array.isArray(window.__zchMarketIntents)) window.__zchMarketIntents = [];
      window.__zchMarketIntents.push(intent);
      if (window.__zchMarketIntents.length > 50) {
        window.__zchMarketIntents.splice(0, window.__zchMarketIntents.length - 50);
      }
      // 旧槽位：兼容「新桥接 + 旧 loader」过渡窗口（插件已更新、ZCode 未重启）
      window.__zchMarketIntent = intent;
    }, COMMIT_DELAY_MS);
  }

  window.__zchModules[ID] = {
    install: function () {
      if (onClick) return "already";
      onClick = function (event) {
        try {
          var el = switchFrom(event.target);
          if (el) record(el);
        } catch (exc) {
          /* 点击处理失败不影响页面 */
        }
      };
      document.addEventListener("click", onClick, true);
      return "ok";
    },
    dispose: function () {
      if (onClick) {
        document.removeEventListener("click", onClick, true);
        onClick = null;
      }
      // 只清旧槽位；队列保留——同页面世界的未排水意图不因重注入丢失
      window.__zchMarketIntent = null;
      return "ok";
    },
  };
})();