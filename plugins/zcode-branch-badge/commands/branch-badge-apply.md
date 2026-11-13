---
description: 给 ZCode 客户端应用「git 分支徽章」UI 补丁（修改 app.asar，需完全退出并重开 ZCode 生效）
---

用 Bash 运行。插件根目录优先取环境变量 `ZCODE_PLUGIN_ROOT`；若为空，用
`find ~/.zcode/cli/plugins -path '*zcode-branch-badge/scripts/zcode_helper.py' -print -quit`
定位后取其上两级目录：

    python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" apply $ARGUMENTS

脚本会解析 app.asar，压缩 index.html 启动动画 CSS 并注入 payload 加载标签，原始字节记录到 `~/.zcode/zcode-branch-badge/state.json`，可随时用 /branch-badge-restore 还原；payload 会同步到 `~/.zcode/zcode-branch-badge/inject/`。

结果处理：

- 输出「已应用」并提示重启时：明确告诉用户必须**完全退出** ZCode（菜单 → 退出，关闭窗口不算），再重新打开，补丁才会生效。
- 输出「无需修改 / 已应用」时，说明当前已经打过了，不需要重复操作；如果用户还没重启过，仍要提醒重启。
- 输出「目标文件未找到 / 目标代码未找到」时：说明当前 ZCode 版本与补丁不匹配。原样转述错误，建议用户运行 /branch-badge-status 查看详情，并把 ZCode 版本告诉维护者适配补丁。不要尝试自己改 app.asar。
- 没有写入权限时：原样转述脚本提示，不要自行使用 sudo。

用户附加要求：$ARGUMENTS
