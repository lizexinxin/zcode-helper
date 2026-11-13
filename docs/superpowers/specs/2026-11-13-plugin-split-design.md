# 插件拆分设计：按功能点拆成独立插件

日期：2026-11-13
状态：已获用户确认的设计

## 背景与动机

仓库 `zcode-helper` 目前是「一个市场 + 一个插件」结构，插件 `zcode-helper` 内含一个补丁引擎和两个补丁：`folder-full-path`（源文件夹显示完整路径）和 `folder-git-branch`（git 分支徽章）。两个功能被绑死在一个插件里：无法只装其一、无法独立还原。

用户决定：**按功能点拆成两个独立插件**，每个可独立安装、独立开关、独立还原。仓库保留 `zcode-helper` 名称作为市场容器，插件名换成功能名，顺带消除仓库与插件重名的别扭感。

## 现状中阻碍拆分的事实

1. 引擎 `scripts/zcode_helper.py` 不是纯通用的：内嵌分支服务管理（`daemon` 子命令、`DAEMON_SCRIPT`、status/doctor 输出中的「分支服务」行）。
2. `DATA_DIR` 硬编码为 `~/.zcode/zcode-helper/`，state、config、inject payload 都在里面。
3. `hooks/session-start.py` 无条件尝试拉起 daemon，config 路径也硬编码。
4. 补丁 `folder-git-branch.json` 的注入路径硬编码为 `/Users/zexin.li/.zcode/zcode-helper/inject/branch-badge.js`。

## 设计

### 1. 通用引擎 + 目录自适应（核心原则）

**两个插件里的引擎和 hook 脚本是逐字节相同的同一份文件**，靠目录内容自适应行为。改动一处 bug 后同步一份副本即可，并有测试防漂移。

- **state 目录派生化**：引擎读自身 `.zcode-plugin/plugin.json` 的 `name`，派生 `~/.zcode/<插件名>/`：
  - `zcode-folder-full-path` → `~/.zcode/zcode-folder-full-path/state.json`
  - `zcode-branch-badge` → `~/.zcode/zcode-branch-badge/{state.json, config.json, inject/branch-badge.js, daemon.log}`
  - 新增 `--data-dir` 参数覆盖派生值，专供测试使用。
- **可选扩展点**：引擎检测自身 `scripts/zch_branch_daemon.py` 是否存在——存在才注册 `daemon` 子命令，status/doctor 输出才带分支服务行。同一份引擎在两个插件下行为自动正确。
- **hook 通用化**：`session-start.py` 按 plugin.json 的 name 派生 config 路径；daemon 拉起改为「daemon 脚本存在才尝试」（best-effort，失败静默，独立于 autoApply 开关）。两份 hook 文件完全相同。
- **真源与同步**：引擎与 hook 的真源放仓库顶层 `shared/`，插件目录里是分发副本。新增 `tests/test_engine_sync.py` 校验各插件副本与 `shared/` 真源 sha256 一致。

### 2. 目录结构与命名

```
marketplace.json                            # 两个插件条目
shared/
  zcode_helper.py                           # 引擎真源
  session-start.py                          # hook 真源
plugins/
  zcode-folder-full-path/                   # 功能1：源文件夹完整路径
    .zcode-plugin/plugin.json               #   name: zcode-folder-full-path
    patches/folder-full-path.json
    scripts/zcode_helper.py                 #   副本
    hooks/session-start.py                  #   副本
    commands/folder-full-path-{apply,restore,status}.md
    skills/zcode-folder-full-path/SKILL.md
    hooks/hooks.json
  zcode-branch-badge/                       # 功能2：git 分支徽章
    .zcode-plugin/plugin.json               #   name: zcode-branch-badge
    patches/folder-git-branch.json
    inject/branch-badge.js
    scripts/zcode_helper.py                 #   副本
    scripts/zch_branch_daemon.py            #   仅此插件有，非 shared 副本
    hooks/session-start.py                  #   副本
    commands/branch-badge-{apply,restore,status}.md
    skills/zcode-branch-badge/SKILL.md
    hooks/hooks.json
tests/
  test_patch_engine.py                      # 适配 --data-dir
  test_branch_daemon.py                     # 不动
  test_engine_sync.py                       # 新增
```

- 命令前缀按功能命名：`/folder-full-path-apply` 等。`daemon start/status` 保持脚本调用方式（hook 自动拉起，README 说明），不新增命令。
- 两个新插件版本号均为 `0.1.0`。
- 两个 SKILL.md 各含「新增补丁」章节（内容相同，复制），说明补丁 JSON 格式与定位方法。
- `marketplace.json` 两条目，各自 displayName/description；市场名保持 `zcode-helper-marketplace`。
- `README.md` 重写为「一个市场、两个独立插件」，各自安装、命令、原理章节，共享原理（等长原地替换、{{ident}} 通配、生效条件、auto-apply）单列。

### 3. 补丁定义改动

`folder-git-branch.json` 的 `<script src>` 注入路径改为 `{{data_dir}}` 占位符：

```
<script src="{{data_dir}}/inject/branch-badge.js"></script>
```

- 引擎只在 **replace** 展开时替换 `{{data_dir}}` 为派生的 data 目录绝对路径；**find 不做展开**（find 是匹配目标，不应含变量）。
- 展开后若 replace 超过 find 长度，走现有等长校验直接报错不写入。CSS 压缩块余量约 700 字节，路径约 60 字节，余量充足。
- `folder-full-path.json` 无占位符，不变。

### 4. 行为不变项

- 补丁引擎核心逻辑（asar 解析、等长原地替换、state 记录、还原、{{ident}} 通配、匹配次数校验、auto）不变。
- 两个补丁修改 asar 内不同文件（renderer 资产 JS vs index.html），互不冲突。
- daemon 安全边界不变（仅 127.0.0.1、只读 git 查询、静默失败）。
- `autoApply` 配置语义不变，只是路径随插件名分开，两插件各有开关。

## 错误处理

- `plugin.json` 缺失或无 `name`：引擎报错退出（结构损坏，明确提示）。
- `{{data_dir}}` 展开后超长：现有 expectedCount/等长校验兜底，apply 报错且不写。
- hook 中 daemon 拉起失败：静默，徽章自然不显示。
- 引擎同步校验失败：测试失败，提示重新从 `shared/` 复制。

## 测试

- `test_patch_engine.py`：改用 `--data-dir` 指向临时目录，覆盖项不变（{{ident}} 通配、应用/还原往返、幂等、匹配失败不改、占位符展开）。
- `test_branch_daemon.py`：不动。
- `test_engine_sync.py`：新增，校验副本一致性。
- 完成标准：三个测试全部通过，不碰真实 app.asar。

## 迁移步骤（写入 README）

1. 旧插件运行 `/zcode-helper-restore`（还原 app.asar 原始字节）。
2. 卸载旧插件 `zcode-helper`。
3. 添加市场（仓库地址不变），安装两个新插件并启用。
4. 分别运行 `/folder-full-path-apply`、`/branch-badge-apply`，完全退出并重开 ZCode。
5. 删除旧目录 `~/.zcode/zcode-helper/`。

⚠️ 分支徽章补丁的注入路径变了，**必须先 restore 再 apply**，不能直接重新 apply 覆盖。

## 风险与边界

- 引擎双份维护成本：靠「shared/ 真源 + 同步测试」控制；引擎是单文件，同步是机械复制。
- 用户已装副本需要手动迁移一次（一次性成本）。
- 对官方客户端修改的既有风险声明不变（ZCode 升级覆盖、/restore 可精确还原）。
