# zcode-helper

自用 ZCode 桌面客户端 UI 定制补丁市场，包含两个**互相独立**的插件，
可单独安装、单独开关、单独还原：

1. **ZCode 源文件夹完整路径**（`zcode-folder-full-path`）：编辑项目时，「源文件夹」
   列表直接显示完整路径（`folder-full-path` 补丁），解决不同路径下同名文件夹无法区分的问题。
2. **ZCode git 分支徽章**（`zcode-branch-badge`）：编辑项目时，git 仓库源文件夹显示
   当前分支徽章（`folder-git-branch` 补丁，如 `⎇ main`）；非 git 目录不显示。

## 效果

```
应用前：  📁 zcode-helper
应用后：  📁 /Users/you/projects/github/lizexinxin/zcode-helper  ⎇ main
```

（完整路径来自 folder-full-path；分支徽章来自 zcode-branch-badge，两者可分开使用。）

## 安装

### 1. 添加插件市场

打开 ZCode 的 **插件市场 → 添加 → 添加插件市场**，直接粘贴本仓库的 git 地址：

```
https://github.com/lizexinxin/zcode-helper.git
```

ZCode 会在仓库根目录找到 `marketplace.json`，市场名称为 `zcode-helper-marketplace`。

网络访问 GitHub 不方便时，也可以把本仓库克隆到本地后粘贴本地目录
（注意是**仓库根目录**）：

```
<path-to-clone>/zcode-helper
```

### 2. 安装插件（按需二选一或都装）

在 **Personal → zcode-helper-marketplace** 里安装想要的插件并确认已启用。
两个插件互不依赖。

### 3. 应用补丁

新开一个会话，按插件运行：

- 完整路径：`/folder-full-path-apply`
- 分支徽章：`/branch-badge-apply`

成功后**完全退出 ZCode**（菜单 → 退出，关闭窗口不算），再重新打开。
打开一个项目，进入「编辑项目」即可看到效果。

## 常用命令

| 插件 | 命令 |
|---|---|
| folder-full-path | `/folder-full-path-status` · `/folder-full-path-apply` · `/folder-full-path-restore` |
| branch-badge | `/branch-badge-status` · `/branch-badge-apply` · `/branch-badge-restore` |

分支服务（branch-badge 的数据源）：

```bash
python3 plugins/zcode-branch-badge/scripts/zcode_helper.py daemon start   # 幂等；SessionStart hook 也会自动拉起
python3 plugins/zcode-branch-badge/scripts/zcode_helper.py daemon status
```

也可以直接运行各插件脚本（把 `<插件>` 换成 `zcode-folder-full-path` 或 `zcode-branch-badge`）：

```bash
python3 plugins/<插件>/scripts/zcode_helper.py status
python3 plugins/<插件>/scripts/zcode_helper.py apply
python3 plugins/<插件>/scripts/zcode_helper.py restore
python3 plugins/<插件>/scripts/zcode_helper.py doctor
```

## 原理

ZCode 的界面代码打包在 `/Applications/ZCode.app/Contents/Resources/app.asar`。
引擎解析 asar 头部，按各插件 `patches/*.json` 中的定义定位目标文件，
对其中一小段字节做**等长原地替换**（新内容不足原长度时补空格）：

- 不改变 asar 结构、大小和任何文件 offset，不需要重打包 300MB+ 归档；
- 只写入目标位置的几百字节，并做写入后校验；
- 原始字节记录在各插件自己的 state 文件里，还原时精确写回；
- 匹配次数不符合预期时不做任何修改。

两个插件的数据目录互相独立：

```
~/.zcode/zcode-folder-full-path/state.json
~/.zcode/zcode-branch-badge/{state.json, config.json, inject/branch-badge.js, daemon.log}
```

所以还原其中一个不影响另一个的补丁。

补丁的 `find` 里可以用 `{{ident}}` 通配一个压缩后的 JS 标识符，`replace` 里可以用
`{{data_dir}}` 指代该插件的数据目录。ZCode 每次升级都会重新压缩 bundle，
`{{ident}}` 让补丁不必跟着版本逐个手改。

已验证 ZCode 版本：**3.16.3、3.17.1、3.18.2**。

## 分支徽章的工作方式

`folder-git-branch` 补丁压缩了 `index.html` 启动动画的 CSS（视觉行为不变），
腾出的空间注入一个 `<script>` 标签，加载 `~/.zcode/zcode-branch-badge/inject/branch-badge.js`：

- payload 用 MutationObserver 盯住「编辑项目」弹窗的源文件夹行
  （`data-testid` 语义钩子，不碰压缩后的应用代码）；
- 每个文件夹路径向本地服务 `zch-branch-daemon` 查询分支（`/branch?path=…`），
  daemon 执行只读的 `git branch --show-current`（detached HEAD 显示 `HEAD@<短SHA>`）；
- daemon 端口 39217-39221（仅绑定 127.0.0.1），由 branch-badge 插件的 SessionStart
  hook 自动拉起，也可手动启动（见上文）；
- daemon 未运行、目录不是 git 仓库、或查询失败时**静默不显示徽章**，
  不影响 ZCode 任何功能。

安全边界：daemon 只监听回环地址、只做只读 git 查询；本机其他进程理论上也能
调用该接口（只能查询本机目录的分支，无写操作），自用场景可接受。

### 生效条件

修改的是磁盘上的 asar。已经运行的 ZCode 进程仍使用内存里的旧代码，
必须完全退出并重新打开才会生效。

### ZCode 升级后

ZCode 自动更新会替换整个 `.app`，补丁失效。各插件的 `SessionStart` hook 会在
新会话启动时检查：如果补丁之前应用过、当前又变回未应用，会自动重新应用
（默认开启，可在各插件自己的 `~/.zcode/<插件名>/config.json` 里设置
`{"autoApply": false}` 关闭）。如果新版本代码结构变化导致补丁无法匹配，
hook 会提示需要适配。

只有压缩变量名变化的话（`find` 里已用 `{{ident}}` 通配）不需要改补丁，
`auto` 会直接重新应用；如果目标片段本身变了，仍要按新代码更新 `find`。

## 从旧版单插件迁移（一次性）

旧版是单插件 `zcode-helper`，两个补丁绑在一起。迁移步骤：

1. 旧插件运行 `/zcode-helper-restore`（还原 app.asar 原始字节）。
2. 在 **设置 → 插件** 卸载旧插件。
3. 按上文安装两个新插件（市场地址不变）并分别 apply。
4. 完全退出并重开 ZCode。
5. 删除旧数据目录 `~/.zcode/zcode-helper/`。

⚠️ 分支徽章补丁的注入路径变了，**必须先 restore 再 apply**，不能直接重新 apply 覆盖。

## 修改引擎（shared/ 真源与副本）

引擎（`zcode_helper.py`）与 SessionStart hook（`session-start.py`）的真源在
`shared/`，两个插件目录里是**逐字节相同**的分发副本。改 bug 只改 `shared/`，
然后同步到所有副本：

```bash
cp shared/zcode_helper.py plugins/zcode-folder-full-path/scripts/
cp shared/zcode_helper.py plugins/zcode-branch-badge/scripts/
cp shared/session-start.py plugins/zcode-folder-full-path/hooks/
cp shared/session-start.py plugins/zcode-branch-badge/hooks/
python3 tests/test_engine_sync.py   # 校验副本与真源一致
```

## 测试

```bash
python3 tests/test_patch_engine.py    # 补丁引擎（{{ident}}/{{data_dir}}、往返、幂等，合成 asar）
python3 tests/test_branch_daemon.py   # 本地分支服务（真实起服务、查临时 git 仓库）
python3 tests/test_session_hook.py    # SessionStart hook
python3 tests/test_engine_sync.py     # shared/ 与副本同步
```

用例不会碰真实的 `app.asar` 和 `~/.zcode/`。

## 新增补丁

在对应插件的 `patches/` 下新增一个 JSON 文件即可，脚本不需要改。
格式和定位方法见各插件 `skills/<插件名>/SKILL.md` 的「新增补丁」章节
（`replace` 里可用 `{{data_dir}}` 指代插件数据目录）。

## 风险与边界

- 会修改 `/Applications/ZCode.app` 内的 `app.asar`，属于对官方客户端的第三方修改，
  不是官方功能。ZCode 升级会覆盖它。
- 可用各插件的 restore 命令精确还原；还原后整包哈希与修改前一致。
- 只修改界面显示代码，不涉及登录凭据、网络请求和用户数据。
- macOS 上如果 `/Applications` 不可写，可把 ZCode 复制到 `~/Applications`
  后用 `--asar` 参数指向，或用 sudo 运行脚本。

## 目录结构

```
marketplace.json                     # 插件市场清单（仓库根，ZCode 添加 git 市场时在此查找）
shared/
  zcode_helper.py                    # 补丁引擎真源（两个插件各有一份逐字节相同的副本）
  session-start.py                   # SessionStart hook 真源
plugins/
  zcode-folder-full-path/            # 插件1：源文件夹完整路径
    .zcode-plugin/plugin.json
    patches/folder-full-path.json
    scripts/zcode_helper.py          # 副本
    hooks/{hooks.json, session-start.py}
    commands/  skills/
  zcode-branch-badge/                # 插件2：git 分支徽章
    .zcode-plugin/plugin.json
    patches/folder-git-branch.json
    inject/branch-badge.js           # payload（apply 时同步到 ~/.zcode/zcode-branch-badge/inject/）
    scripts/{zcode_helper.py, zch_branch_daemon.py}
    hooks/{hooks.json, session-start.py}
    commands/  skills/
tests/
  test_patch_engine.py               # 补丁引擎测试（合成 asar，不碰真实客户端）
  test_branch_daemon.py              # 分支服务测试
  test_session_hook.py               # hook 测试
  test_engine_sync.py                # shared/ 与副本同步校验
```
