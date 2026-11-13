/* zcode 模块：编辑项目源文件夹显示完整路径（纯 CSS，install/dispose 可逆）。
 * 依据：路径元素有稳定钩子 [data-testid="virtual-project-root-name"]，
 * 截断由 .truncate 类（nowrap/ellipsis）实现，CSS 覆盖即可，无需改 React。
 * 由主进程 loader 注入执行（见 shared/loader.cjs 的模块协议）。 */
(function () {
  "use strict";
  var ID = "folder-full-path";
  var STYLE_ID = "zch-" + ID + "-style";
  var CSS =
    '[data-testid="virtual-project-root-name"]{' +
    "white-space:normal;word-break:break-all;overflow:visible;text-overflow:unset;}" +
    '[data-testid="virtual-project-root-row"]{align-items:flex-start;}';

  window.__zchModules[ID] = {
    install: function () {
      var fresh = !document.getElementById(STYLE_ID);
      if (fresh) {
        var s = document.createElement("style");
        s.id = STYLE_ID;
        s.setAttribute("data-zch-module", ID);
        s.textContent = CSS;
        document.head.appendChild(s);
      }
      // 诊断返回值：行/名称元素计数，用于真机排查选择器是否命中
      var diag =
        "rows=" + document.querySelectorAll('[data-testid="virtual-project-root-row"]').length +
        ";names=" + document.querySelectorAll('[data-testid="virtual-project-root-name"]').length +
        ";anyVirtualRoot=" + document.querySelectorAll('[data-testid^="virtual-project-root"]').length +
        ";iframes=" + document.querySelectorAll("iframe").length +
        ";styleInDoc=" + !!document.getElementById(STYLE_ID);
      return (fresh ? "ok;" : "already;") + diag;
    },
    dispose: function () {
      var s = document.getElementById(STYLE_ID);
      if (s) s.remove();
      return "ok";
    },
  };
})();
