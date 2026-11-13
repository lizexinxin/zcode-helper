---
description: 还原 zcode-helper 对 ZCode 客户端做的全部 UI 补丁（恢复 app.asar 原始字节）
---

用 Bash 运行。插件根目录优先取环境变量 `ZCODE_PLUGIN_ROOT`；若为空，用
`find ~/.zcode/cli/plugins -path '*zcode-helper/scripts/zcode_helper.py' -print -quit`
定位后取其上两级目录：

    python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" restore $ARGUMENTS

脚本会按 `~/.zcode/zcode-helper/state.json` 中记录的原始字节精确写回。如果 ZCode 已经升级、记录位置的内容不再是补丁后的内容，脚本会跳过并提示，不会破坏新版本。

结果处理：

- 输出「已还原」：告诉用户完全退出并重新打开 ZCode 后恢复原样。
- 输出「没有本补丁的安装记录 / 无需还原」：说明当前没有可还原的补丁。
- 输出「记录位置的内容已变化」：说明 ZCode 已升级，补丁本来就已经失效，不需要（也不能）还原。

用户附加要求：$ARGUMENTS