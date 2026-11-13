---
name: zcode-branch-badge
description: ZCode 桌面客户端「git 分支徽章」补丁。用户想在编辑项目的源文件夹列表里看到每个 git 仓库的当前分支（如 ⎇ main）、询问徽章为什么不显示、启动/排查本地分支服务（zch-branch-daemon），或想查看/还原该补丁时使用。
---

# ZCode Branch Badge

ZCode 的「编辑项目 → 源文件夹」列表中，本插件为每个 git 仓库文件夹在路径后显示当前
分支徽章（`⎇ main`；detached HEAD 显示 `HEAD@<短SHA>`；非 git 目录不显示）。

实现：压缩 `index.html` 启动动画的 CSS（视觉行为不变）腾出空间，注入一个 `<script>`
标签加载外部 payload `~/.zcode/zcode-branch-badge/inject/branch-badge.js` + 本地
`zch-branch-daemon` 服务查询分支。原始字节记录在
`~/.zcode/zcode-branch-badge/state.json`，可精确还原；**不修改任何压缩 JS**。

## 何时使用

- 用户想给源文件夹列表加分支显示 / 问「为什么看不到分支」→ 应用本补丁并启动分支服务。
- 用户问补丁状态、ZCode 升级后失效 → 查看状态并按需重新应用。
- 用户想还原 → 运行还原。

## 命令

脚本位置：`${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py`（若环境变量为空，用
`find ~/.zcode -path '*zcode-branch-badge*/scripts/zcode_helper.py'` 定位）。

```bash
python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" status        # 补丁 + 分支服务状态
python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" apply         # 应用补丁并同步 payload
python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" restore
python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" daemon start  # 拉起分支服务（幂等）
python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" daemon status
python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" doctor
```

## 分支服务（zch-branch-daemon）

- 只绑定 127.0.0.1，端口 39217-39221 选第一个空闲的；`GET /branch?path=<绝对路径>`
  返回 `{"label": "main" | "HEAD@xxx" | null}`，内部只做只读 `git branch --show-current`。
- SessionStart hook 会自动 best-effort 拉起；也可用上面的 `daemon start` 手动启动。
- **daemon 未运行、目录不是 git 仓库、或查询失败时徽章静默不显示**，不影响 ZCode 功能。
- 安全边界：仅监听回环地址、只做只读 git 查询；日志在 `~/.zcode/zcode-branch-badge/daemon.log`。

## 生效条件

修改的是磁盘上的 asar；**已经运行的 ZCode 进程仍使用内存里的旧代码**。必须完全退出
ZCode（菜单 → 退出，关闭窗口不算）再重新打开。

## ZCode 升级后

SessionStart hook 会自动重新应用失效的补丁（`~/.zcode/zcode-branch-badge/config.json`
的 `{"autoApply": false}` 可关闭）。补丁的 find 是字面量 CSS 区块，不涉及压缩变量名；
ZCode 更换启动动画样式时需要按新 index.html 更新 `find`。

## 故障排查

- **徽章不显示**：① 补丁是否 applied（`status`）；② 分支服务是否运行（`daemon status`，
  没运行就 `daemon start`）；③ 目录是否 git 仓库；④ 是否完全重启过 ZCode。
- **没有写入权限**：同通用引擎处理方式（`--asar` 指向用户目录副本或 sudo）。
- **想彻底移除**：`restore` 后在 **设置 → 插件** 里禁用或卸载本插件。
