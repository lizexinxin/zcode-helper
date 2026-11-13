# zcode-helper

给 ZCode 桌面客户端打 UI 定制补丁的自用插件。

当前补丁：

1. **编辑项目时，「源文件夹」列表直接显示完整路径**（`folder-full-path`），解决不同路径下同名文件夹无法区分的问题。
2. **编辑项目时，git 仓库源文件夹显示当前分支徽章**（`folder-git-branch`），如 `⎇ main`；非 git 目录不显示。

## 效果

ZCode 的「编辑项目 → 源文件夹」列表原本只显示文件夹名（basename），
hover 才能看到完整路径。应用补丁后直接显示完整路径，并允许长路径换行：

```
应用前：  📁 zcode-helper
应用后：  📁 /Users/you/projects/github/lizexinxin/zcode-helper
```

## 安装

### 1. 添加插件市场

打开 ZCode 的 **插件市场 → 添加 → 添加插件市场**，直接粘贴本仓库的 git 地址：

```
https://github.com/lizexinxin/zcode-helper.git
```

ZCode 会在仓库根目录找到 `marketplace.json`，市场名称为 `zcode-helper-marketplace`。

如果网络访问 GitHub 不方便，也可以把本仓库克隆到本地后，粘贴本地目录
（注意是**仓库根目录**，清单 `marketplace.json` 在根目录而不是 `plugins/` 下）：

```
<path-to-clone>/zcode-helper
```

### 2. 安装插件

在 **Personal → zcode-helper-marketplace → ZCode Helper** 点击安装，然后确认插件已启用。

### 3. 应用补丁

新开一个会话，运行：

```
/zcode-helper-apply
```

成功后**完全退出 ZCode**（菜单 → 退出，关闭窗口不算），再重新打开。打开一个项目，
进入「编辑项目」，源文件夹列表就会显示完整路径。

## 常用命令

| 命令 | 作用 |
|---|---|
| `/zcode-helper-status` | 查看补丁是否已应用、是否适配当前 ZCode 版本 |
| `/zcode-helper-apply` | 应用补丁（可重复执行，幂等） |
| `/zcode-helper-restore` | 还原客户端原始界面 |
| `zcode_helper.py daemon start` | 启动本地分支服务（folder-git-branch 的数据源；幂等，hook 也会自动拉起） |

也可以直接运行脚本：

```bash
python3 plugins/zcode-helper/scripts/zcode_helper.py status
python3 plugins/zcode-helper/scripts/zcode_helper.py apply
python3 plugins/zcode-helper/scripts/zcode_helper.py restore
python3 plugins/zcode-helper/scripts/zcode_helper.py doctor
```

## 原理

ZCode 的界面代码打包在 `/Applications/ZCode.app/Contents/Resources/app.asar`。
本工具解析 asar 头部，按 `patches/*.json` 中的定义定位目标 JS 文件，
对其中一小段字节做**等长原地替换**（新内容不足原长度时补空格）：

- 不改变 asar 结构、大小和任何文件 offset，不需要重打包 300MB+ 归档；
- 只写入目标位置的几百字节，并做写入后校验；
- 原始字节记录在 `~/.zcode/zcode-helper/state.json`，还原时精确写回；
- 匹配次数不符合预期时不做任何修改。

补丁的 `find` 里可以用 `{{ident}}` 通配一个压缩后的 JS 标识符。ZCode 每次升级
都会重新压缩 bundle，被调用函数的名字会变（3.16.3 是 `kv`，3.17.1 是 `ey`），
用通配符后补丁不必跟着版本逐个手改。

已验证 ZCode 版本：**3.16.3、3.17.1、3.18.2**。

## 分支徽章的工作方式

`folder-git-branch` 补丁压缩了 `index.html` 启动动画的 CSS（视觉行为不变），
腾出的空间注入一个 `<script>` 标签，加载 `~/.zcode/zcode-helper/inject/branch-badge.js`：

- payload 用 MutationObserver 盯住「编辑项目」弹窗的源文件夹行
  （`data-testid` 语义钩子，不碰压缩后的应用代码）；
- 每个文件夹路径向本地服务 `zch-branch-daemon` 查询分支（`/branch?path=…`），
  daemon 执行只读的 `git branch --show-current`（detached HEAD 显示 `HEAD@<短SHA>`）；
- daemon 端口 39217-39221（仅绑定 127.0.0.1），由 SessionStart hook 自动拉起，
  也可 `python3 plugins/zcode-helper/scripts/zcode_helper.py daemon start` 手动启动；
- daemon 未运行、目录不是 git 仓库、或查询失败时**静默不显示徽章**，
  不影响 ZCode 任何功能。

安全边界：daemon 只监听回环地址、只做只读 git 查询；本机其他进程理论上也能
调用该接口（只能查询本机目录的分支，无写操作），自用场景可接受。

### 生效条件

修改的是磁盘上的 asar。已经运行的 ZCode 进程仍使用内存里的旧代码，
必须完全退出并重新打开才会生效。

### ZCode 升级后

ZCode 自动更新会替换整个 `.app`，补丁失效。插件的 `SessionStart` hook 会在
新会话启动时检查：如果补丁之前应用过、当前又变回未应用，会自动重新应用
（默认开启，可通过 `~/.zcode/zcode-helper/config.json` 的
`{"autoApply": false}` 关闭）。如果新版本代码结构变化导致补丁无法匹配，
hook 会提示需要适配。

只有压缩变量名变化的话（`find` 里已用 `{{ident}}` 通配）不需要改补丁，
`auto` 会直接重新应用；如果目标片段本身变了，仍要按新代码更新 `find`。

## 测试

```bash
python3 tests/test_patch_engine.py
python3 tests/test_branch_daemon.py
```

用例在临时目录里合成一个最小 asar，覆盖 `{{ident}}` 通配、应用/还原往返、
幂等性和匹配失败不做修改等行为，不会碰真实的 `app.asar` 和 `state.json`。

## 新增补丁

在 `plugins/zcode-helper/patches/` 下新增一个 JSON 文件即可，脚本不需要改。
格式和定位方法见 `plugins/zcode-helper/skills/zcode-helper/SKILL.md` 的
「新增补丁」章节。

## 风险与边界

- 会修改 `/Applications/ZCode.app` 内的 `app.asar`，属于对官方客户端的第三方修改，
  不是官方功能。ZCode 升级会覆盖它。
- 可用 `/zcode-helper-restore` 精确还原；还原后整包哈希与修改前一致。
- 只修改界面显示代码，不涉及登录凭据、网络请求和用户数据。
- macOS 上如果 `/Applications` 不可写，可把 ZCode 复制到 `~/Applications`
  后用 `--asar` 参数指向，或用 sudo 运行脚本。

## 目录结构

```
marketplace.json                     # 插件市场清单（仓库根，ZCode 添加 git 市场时在此查找）
plugins/
  zcode-helper/
    .zcode-plugin/plugin.json         # 插件清单
    commands/                         # /zcode-helper-* 命令
    skills/zcode-helper/SKILL.md      # 技能说明（含新增补丁指南）
    scripts/zcode_helper.py           # asar 补丁工具
    inject/branch-badge.js            # folder-git-branch 的 payload（apply 时同步到 ~/.zcode/zcode-helper/inject/）
    scripts/zch_branch_daemon.py      # 本地分支查询服务（127.0.0.1）
    patches/folder-full-path.json     # 补丁定义
    hooks/hooks.json                  # SessionStart 自动修复
    hooks/session-start.py
tests/
  test_patch_engine.py                # 补丁引擎测试（合成 asar，不碰真实客户端）
```