---
description: 开关「源文件夹完整路径」模块（on / off / toggle，1 秒内生效）
---

用 Bash 运行。插件根目录优先取环境变量 `ZCODE_PLUGIN_ROOT`；若为空，用
`find ~/.zcode/cli/plugins -path '*zcode-folder-full-path/scripts/zcode_helper.py' -print -quit`
定位后取其上两级目录：

    python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" loader toggle folder-full-path <on|off|toggle>

说明：

- 该命令直接写 `~/.zcode/cli/config.json` 的 `plugins.enabledPlugins`，
  主进程 loader 会在 1 秒内注入或拆除模块，**无需重启**。
- ZCode 插件市场里的开关在当前版本不会写这个配置文件（实测：拨动后
  config.json 的 mtime 不变），所以那个开关对本插件无效，请用本命令。
- 想确认状态：`python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" loader status`
  并看 `~/.zcode/zcode-helper/loader.log` 里的「开关变化」行。

用户附加要求：$ARGUMENTS