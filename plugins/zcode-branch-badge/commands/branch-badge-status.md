---
description: 查看 UI 注入 loader 状态（是否安装、模块文件是否在位）与分支服务状态
---

用 Bash 运行。插件根目录优先取环境变量 `ZCODE_PLUGIN_ROOT`；若为空，用
`find ~/.zcode/cli/plugins -path '*zcode-branch-badge/scripts/zcode_helper.py' -print -quit`
定位后取其上两级目录：

    python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" loader status
    python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" status

把脚本输出原样转述给用户，不要自行推断成功率。补充说明：

- `loader status` 的「已安装」表示主进程注入已就绪；「未安装」时运行
  `loader install`（或重开一个会话让 hook 自动安装）。
- 「分支服务 未运行」时徽章不会显示；可运行
  `python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" daemon start` 拉起（幂等）。
- 排查运行时问题看 `~/.zcode/zcode-helper/loader.log`。

用户附加要求：$ARGUMENTS
