# 设计：主进程 loader 运行时注入（开关即时生效）

日期：2026-11-13
状态：已与用户确认（路线 B）
前置调研：ZCode 无插件启停生命周期钩子；开关状态实时落盘于 `~/.zcode/cli/config.json` → `plugins.enabledPlugins`；ZCode 进程无调试端口；asar 补丁只在启动时加载，运行中不可能即时变化。

## 背景与目标

两个 UI 插件（folder-full-path、branch-badge）目前用"等长原地替换 app.asar 字节"实现，关闭插件开关不会还原补丁，且任何改动都需要重启 ZCode。

目标：

1. 市场开关拨动后**运行中即时生效**：开 → 注入 UI 修改，关 → 完全拆除，DOM 立即变化，零重启。
2. asar 只装一次引导指针；之后所有功能代码都在磁盘上，更新功能、样式不再触碰 asar。
3. ZCode 升级后可自动恢复；`loader remove` + 关开关 = 完全回到原版，无残留。

## 架构总览

```
ZCode 主进程（常驻）
 └─ loader.cjs            ← asar 内只有一行 dynamic import 指针；loader 本体在数据目录
     ├─ fs.watch ~/.zcode/cli/config.json（enabledPlugins）
     ├─ 开关变化 → webContents.executeJavaScript(install / dispose)
     └─ web-contents-created / dom-ready → 自动重放已启用模块（幂等）

ZCode 渲染进程（运行中）
 └─ 注入模块（纯 JS，无 asar 修改，install()/dispose() 成对）
     ├─ folder-full-path：插/拔 <style> 覆盖截断样式
     └─ branch-badge：插/拔徽章 DOM + 轮询 daemon

数据源：zch_branch_daemon.py 保持不变
```

## 组件设计

### 1. 引导安装（一次性，需重启一次）

- 在 `out/main/index.js` 尾部追加一行 `import("<DATA_DIR>/loader.cjs")`。主入口为 ESM，dynamic import 是参考实现（谭冉冉 overlay 插件）验证过的可行路线。
- 指针指向 `~/.zcode/zcode-helper/loader.cjs`（asar 外的绝对路径）。loader 更新永不触发重打包。
- `zcode_helper.py` 新增命令：
  - `loader install`：追加指针行 + 整包重打包 asar（重写 header、重算 integrity，流式拷贝其余文件，约 307MB）。幂等：已安装时跳过。
  - `loader remove`：剥离指针行 + 重打包，对称回滚。
  - `loader status`：报告指针是否在位、loader 文件版本、与 config 中插件开关的一致性。
- 安装/移除后提示"完全退出重开一次 ZCode"。这是最后一次因安装插件而重启。

### 2. 主进程 loader（CommonJS，常驻主进程）

- 启动即读 `enabledPlugins`，对所有窗口型 webContents 注入已启用模块。
- `fs.watch` 配置文件 + 防抖（~300ms）；映射：`zcode-folder-full-path@<market>` → ffp 模块、`zcode-branch-badge@<market>` → badge 模块（按 plugin id 前缀匹配，不依赖 marketplace 后缀）。
- 开 → executeJavaScript(`install`)；关 → executeJavaScript(`dispose`)。
- `web-contents-created` + `dom-ready` 上自动重放（新窗口、页面刷新后恢复）。模块幂等，靠 marker 防重复。
- 所有异常 try/catch 写 `~/.zcode/zcode-helper/loader.log`，绝不抛向主进程。

### 3. 渲染层注入模块

每个模块是独立 `.js` 文件，定义 `install()` / `dispose()`，幂等：

- **folder-full-path（纯 CSS）**：install 时插入覆盖截断样式的 `<style id="zch-ffp">`，锚定编译产物中的稳定选择器（如 `[data-testid="virtual-project-root-name"]` 所在容器，实施期以真机 DOM 为准）；dispose 移除该 style。
- **branch-badge**：现有 `inject/branch-badge.js` 逻辑包进 install/dispose；install 渲染徽章 + 轮询 daemon HTTP；dispose 移除 DOM、断开 observer、停定时器。
- 模块文件存放于数据目录；loader **每次注入都从磁盘现读** → 改模块文件后，下次切换开关或页面刷新即用新版。

### 4. 引擎与插件结构变化

- 等长替换补丁路线（`patches/*.json`、`apply`/`restore`/`auto`）对这两个插件退役；现有 asar 已还原，干净起点。等长替换的底层 asar 解析代码保留（重打包要用 header 解析）。
- SessionStart hook 语义变更：不再自动重打字节补丁，改为——检查 loader 指针是否在位；ZCode 升级导致丢失且 `autoApply != false` 时自动重装（重打包）并提示重启一次；顺带检查开关与实际注入状态一致性（loader 自身日志为准）。
- branch daemon 拉起逻辑保留（hook 内 best-effort）。
- 引擎真源仍在 `shared/`，插件目录为副本，同步测试沿用。

## 错误处理

- executeJavaScript 失败（窗口未就绪）→ dom-ready 重试。
- ZCode 升级重写 asar → 指针丢失 → hook 自动重装 → 重启一次恢复；UI 模块不受影响。
- loader 崩溃 → 全量 catch + 日志，不崩主进程；下次 dom-ready 重放兜底。
- config.json 被并发写 → fs.watch 防抖 + 读失败重试一次。

## 测试

- Python（pytest）：
  - 重打包往返：小型合成 asar 上 install → status → remove，字节级还原比对。
  - 指针行追加/剥离幂等性。
  - enabledPlugins → 模块映射逻辑。
  - 模块文件同步测试沿用现有 engine_sync。
- JS 模块：node + 最小 DOM stub 测 install/dispose 幂等；最终以真机验证为准。
- 真机验收：拨开关即时变化；重启后状态保持；升级场景用假 asar 模拟。

## 明确不做（YAGNI）

- 不做 CDP 调试端口路线。
- 不做跨插件通用模块市场；模块仅服务本插件集。
- 不改 branch daemon。

## 迁移

- 用户侧：首次升级到本版本时自动 `loader install`（或提示执行），重启一次；之后开关即拨即生效。
- 旧字节补丁已还原，无残留清理需求。
