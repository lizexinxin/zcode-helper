---
description: 开关「源文件夹完整路径」模块（on / off / toggle，1 秒内生效）
---

用 Bash 运行。插件根目录优先取环境变量 `ZCODE_PLUGIN_ROOT`；若为空，用
`find ~/.zcode/cli/plugins -path '*zcode-folder-full-path/scripts/zcode_helper.py' -print -quit`
定位后取其上两级目录：

    python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" loader toggle folder-full-path <on|off|toggle>

说明：

- 该命令直接写用户级 `~/.zcode/cli/config.json`（本插件唯一真相），
  主进程 loader 会在 1 秒内注入或拆除模块，**无需重启**。
- 市场开关与本命令等效：拨动经 agent 落到当前项目的工作区 config，
  loader 会自动把它归位到用户级并清掉工作区那份，两边最终一致。
- 想确认状态：`python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" loader status`
  并看 `~/.zcode/zcode-helper/loader.log` 里的「开关变化」行。

用户附加要求：$ARGUMENTS