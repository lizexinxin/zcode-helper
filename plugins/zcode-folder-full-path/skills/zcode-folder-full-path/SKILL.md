---
name: zcode-folder-full-path
description: ZCode 桌面客户端「源文件夹完整路径」补丁。用户想编辑项目时看到源文件夹完整路径、询问“为什么文件夹只显示名字”“同名文件夹分不清”，或想查看/还原该补丁时使用。通过等长原地替换 app.asar 内的界面代码实现，可精确还原。
---

# ZCode Folder Full Path

ZCode 的「编辑项目 → 源文件夹」列表原本只显示文件夹名（basename），hover 才能看到完整路径。
本插件把显示改为完整路径并允许换行。原理：解析 `app.asar` 头部，按补丁定义定位目标 JS
文件，对其中一小段字节做**等长原地替换**（不足部分补空格），不改变 asar 结构、大小和
文件偏移。原始字节记录在 `~/.zcode/zcode-folder-full-path/state.json`，可随时精确还原。

## 何时使用

- 用户说「编辑项目时文件夹只显示名字 / 同名文件夹分不清 / 想看全路径」→ 应用本补丁。
- 用户问补丁是否生效、ZCode 升级后补丁失效 → 查看状态并按需重新应用。
- 用户想还原客户端原始界面 → 运行还原。

## 命令

脚本位置：`${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py`（插件根目录由
`ZCODE_PLUGIN_ROOT` 环境变量提供；若为空，用 `find ~/.zcode -path '*zcode-folder-full-path*/scripts/zcode_helper.py'` 定位）。

```bash
python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" status
python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" apply
python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" restore
python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" doctor
python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" list
```

全局参数 `--asar PATH` 可指向非默认安装位置；`--data-dir PATH` 覆盖数据目录；`--json` 输出机器可读结果。

## 已内置补丁

| ID | 作用 | 验证版本 |
|---|---|---|
| `folder-full-path` | 「编辑项目 → 源文件夹」列表直接显示完整路径（允许换行） | ZCode 3.16.3、3.17.1 |

## 工作原理与安全边界

1. 只修改补丁定义中精确匹配的字节；匹配次数不符合预期时**不做任何修改**并报错。
2. 替换后长度不变（新内容不足时补空格），因此 asar header、文件 offset、总大小都不变。
3. `state.json` 保存每处修改的偏移和原始字节，还原时先校验当前位置内容确实是补丁后的内容，否则跳过。
4. 补丁只改界面显示，不涉及凭据、网络和用户数据。

## 生效条件

修改的是磁盘上的 asar；**已经运行的 ZCode 进程仍使用内存里的旧代码**。
必须完全退出 ZCode（菜单 → 退出，关闭窗口不算）再重新打开，补丁才可见。

## ZCode 升级后

SessionStart hook 会在新会话启动时调用 `auto`：补丁之前应用过、当前又变回未应用状态时
自动重新应用（默认开启，可在 `~/.zcode/zcode-folder-full-path/config.json` 中设置
`{"autoApply": false}` 关闭）。`find` 里用 `{{ident}}` 通配压缩变量名，改名类变化不受影响；
只有目标代码本身变了才需要手工更新 `find`。

## 新增补丁

在 `patches/` 下新增一个 JSON 文件即可，无需改脚本：

```json
{
  "id": "my-patch",
  "title": "补丁名称",
  "version": 1,
  "description": "作用说明",
  "locate": {
    "pathPrefix": "out/renderer/assets/",
    "pathSuffix": ".js",
    "minSize": 1000000,
    "contains": ["用于定位目标文件的唯一字符串"]
  },
  "replacements": [
    { "find": "要被替换的原始代码片段", "replace": "替换后的代码片段（不能比 find 长）", "expectedCount": 1 }
  ]
}
```

- `find` 里出现的压缩变量名用 `{{ident}}` 代替（匹配任意 JS 标识符），避免升级后失效。
- `replace` 里可用 `{{data_dir}}` 指代本插件数据目录 `~/.zcode/zcode-folder-full-path/`（只对 replace 生效，find 不展开）。
- 修改 `find`/`replace` 时保证替换后 JS 语法合法；应用前可用 `node --check <提取出来的文件>` 验证。

## 故障排查

- **没有写入权限**：把 ZCode 复制到 `~/Applications` 后用 `--asar` 指向，或用 sudo 运行。
- **目标文件/代码未找到**：ZCode 升级后 bundle 内容变化，运行 `doctor` 查看定位结果，更新 `patches/*.json`。
- **已应用但界面没变**：没有完全退出 ZCode；确认从菜单退出后重新打开。
- **想彻底移除**：`restore` 后在 **设置 → 插件** 里禁用或卸载本插件。
