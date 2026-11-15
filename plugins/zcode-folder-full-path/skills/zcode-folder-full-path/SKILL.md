---
name: zcode-folder-full-path
description: ZCode 桌面客户端「源文件夹完整路径」。用户想编辑项目时看到源文件夹完整路径、询问"为什么文件夹只显示名字""同名文件夹分不清"、询问插件装上后为什么不生效/还要做什么，或想查看状态/卸载注入时使用。
---

# ZCode Folder Full Path

ZCode 的「编辑项目 → 源文件夹」列表原本只显示文件夹名（basename），hover 才能看到完整
路径。本插件把显示改为完整路径并允许换行。

原理：主进程 loader + 运行时注入。SessionStart / UserPromptSubmit hook 自动执行
`loader install`（幂等）：首次安装往 `app.asar` 的主进程入口写入一行 dynamic `import()`
指针（整包重打包，约 307MB），指向磁盘上的 `~/.zcode/zcode-helper/loader.cjs`；loader
常驻主进程，监听 `~/.zcode/cli/config.json` 的 `enabledPlugins`，用
`webContents.executeJavaScript` 注入/拆除渲染模块。**不修改任何压缩 JS**。

## 装上即生效

1. 安装并启用插件后，在任意会话里发一条消息（UserPromptSubmit hook）或开新会话
   （SessionStart hook）→ 自动安装 loader 并给出提示（含 macOS 系统通知）。
2. **完全退出 ZCode**（菜单 → 退出，关闭窗口不算）再重新打开一次——这是唯一一次手动
   步骤，也是最后一次因本插件重启。
3. 之后一切变更（开关拨动、模块更新）即时生效、零重启。

## 何时使用本 skill

- 用户问「装了为什么不生效」「还要做什么」→ 运行 `loader status` 并按状态解读处理。
- 用户想卸载注入、还原原版界面 → `loader remove`。
- ZCode 升级后注入丢失 → hook 会自动重装指针，重启一次即可恢复。

## 命令

脚本位置：`${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py`（若环境变量为空，用
`find ~/.zcode/cli/plugins -path '*zcode-folder-full-path*/scripts/zcode_helper.py' -print -quit` 定位）。

```bash
python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" loader install   # 幂等安装指针
python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" loader status    # 安装/激活/模块状态
python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" loader remove    # 剥离指针还原原版
python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" loader toggle folder-full-path <on|off|toggle>
python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" doctor           # 诊断 asar
```

全局参数 `--asar PATH` 可指向非默认安装位置；`--json` 输出机器可读结果。

对应 slash 命令：`/folder-full-path-apply`、`/folder-full-path-status`、
`/folder-full-path-restore`、`/folder-full-path-toggle`。

## 状态解读（loader status）

- `已安装(已激活)`：指针在位且 loader 活着（active.json 的 pid 判活），界面应当已生效。
- `已安装(未激活)`：指针已写但 ZCode 还没重启 → 让用户完全退出并重开一次。
- `未安装`：运行 `loader install`；hook 也会在下次触发时自动安装。
- `loader 文件 缺失`：运行 `loader install` 同步资产到 `~/.zcode/zcode-helper/`。

## 工作原理与安全边界

1. asar 里只写一行指针；`loader remove` 对称剥离还原原版。
2. 渲染模块每次注入都从磁盘现读（`~/.zcode/zcode-helper/modules/*.js`）：改模块代码，
   下次注入即用新版，零重启。
3. 注入只做界面显示，不读取文件、不发出外部网络请求。

## 配置开关（~/.zcode/zcode-folder-full-path/config.json）

- `{"autoApply": false}`：关闭 hook 自动安装（默认开启）。
- `{"notify": false}`：关闭「请重启 ZCode」的 macOS 系统通知（默认开启）。

## 故障排查

- **界面没变化**：① `loader status` 是否「已安装(已激活)」；② 未激活 → 完全重启 ZCode
  （菜单 → 退出，关闭窗口不算）；③ 已激活仍不生效 → 看
  `~/.zcode/zcode-helper/loader.log` 的「注入」行。
- **hook 提示安装失败 / 没有写入权限**：把 ZCode 复制到 `~/Applications` 后用 `--asar`
  指向，或用 sudo 运行 `loader install`（不要让会话里的助手自行 sudo）。
- **ZCode 升级后失效**：升级会替换整个 .app；下次会话 hook 自动重装指针，重启一次恢复。
- **想彻底移除**：`loader remove` + 重启 ZCode，再在 设置 → 插件 里禁用或卸载本插件。
