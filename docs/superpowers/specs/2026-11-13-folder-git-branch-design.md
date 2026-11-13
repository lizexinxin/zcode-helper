# 设计文档：folder-git-branch 补丁（编辑项目弹窗显示 git 分支）

日期：2026-11-13
状态：设计已确认（方案 A）
前置补丁：`folder-full-path`（非硬依赖，见 §3）

## 1. 背景与目标

ZCode「编辑项目 → 源文件夹」列表目前每行只渲染路径字符串。用户的项目经常关联多个
git 仓库，希望在该列表里直观看到每个文件夹当前所在的分支。

目标行为：

- 弹窗打开后，每个是 git 仓库的源文件夹路径后面显示一个小徽章（如 `⎇ main`）；
- 非 git 目录、远程路径、daemon 不可达时不显示任何东西（静默降级）；
- 不影响 ZCode 其他界面和功能。

调查结论（2026-11-13，ZCode 桌面版实测）：

- 分支数据不在现有 DOM 里，必须新增运行时逻辑；
- ZCode 自身有 `gitService.getRepositorySummary` 及任务列表分支标签组件
  （`Bkt`），但复用其 RPC 通道需要模仿协议（方案 C），脆弱性最高，已否决；
- renderer 是 `contextIsolation + sandbox`，注入脚本无 Node 权限，`fetch file://`
  被禁，因此必须有一条数据通路（方案 A 用本地 HTTP 服务，方案 B 用 preload/main
  IPC，方案 B 需要扩展补丁引擎做整文件内容追加，复杂度和风险更高，已否决）；
- 弹窗每行有稳定的 `data-testid="virtual-project-root-row"` /
  `"virtual-project-root-name"` 语义钩子；name 节点的 `title` 属性始终是完整路径；
- `out/renderer/index.html` 无 CSP，且 Vite 构建保留了原始多行 CSS 排版和注释
  （约 2.5KB 可压缩到约 0.7KB），是现成的等长替换注入点。

## 2. 总体架构

```
┌─ ZCode 编辑项目弹窗（renderer，file:// 加载）─────────────┐
│  index.html —— 等长替换补丁注入一行 script 标签           │
│    └─ <script src="file:///Users/<user>/.zcode/zcode-helper/inject/branch-badge.js">
│         └─ payload：MutationObserver 盯行元素，           │
│              fetch http://127.0.0.1:<port>/branch?path=…  │
└───────────────────────────────────────────────────────────┘
                     ▲ HTTP（仅回环）
┌─ zch-branch-daemon（Python，插件自带，随 hook 拉起）───────┐
│  收到 path → 存在性检查 → execFile git → {label}          │
└───────────────────────────────────────────────────────────┘
```

关键原则：

- asar 内**只有 index.html 一处等长替换**，完全兼容现有补丁引擎
  （find/replace 等长 + 空格补齐），不扩展引擎的重打包能力；
- 所有复杂逻辑放在 asar 外部的可测试文件里（payload JS、daemon Python）；
- 不碰任何压缩后的 React/JS 代码，对 ZCode 升级耐受性最好。

## 3. asar 补丁 `folder-git-branch.json`

- **locate**：
  - `pathPrefix: "out/renderer/"`、`pathSuffix: "index.html"`；
  - `contains` 用启动动画 CSS 的独有关键字（`zcode-startup-ready`、
    `startup-logo-pop`）确保唯一命中；
  - `minSize` 按实际 index.html 大小设下限（约 30000）。
- **find**：一段唯一、可安全压缩的 CSS 区域（启动 logo 动画的多行 CSS +
  其中的中文注释 `/* 修复原因：… */`），具体字节范围在实施时测量确定。
- **replace**：
  1. 压缩后的等效 CSS（仅去换行/空白/注释，选择器与规则语义不变）；
  2. 紧跟一段 `<script src="file:///…/.zcode/zcode-helper/inject/branch-badge.js">
     </script>`；
  - 总长 ≤ find 长度，差额由引擎空格补齐（补在 </script> 之后的空白区域即可，
    HTML 中尾部空白无副作用）。
- **expectedCount**: 1。
- **兼容性说明**：
  - 若未来 ZCode 发布压缩过的 index.html（无可压缩空白），patch 会
    `pattern_not_found`，status/doctor 如实报告，需适配新版本；
  - script 标签路径指向 `~/.zcode/zcode-helper/inject/`（DATA_DIR），与插件
    版本号无关，插件升级换 cache 目录不影响；
  - 路径含用户名，属用户专属硬编码（自用插件可接受）；换机器需改 patch JSON。
- **payload 同步**：`zcode_helper.py apply` 在应用本补丁后，把插件目录
  `inject/*.js` 复制到 `~/.zcode/zcode-helper/inject/`（源文件随插件三副本
  同步规则维护，apply 时自动落到固定路径）。
- **还原**：restore 记录原始字节，逐字节还原 index.html；payload 文件留在
  DATA_DIR（无害，不被任何页面引用）。

## 4. payload（inject/branch-badge.js）

纯浏览器 JS，无依赖：

- **发现行元素**：`document.body` 上挂 MutationObserver（subtree），命中
  `[data-testid="virtual-project-root-row"]` 的新增/变更节点；
- **取路径**：读行内 `[data-testid="virtual-project-root-name"]` 的 `title`
  属性（始终为完整路径，不依赖 folder-full-path 补丁是否生效）；
- **取分支**：`fetch("http://127.0.0.1:<port>/branch?path=" + encodeURIComponent(p))`
  ，端口在 39217-39221 中依次探测（先 `/ping`，首个 200 即为 daemon）；探测
  结果缓存到本次页面生命周期；
- **渲染**：`label` 非空时在 name 节点后插入兄弟徽章
  `<span class="zch-branch-badge" data-zch-branch="1">⎇ main</span>`；
  样式优先复用应用全局样式表的既有 utility 类（`text-ui-sm`
  `text-foreground-subtle`），再加少量内联样式（圆角、内边距）保证外观稳定；
  `label` 为 null（非 git / 远程路径）时不插入任何节点；
- **去重与刷新**：行级标记（挂过徽章的行打 `data-zch-branch-done`）+
  每路径 2 秒 TTL 缓存；React 重渲染重建行元素时 observer 再次触发、徽章
  自动补挂；observer 回调需过滤自身插入的节点，避免死循环；
- **降级**：fetch 失败（daemon 未启动/端口未监听）→ 静默跳过，不重试风暴
  （失败路径短 TTL 2s 内不重查），不弹任何错误。

## 5. 辅助服务（zch-branch-daemon.py）与集成

- **端口**：39217-39221 内绑定第一个空闲的；仅绑定 `127.0.0.1`；
- **接口**：
  - `GET /ping` → 200 `ok`（payload 探测用）；
  - `GET /branch?path=<abs>` → 200 `{"label": "main"}`；
    - 路径必须存在且是目录，否则 `{"label": null}`；
    - `git -C <path> branch --show-current` 非空 → 该分支名；
    - 为空（detached HEAD）→ `git -C <path> rev-parse --short HEAD` →
      `HEAD@<sha>`；
    - 上述 git 命令失败（非仓库）→ `{"label": null}`；
  - 全部响应带 `Access-Control-Allow-Origin: *`（file:// 的 null origin 可通）；
- **幂等启动**：启动时先探测既有实例（ping 端口段），存活则直接退出；
- **拉起途径**：
  1. `session-start.py` hook 追加 best-effort 调用（子进程分离启动，不阻塞
     hook，失败不影响原逻辑）；
  2. `zcode_helper.py daemon start` 手动启动、`daemon status` 查看健康；
- **安全边界**（写入 README）：仅监听回环地址；接口只做只读 git 查询；对
  path 参数做存在性检查；本机其他进程理论上也能调用（自用可接受）。

## 6. 脚本与 hook 改动（zcode_helper.py / session-start.py）

- `apply`：应用 folder-git-branch 后同步 `inject/*.js` 到
  `~/.zcode/zcode-helper/inject/`；
- 新增 `daemon start|status` 子命令（`status` 探测端口段返回 JSON：运行中
  端口、pid、未运行）；
- `status`/`doctor`：额外输出 daemon 健康状态一行（未运行不视为补丁失效）；
- `session-start.py`：末尾追加 daemon best-effort 拉起。

## 7. 测试

- **补丁引擎**（test_patch_engine.py）：合成 asar 含多行格式化 index.html +
  唯一 CSS 关键字 → apply 后 script 标签存在、asar 总大小不变 → restore 后
  index.html 逐字节等于原始内容；
- **daemon**：子进程启动 daemon（端口段由环境变量 `ZCH_BRANCH_PORTS` 覆盖，
  默认 39217-39221）→ 对
  临时 `git init` 目录查询返回其分支 → 对不存在路径/非仓库返回
  `{"label": null}` → `/ping` 200；
- **payload**：手动验收（打开编辑项目弹窗看徽章；kill daemon 看静默降级；
  切分支后重开弹窗看刷新）。

## 8. 交付物清单

| 文件 | 说明 |
|---|---|
| `plugins/zcode-helper/patches/folder-git-branch.json` | index.html 等长替换补丁 |
| `plugins/zcode-helper/inject/branch-badge.js` | 渲染徽章的 payload |
| `plugins/zcode-helper/scripts/zch_branch_daemon.py` | 本地分支查询服务 |
| `plugins/zcode-helper/scripts/zcode_helper.py` | apply 同步 payload、daemon 子命令、status/doctor 输出 |
| `plugins/zcode-helper/hooks/session-start.py` | best-effort 拉起 daemon |
| `tests/test_patch_engine.py`、`tests/test_branch_daemon.py` | 测试 |
| `README.md` | 新补丁说明 + daemon 安全边界 |

按既有规则，插件文件改动需同步三处副本（仓库 / marketplace / cache）。
