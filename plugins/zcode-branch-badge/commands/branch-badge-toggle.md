---
description: 开关「git 分支徽章」模块（on / off / toggle，1 秒内生效）
---

用 Bash 运行。插件根目录优先取环境变量 `ZCODE_PLUGIN_ROOT`；若为空，用
`find ~/.zcode/cli/plugins -path '*zcode-branch-badge/scripts/zcode_helper.py' -print -quit`
定位后取其上两级目录：

    python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" loader toggle branch-badge <on|off|toggle>

说明：

- 该命令直接写用户级 `~/.zcode/cli/config.json`（本插件唯一真相），
  主进程 loader 会在 1 秒内注入或拆除模块，**无需重启**。
- 市场开关与本命令等效：拨动经 agent 落到当前项目的工作区 config，
  loader 会自动把它归位到用户级并清掉工作区那份，两边最终一致。
- 徽章数据来自本地 daemon（127.0.0.1:39217-39221）。
  `python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" daemon status` 可查。

用户附加要求：$ARGUMENTS