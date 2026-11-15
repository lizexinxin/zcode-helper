---
name: zcode-branch-badge
description: ZCode 桌面客户端「git 分支徽章」。用户想在编辑项目的源文件夹列表里看到每个 git 仓库的当前分支（如 ⎇ main）、询问徽章为什么不显示、启动/排查本地分支服务（zch-branch-daemon），或想查看状态/卸载注入时使用。
---

# ZCode Branch Badge

ZCode 的「编辑项目 → 源文件夹」列表中，本插件为每个 git 仓库文件夹在路径后显示当前
分支徽章（`⎇ main`；detached HEAD 显示 `HEAD@<短SHA>`；非 git 目录不显示）。

原理：主进程 loader + 运行时注入。SessionStart / UserPromptSubmit hook 自动执行
`loader install`（幂等）：首次安装往 `app.asar` 的主进程入口写入一行 dynamic `import()`
指针（整包重打包，约 307MB），指向磁盘上的 `~/.zcode/zcode-helper/loader.cjs`；loader
常驻主进程，监听 `~/.zcode/cli/config.json` 的 `enabledPlugins`，用
`webContents.executeJavaScript` 注入/拆除渲染模块（branch-badge 模块向本地
`zch-branch-daemon` 查询分支）。**不修改任何压缩 JS**。

## 生效流程（装好后只需重启一次）

1. 安装并启用插件后，打开一个已存在的会话，或新开一个会话并随便发一条消息 →
   自动安装 loader + 拉起分支服务并给出提示（含系统通知）。
2. **完全退出 ZCode**（菜单 → 退出，关闭窗口不算）再重新打开一次——这是唯一一次手动
   步骤，也是最后一次因本插件重启。
3. 之后一切变更（开关拨动、模块更新）即时生效、零重启。

## 何时使用本 skill

- 用户问「装了为什么不显示」「还要做什么」→ 运行 `loader status` + `daemon status`
  并按状态解读处理。
- 用户想卸载注入 → `loader remove`。
- ZCode 升级后注入丢失 → hook 会自动重装指针，重启一次即可恢复。

## 命令

脚本位置：`${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py`（若环境变量为空，用
`find ~/.zcode/cli/plugins -path '*zcode-branch-badge*/scripts/zcode_helper.py' -print -quit` 定位）。

```bash
python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" loader install   # 幂等安装指针
python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" loader status    # 安装/激活/模块状态
python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" loader remove    # 剥离指针还原原版
python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" loader toggle branch-badge <on|off|toggle>
python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" daemon start     # 拉起分支服务（幂等）
python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" daemon status
python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" doctor
```

对应 slash 命令：`/branch-badge-apply`、`/branch-badge-status`、
`/branch-badge-restore`、`/branch-badge-toggle`。

## 状态解读（loader status）

- `已安装(已激活)`：指针在位且 loader 活着（active.json 的 pid 判活），界面应当已生效。
- `已安装(未激活)`：指针已写但 ZCode 还没重启 → 让用户完全退出并重开一次。
- `未安装`：运行 `loader install`；hook 也会在下次触发时自动安装。
- `loader 文件 缺失`：运行 `loader install` 同步资产到 `~/.zcode/zcode-helper/`。

## 分支服务（zch-branch-daemon）

- 只绑定 127.0.0.1，端口 39217-39221 选第一个空闲的；`GET /branch?path=<绝对路径>`
  返回 `{"label": "main" | "HEAD@xxx" | null}`，内部只做只读 `git branch --show-current`。
- hook 每次触发时 best-effort 拉起；也可用 `daemon start` 手动启动（幂等）。
- **daemon 未运行、目录不是 git 仓库、或查询失败时徽章静默不显示**，不影响 ZCode 功能。
- 安全边界：仅监听回环地址、只做只读 git 查询；日志在 `~/.zcode/zcode-branch-badge/daemon.log`。

## 工作原理与安全边界

1. asar 里只写一行指针；`loader remove` 对称剥离还原原版。
2. 渲染模块每次注入都从磁盘现读（`~/.zcode/zcode-helper/modules/*.js`）：改模块代码，
   下次注入即用新版，零重启。
3. 注入只做界面显示；徽章数据仅访问 127.0.0.1 的本地 daemon。

## 配置开关（~/.zcode/zcode-branch-badge/config.json）

- `{"autoApply": false}`：关闭 hook 自动安装（默认开启；daemon 拉起不受影响）。
- `{"notify": false}`：关闭「请重启 ZCode」的 macOS 系统通知（默认开启）。

## 故障排查

- **徽章不显示**：① `loader status` 是否「已安装(已激活)」，未激活 → 完全重启 ZCode；
  ② `daemon status` 是否运行，没运行就 `daemon start`；③ 目录是否 git 仓库；
  ④ 仍不生效 → 看 `~/.zcode/zcode-helper/loader.log` 与 daemon.log。
- **hook 提示安装失败 / 没有写入权限**：把 ZCode 复制到 `~/Applications` 后用 `--asar`
  指向，或用 sudo 运行 `loader install`（不要让会话里的助手自行 sudo）。
- **ZCode 升级后失效**：升级会替换整个 .app；下次会话 hook 自动重装指针，重启一次恢复。
- **想彻底移除**：`loader remove` + 重启 ZCode，再在 设置 → 插件 里禁用或卸载本插件。
