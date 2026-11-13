---
description: 查看「git 分支徽章」补丁状态（是否已应用、分支服务是否运行）
---

用 Bash 运行。插件根目录优先取环境变量 `ZCODE_PLUGIN_ROOT`；若为空，用
`find ~/.zcode/cli/plugins -path '*zcode-branch-badge/scripts/zcode_helper.py' -print -quit`
定位后取其上两级目录：

    python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" status

把脚本输出原样转述给用户，不要自行推断成功率。补充说明：

- 状态含义：`已应用` 表示当前 asar 中已经是补丁后的代码；`未应用` 表示可以应用；`目标文件未找到` / `目标代码未找到` 表示 ZCode 版本变化导致补丁需要适配。
- 「分支服务 未运行」时徽章不会显示；可运行 `python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" daemon start` 拉起（幂等），SessionStart hook 也会自动拉起。
- 如果提示需要重启，提醒用户：只关闭窗口不算，必须从菜单完全退出 ZCode 再重新打开。

用户附加要求：$ARGUMENTS
