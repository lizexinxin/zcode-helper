---
description: 开关「git 分支徽章」模块（on / off / toggle，1 秒内生效）
---

用 Bash 运行。插件根目录优先取环境变量 `ZCODE_PLUGIN_ROOT`；若为空，用
`find ~/.zcode/cli/plugins -path '*zcode-branch-badge/scripts/zcode_helper.py' -print -quit`
定位后取其上两级目录：

    python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" loader toggle branch-badge <on|off|toggle>

说明：

- 该命令写插件启用状态：用户级 `~/.zcode/cli/config.json` 必写；当前目录
  存在 `.zcode/config.json`（工作区级）时两层一起对齐，否则合并视图下会被
  工作区层盖回去。主进程 loader 读同一份合并视图，1 秒内注入或拆除模块，
  **无需重启**。
- 插件市场里的开关与本命令等效：开关点击经 agent 写入工作区级（或用户级）
  config，loader 只读不写，两边天然同步。
- 徽章数据来自本地 daemon（127.0.0.1:39217-39221）。
  `python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" daemon status` 可查。

用户附加要求：$ARGUMENTS