# zcode-helper

自用 ZCode 桌面客户端 UI 定制插件市场，包含两个**互相独立**的插件，
可单独安装、单独开关：

1. **ZCode 源文件夹完整路径**（`zcode-folder-full-path`）：编辑项目时，「源文件夹」
   列表直接显示完整路径，解决不同路径下同名文件夹无法区分的问题。
2. **ZCode git 分支徽章**（`zcode-branch-badge`）：编辑项目时，git 仓库源文件夹显示
   当前分支徽章（如 `⎇ main`）；非 git 目录不显示。

## 为什么需要它

在 ZCode 中编辑项目时，「源文件夹」一栏**只显示最内层文件夹的名字**。
目录一多，问题立刻暴露：

- **同名文件夹无法区分**：一个项目同时挂了多个同名目录（比如
  `~/projects/gitlab/my-ai/aihub` 和
  `~/projects/gitlab/ops/argocd-application/deployYamls/aihub`），
  界面上就是两行一模一样的 `aihub`，哪个在前哪个在后全靠记，
  一旦选错，任务就在错误的目录里跑。
- **看不出当前分支**：项目关联了多个 git 仓库时，界面上没有任何分支信息，
  想确认现在在哪个分支，只能自己去终端敲 `git branch`。

开启插件后，还是那个「编辑项目」界面——每个源文件夹直接显示**完整路径**，
git 仓库额外带上**当前分支徽章**，一眼可辨：

**关闭插件**：两行一模一样的 `aihub`，完全分不清谁是谁，也看不到任何分支信息：

![关闭插件：同名文件夹无法区分、看不到分支](docs/images/before-plugin.png)

**开启插件**：同样的项目，完整路径 + 分支徽章（`⎇ master` / `⎇ release`）：

![开启插件：完整路径 + 分支徽章](docs/images/after-plugin.png)

两个插件互不依赖：只装 folder-full-path 就只有完整路径；只装 branch-badge
就只有分支徽章。

## 安装

### 1. 添加插件市场

打开 ZCode 的 **插件市场 → 添加 → 添加插件市场**：

![点击「添加插件市场」](docs/images/marketplace-add-menu.png)

在弹窗里粘贴本仓库的 git 地址，勾选风险确认后点「添加插件市场」：

```
https://github.com/lizexinxin/zcode-helper.git
```

![粘贴仓库地址并添加](docs/images/marketplace-paste-url.png)

ZCode 会在仓库根目录找到 `marketplace.json`，市场名称为 `zcode-helper-marketplace`。

网络访问 GitHub 不方便时，也可以把本仓库克隆到本地后粘贴本地目录
（注意是**仓库根目录**）：

```
<path-to-clone>/zcode-helper
```

### 2. 安装并启用插件

在 **个人** 标签页里找到 `zcode-helper-marketplace`，安装想要的插件
（两个互不依赖，按需二选一或都装），并打开开关：

![开启两个插件](docs/images/plugins-enabled.png)

### 3. 打开一个会话，等系统通知

插件启用后**不需要敲任何命令**。**打开一个已存在的会话**，或者**新开一个会话
并随便发一句话**（比如 Hi），插件就会自动完成剩下的配置。几秒到几十秒后，
你会收到一条系统通知：

![提醒重启一次的系统通知](docs/images/restart-notice.png)

- 没看到通知？说明之前已经配置好并生效了，一切正常。
- 提醒不会错过：只要还没重启生效，之后每次打开会话或发消息都会再提醒
  （同一小段时间内只提醒一次，不会连环轰炸）；重启成功后就完全安静，不再打扰。
- 不想弹系统通知、或想关闭这个自动配置：在 `~/.zcode/<插件名>/config.json`
  里配置 `{"notify": false}` / `{"autoApply": false}`（不配也行，默认都开着）。

### 4. 重启一次，生效

收到通知后，**完全退出 ZCode，再重新打开**。这是唯一一次要手动做的事：

- 「完全退出」是指菜单栏 **ZCode → 退出 ZCode**（快捷键 ⌘Q）；只点窗口的
  关闭按钮不算。
- 这也是最后一次因为装插件而重启——之后开关插件、更新版本都即时生效，
  不用再重启。

## 开关即插即用

loader 安装完成后，**插件市场里的开关拨动立即生效**（运行中即时变化，无需重启）：

- 开关拨到开 → 立即注入对应 UI 模块；
- 开关拨到关 → 立即完整拆除（DOM、样式、监听全部移除，无残留）；
- 新开一个窗口、或界面重新加载时，已开启的插件效果会自动应用到新界面上，
  不用重新设置。

## 常用命令

| 操作 | 命令（任一插件脚本均可） |
|---|---|
| 安装 loader（幂等） | `loader install` |
| 查看注入状态 | `loader status` |
| 完全卸载注入 | `loader remove` |
| 分支服务（徽章数据源） | `daemon start` / `daemon status` / `daemon stop` |

```bash
python3 plugins/zcode-branch-badge/scripts/zcode_helper.py loader status
python3 plugins/zcode-branch-badge/scripts/zcode_helper.py daemon status
```

对应 slash 命令：`/folder-full-path-apply`（= loader install）、
`/branch-badge-restore`（= loader remove）、`/branch-badge-status` 等。

## 原理

ZCode 的插件机制没有任何 UI 扩展点，界面代码打包在
`/Applications/ZCode.app/Contents/Resources/app.asar`，且只在启动时加载一次。
本仓库采用**主进程 loader + 运行时注入**架构：

```
SessionStart / UserPromptSubmit hook（打开会话、每次发消息时触发，装上即自动安装）
  → 幂等执行 loader install：同步 loader 资产到 ~/.zcode/zcode-helper/，
    整包重打包 app.asar 写入一行 dynamic import() 指针（首装约数十秒）；
    branch-badge 插件还会顺手 best-effort 拉起本地分支服务
  → app.asar 的 out/main/index.js 尾部只有一行 import() 指针
      → 指向磁盘上的 ~/.zcode/zcode-helper/loader.cjs（常驻主进程）
          ├─ 每 1s 检查用户级 ~/.zcode/cli/config.json + 已发现的工作区配置
          │   （0.2.8 起本插件只认用户级：工作区一旦出现本插件的键，loader 自动
          │   把值迁回用户级并从工作区删除（归位），工作区层恒为空 → UI 合并
          │   显示恒等于用户级；工作区从 agent 日志的 workspacePath 自动发现）
          ├─ 开关变化 → webContents.executeJavaScript 注入/拆除模块（DOM 立即变化）
          └─ 新窗口 / 界面重新加载 → 自动把已启用的模块重新注入新界面（模块幂等）
```

插件市场开关为什么能即时生效：开关拨动经 agent 写入当前项目的工作区 config
（ZCode 内部行为，拦不住），loader 每 1s 检查到变化后自动「归位」——把值迁回
用户级、从工作区删掉——然后按用户级注入/拆除模块。持久状态永远只落在用户级
文件里，任何项目里拨、切到任何项目看，开关和效果都一致。

hook 判活与重启提醒：loader 激活时原子写 `~/.zcode/zcode-helper/active.json`
（pid + 时间戳），hook 用它区分「指针已装但 ZCode 未重启」和「已生效」——前者
提醒重启（系统通知 + 会话提示，手动等价命令是 `loader install`，见上文常用命令），
后者完全静默（`loader status` 的 `已安装(已激活/未激活)` 也来自这里）。提醒带
10 分钟冷却（`restart-reminder.json`）：SessionStart 与 UserPromptSubmit 接连
触发只弹一次通知，冷却过后（一直没重启）恢复提醒。

### 更新插件零重启（壳 + 热更新核心）

`loader.cjs` 是**引导壳**，只负责被 asar 指针加载与热监听，基本永久不变；
真正的逻辑在 `core.cjs`（核心），模块每次注入现读。更新链路完全不依赖 hook：

- **引擎同步防降级**：`version.txt` 记录已同步版本，旧版本缓存里的 hook
  （会话中途更新时仍指向旧路径）无法把新资产覆盖回旧版；
- **自同步**：核心每秒扫描插件缓存目录，发现更高版本自动把
  `core.cjs + modules` 同步到运行目录；
- **热更新**：壳监听 `core.cjs` 指纹，变化即 dispose 旧核心、热加载新核心
  并重新激活（重新注入），全程无需重启 ZCode。

因此：**首次安装需要一次重启（写指针），之后的插件更新全部即时生效。**
只有引导壳自身或 asar 指针变更才需要重启（极少发生）。

- **渲染模块**（`~/.zcode/zcode-helper/modules/*.js`）每次注入都从磁盘现读：
  改模块代码，下次开关切换或页面刷新即用新版，零重启、不碰 asar。
- **folder-full-path** 模块是纯 CSS 覆盖（锚定 `data-testid` 语义钩子，
  不碰压缩后的 React 代码）；**branch-badge** 模块渲染徽章 DOM 并向
  本地 `zch-branch-daemon`（端口 39217-39221，仅绑定 127.0.0.1，只读 git 查询）
  查询分支。daemon 生命周期免维护：核心每 10 秒向它发一次心跳，ZCode 完全
  退出后心跳停止，daemon 60 秒内自动退场（从未收到过心跳则保持常驻，
  兼容旧版核心与手动启动）；也可用 `daemon stop` 手动停止。
- 每个模块都实现幂等的 `install()/dispose()`：注入的 DOM 带 `data-zch-module`
  标记，拆除时按标记全量清理。
- 首次安装需要整包重打包 asar（约 307MB，重算 header 与 integrity），
  之后只有这一行指针与 asar 相关；`loader remove` 对称剥离指针还原原版。
- 运行日志在 `~/.zcode/zcode-helper/loader.log`，loader 的任何异常只写日志，
  不影响 ZCode 主进程。

已验证 ZCode 版本：**3.18.2**（3.16.3 / 3.17.1 为旧等长替换路线的验证版本）。

### ZCode 升级后

ZCode 自动更新会替换整个 `.app`，asar 指针丢失。各插件的 `SessionStart` /
`UserPromptSubmit` hook 会在下次触发时自动重装（默认开启，可在
`~/.zcode/<插件名>/config.json` 里设置 `{"autoApply": false}` 关闭），
重装后重启一次 ZCode 即恢复；渲染模块不受升级影响。

## 修改引擎与模块（shared/ 真源与副本）

引擎（`zcode_helper.py`）、SessionStart hook（`session-start.py`）、
loader（`loader.cjs`）与渲染模块（`modules/*.js`）的真源在 `shared/`，
两个插件目录里是**逐字节相同**的分发副本。改 bug 只改 `shared/`，
然后同步到所有副本：

```bash
for f in zcode_helper.py:scripts session-start.py:hooks loader.cjs:loader core.cjs:loader; do
  src=${f%%:*}; dst=${f##*:}
  cp shared/$src plugins/zcode-folder-full-path/$dst/
  cp shared/$src plugins/zcode-branch-badge/$dst/
done
cp shared/modules/*.js plugins/zcode-folder-full-path/loader/modules/
cp shared/modules/*.js plugins/zcode-branch-badge/loader/modules/
python3 tests/test_engine_sync.py   # 校验副本与真源一致
```

## 测试

```bash
python3 tests/test_asar_repack.py      # asar 重打包核心（含真实 asar 只读往返）
python3 tests/test_loader_commands.py  # loader install/remove/status（合成 asar）
python3 tests/test_patch_engine.py     # 引擎既有能力（{{ident}}/{{data_dir}} 等，合成 asar）
python3 tests/test_branch_daemon.py    # 本地分支服务（真实起服务、查临时 git 仓库）
python3 tests/test_session_hook.py     # SessionStart/UserPromptSubmit hook
python3 tests/test_py_compat.py        # 全部 Python 脚本 3.9 语法兼容把关
python3 tests/test_engine_sync.py      # shared/ 与副本同步
node --test tests/test_loader.cjs      # loader 纯逻辑
node --test tests/test_modules.cjs     # 渲染模块协议与幂等（DOM stub）
```

除「真实 asar 只读往返」外，用例不会碰真实的 `app.asar` 和 `~/.zcode/`。

## 风险与边界

- 首次安装会修改 `/Applications/ZCode.app` 内的 `app.asar`，属于对官方客户端的
  第三方修改，不是官方功能。ZCode 升级会覆盖它（hook 会自动重装）。
- `loader remove` 可对称还原原版 asar；还原后的 `out/main/index.js` 与原始内容一致。
- 注入代码只做界面显示，不读取文件、不发出外部网络请求（徽章数据仅访问
  127.0.0.1 的本地 daemon）。
- macOS 上如果 `/Applications` 不可写，可把 ZCode 复制到 `~/Applications`
  后用 `--asar` 参数指向，或用 sudo 运行脚本。

## 目录结构

```
marketplace.json                     # 插件市场清单（仓库根，ZCode 添加 git 市场时在此查找）
shared/
  zcode_helper.py                    # 引擎真源（asar 解析/重打包 + loader 命令 + daemon）
  session-start.py                   # SessionStart/UserPromptSubmit hook 真源（自动安装 loader + 重启提醒）
  loader.cjs                         # 引导壳真源（asar 指针加载；热监听 core）
  core.cjs                           # 核心/真源（注入 + 开关联动 + 自同步，变更即热更新）
  modules/                           # 渲染模块真源
    folder-full-path.js              #   完整路径（纯 CSS）
    branch-badge.js                  #   分支徽章（DOM + daemon 查询）
plugins/
  zcode-folder-full-path/            # 插件1：源文件夹完整路径
    .zcode-plugin/plugin.json
    loader/{loader.cjs, core.cjs, modules/}    # 副本
    scripts/zcode_helper.py          # 副本
    hooks/{hooks.json, session-start.py}
    commands/  skills/
  zcode-branch-badge/                # 插件2：git 分支徽章
    .zcode-plugin/plugin.json
    loader/{loader.cjs, core.cjs, modules/}    # 副本
    scripts/{zcode_helper.py, zch_branch_daemon.py}
    hooks/{hooks.json, session-start.py}
    commands/  skills/
docs/
  images/                            # README 截图
  superpowers/                       # 设计与实施记录（plans/specs）
tests/
  test_asar_repack.py               # asar 重打包测试
  test_loader_commands.py           # loader 命令测试
  test_patch_engine.py              # 引擎既有能力测试
  test_branch_daemon.py             # 分支服务测试
  test_session_hook.py              # hook 测试
  test_py_compat.py                 # Python 3.9 语法兼容把关
  test_engine_sync.py               # shared/ 与副本同步校验
  test_loader.cjs  test_modules.cjs # loader / 模块 node 测试
```
