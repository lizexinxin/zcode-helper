---
name: zcode-helper
description: ZCode 桌面客户端的 UI 定制补丁工具。用户想修改 ZCode 客户端界面（当前补丁：编辑项目时源文件夹显示完整路径）、查看补丁状态、还原补丁，或询问“为什么文件夹只显示名字”“怎么给 ZCode 加自定义 UI”时使用。通过等长原地替换 app.asar 内的界面代码实现，可精确还原。
---

# ZCode Helper

给 ZCode 桌面客户端打 UI 补丁的小工具。原理：ZCode 的界面代码打包在
`/Applications/ZCode.app/Contents/Resources/app.asar` 里，工具解析 asar 头部，
按补丁定义定位目标 JS 文件，对其中一小段字节做**等长原地替换**（不足部分补空格），
因此不改变 asar 结构、大小和文件偏移，不需要重打包 300MB+ 归档。原始字节记录在
`~/.zcode/zcode-helper/state.json`，可随时精确还原。

## 何时使用

- 用户说「编辑项目时文件夹只显示名字 / 同名文件夹分不清 / 想看全路径」→ 应用 `folder-full-path` 补丁。
- 用户问 ZCode 的 UI 补丁是否生效、ZCode 升级后补丁失效 → 查看状态并按需重新应用。
- 用户想还原客户端原始界面 → 运行还原。
- 用户想给 ZCode 增加新的 UI 定制 → 参考「新增补丁」章节。

## 命令

脚本位置：`${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py`（插件根目录由
`ZCODE_PLUGIN_ROOT` 环境变量提供；若为空，用 `find ~/.zcode -path '*zcode-helper*/scripts/zcode_helper.py'` 定位）。

```bash
python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" status
python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" apply
python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" apply --patch folder-full-path
python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" restore
python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" doctor
python3 "${ZCODE_PLUGIN_ROOT}/scripts/zcode_helper.py" list
```

全局参数 `--asar PATH` 可指向非默认安装位置；`--json` 输出机器可读结果。

## 已内置补丁

| ID | 作用 | 验证版本 |
|---|---|---|
| `folder-full-path` | 「编辑项目 → 源文件夹」列表直接显示完整路径（允许换行），不再只显示文件夹名 | ZCode 3.16.3、3.17.1 |

## 工作原理与安全边界

1. 只修改补丁定义中精确匹配的字节；匹配次数不符合预期时**不做任何修改**并报错。
2. 替换后长度不变（新内容不足时补空格），因此 asar header、文件 offset、总大小都不变。
3. 只写入目标位置的几百字节，并做写入后校验；不重打包整个归档。
4. `state.json` 保存每处修改的偏移和原始字节，还原时先校验当前位置内容确实是补丁后的内容，否则跳过（防止在 ZCode 升级后把旧代码写回去）。
5. 补丁只改界面显示，不涉及凭据、网络和用户数据。

## 生效条件

修改的是磁盘上的 asar；**已经运行的 ZCode 进程仍使用内存里的旧代码**。
必须完全退出 ZCode（菜单 → 退出，关闭窗口不算）再重新打开，补丁才可见。

## ZCode 升级后

ZCode 自动更新会替换整个 `.app`，补丁随之失效。插件的 SessionStart hook
会在新会话启动时调用 `auto`：如果这个补丁之前应用过、当前又变回未应用状态，
会自动重新应用（默认开启，可在 `~/.zcode/zcode-helper/config.json` 中设置
`{"autoApply": false}` 关闭）。如果升级后代码结构变化导致补丁无法匹配，
hook 会提示需要适配。

`find` 里用 `{{ident}}` 通配的部分不受压缩变量改名影响（ZCode 3.16.3 的 `kv`
在 3.17.1 变成 `ey`），这类变化 `auto` 会直接重新应用；只有目标代码本身变了
才需要手工更新 `find`。

## 新增补丁（后续定制）

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
    {
      "find": "要被替换的原始代码片段",
      "replace": "替换后的代码片段（不能比 find 长）",
      "expectedCount": 1
    }
  ]
}
```

定位目标文件的方法：

1. 从 `app.asar` 中找出候选文件：按 `locate` 的前缀/后缀/最小大小过滤，按大小降序读取。
2. 用 `contains` 中的字符串确认文件。
3. 用 `grep -a` 或 Node 脚本读取 asar 内容（参考 `scripts/zcode_helper.py` 中的 `read_node`）。
4. 确认 `find` 在目标文件中只出现一次，且 `replace` 不比命中片段长（不足部分脚本会自动补空格）。
5. `find` 里出现的压缩变量名（函数名等）用 `{{ident}}` 代替，可匹配任意 JS 标识符，
   避免 ZCode 每次升级重新压缩后失效。例如：

```json
"find": "children:r?t:{{ident}}(t)",
"replace": "children:t"
```

注意 `{{ident}}` 只对 `find` 生效，`replace` 中的同名文本按字面量处理；
通配后的实际长度未知，所以 `replace` 要比最短的可能命中还短（脚本会按实际命中长度补空格）。

修改 `find`/`replace` 时要保证替换后 JS 语法合法；应用前可以先用
`node --check <提取出来的文件>` 验证。

## 故障排查

- **没有写入权限**：`/Applications` 通常需要管理员权限。把 ZCode 复制到
  `~/Applications` 后用 `--asar` 指向，或用 sudo 运行。
- **目标文件/代码未找到**：ZCode 升级后 bundle 内容变化。运行 `doctor`
  查看定位结果，需要根据新版本更新 `patches/*.json` 中的 `find`/`contains`。
- **已应用但界面没变**：没有完全退出 ZCode；确认从菜单退出后重新打开。
- **想彻底移除**：`restore` 把所有补丁写回原始字节，然后可在
  **设置 → 插件** 里禁用或卸载本插件。