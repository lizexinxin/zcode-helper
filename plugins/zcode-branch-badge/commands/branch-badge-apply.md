---
description: 确保主进程 UI 注入 loader 在位（首次安装需重启一次 ZCode，此后插件开关即时生效）
---

用 Bash 运行。插件根目录优先取环境变量 `ZCODE_PLUGIN_ROOT`；若为空，用
`find ~/.zcode/cli/plugins -path '*zcode-branch-badge/scripts/zcode_helper.py' -print -quit`
定位后取其上两级目录：

    python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" loader install

幂等操作：已安装时无动作。首次安装会同步 loader 资产到 `~/.zcode/zcode-helper/` 并整包重打包 app.asar 写入指针行。

结果处理：

- 输出「已安装」并提示重启时：告诉用户必须**完全退出** ZCode（菜单 → 退出，关闭窗口不算），再重新打开一次。这是最后一次因安装而重启——此后插件市场的开关拨动即时生效。
- 输出「已在位」时：无需任何操作，开关拨动即生效。
- 没有写入权限或其他错误时：原样转述脚本提示，不要自行使用 sudo。

用户附加要求：$ARGUMENTS
