---
description: 剥离主进程 loader 指针、还原原版 app.asar（需重启一次 ZCode）
---

用 Bash 运行。插件根目录优先取环境变量 `ZCODE_PLUGIN_ROOT`；若为空，用
`find ~/.zcode/cli/plugins -path '*zcode-branch-badge/scripts/zcode_helper.py' -print -quit`
定位后取其上两级目录：

    python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" loader remove

结果处理：

- 输出「已剥离」时：提醒用户完全退出 ZCode（菜单 → 退出）再重新打开一次。
- 输出「未安装」时：本来就没有注入，无需操作。

用户附加要求：$ARGUMENTS
