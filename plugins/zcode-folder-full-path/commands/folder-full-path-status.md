---
description: 查看 UI 注入 loader 状态（是否安装、模块文件是否在位）
---

用 Bash 运行。插件根目录优先取环境变量 `ZCODE_PLUGIN_ROOT`；若为空，用
`find ~/.zcode/cli/plugins -path '*zcode-folder-full-path/scripts/zcode_helper.py' -print -quit`
定位后取其上两级目录：

    python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" loader status

把脚本输出原样转述给用户，不要自行推断成功率。补充说明：

- 「已安装(已激活)」表示主进程注入已就绪并生效；「已安装(未激活)」表示指针已写入但
  ZCode 还没重启——让用户完全退出（菜单 → 退出）再重新打开一次；「未安装」时运行
  `loader install`（或在会话里发消息让 hook 自动安装）。
- 排查运行时问题看 `~/.zcode/zcode-helper/loader.log`。

用户附加要求：$ARGUMENTS
