/* loader.cjs 纯逻辑测试（node --test tests/test_loader.cjs）。
 * 只测可独立运行的纯函数（enabledModules / syncFromConfig），不加载 electron。 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

/* 临时 loader 主目录：runnerFor 每次注入都从磁盘读模块文件 */
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "zch-loader-"));
fs.mkdirSync(path.join(tmpHome, "modules"), { recursive: true });
fs.writeFileSync(
  path.join(tmpHome, "modules", "folder-full-path.js"),
  '(function(){window.__zchModules["folder-full-path"]=' +
    '{install:function(){return "ok";},dispose:function(){return "ok";}};}());'
);
process.env.ZCODE_LOADER_HOME = tmpHome;

/* 临时 config：ZCode 写 config 是「写临时文件 + rename」，macOS 上 fs.watch
 * 监听的 inode 被换掉后再也收不到事件——轮询必须能兜住。 */
const tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "zch-config-"));
const tmpConfig = path.join(tmpConfigDir, "config.json");
process.env.ZCODE_LOADER_CONFIG = tmpConfig;

const loader = require(path.join(__dirname, "..", "shared", "loader.cjs"));

function writeConfigAtomic(pluginState) {
  const payload = JSON.stringify({ plugins: { enabledPlugins: pluginState } });
  const tmp = tmpConfig + ".tmp";
  fs.writeFileSync(tmp, payload);
  fs.renameSync(tmp, tmpConfig); // 与 ZCode 一致的原子替换写法
}

test("enabledModules 按插件前缀映射且忽略禁用项", () => {
  const cfg = {
    plugins: {
      enabledPlugins: {
        "zcode-folder-full-path@mp": true,
        "zcode-branch-badge@mp": false,
        "superpowers@claude-plugins-official": true,
      },
    },
  };
  assert.deepStrictEqual(loader.enabledModules(cfg), ["folder-full-path"]);
});

test("enabledModules 兼容空配置与异常输入", () => {
  assert.deepStrictEqual(loader.enabledModules({}), []);
  assert.deepStrictEqual(loader.enabledModules(null), []);
  assert.deepStrictEqual(loader.enabledModules({ plugins: {} }), []);
  assert.deepStrictEqual(loader.enabledModules("bad"), []);
});

test("MODULE_IDS 与模块文件名约定一致", () => {
  assert.deepStrictEqual(loader.MODULE_IDS, ["folder-full-path", "branch-badge"]);
});

test("runnerFor 输出合法 IIFE，install 返回 ok", () => {
  const js = loader.runnerFor("folder-full-path", true);
  assert.ok(js.startsWith("(function(){"), js);
  assert.ok(js.endsWith("})()"), js);
  // 能直接求值（若顶层 return 会在这里抛 SyntaxError）
  assert.strictEqual(vm.runInNewContext(js, { window: { __zchModules: {} } }), "ok");
});

test("runnerFor on=false 调用 dispose", () => {
  const js = loader.runnerFor("folder-full-path", false);
  assert.strictEqual(vm.runInNewContext(js, { window: { __zchModules: {} } }), "ok");
});

test("runnerFor 模块缺失时返回标记而非抛错", () => {
  const js = loader.runnerFor("no-such-module", true);
  assert.strictEqual(vm.runInNewContext(js, { window: { __zchModules: {} } }), "missing-file");
});

test("injectionsFor 按 webContents 缓存去重，不重复 dispose/install", () => {
  // 首次（state 为空）：两个模块都要注入一次
  assert.deepStrictEqual(loader.injectionsFor({}, ["folder-full-path"]), [
    { id: "folder-full-path", want: true },
    { id: "branch-badge", want: false },
  ]);

  // 已注入且状态一致：不再注入（避免每次重放都拆掉重建，徽章会闪没）
  const state = { "folder-full-path": true, "branch-badge": false };
  assert.deepStrictEqual(loader.injectionsFor(state, ["folder-full-path"]), []);

  // 只有状态变化的模块才重新注入
  assert.deepStrictEqual(loader.injectionsFor(state, ["folder-full-path", "branch-badge"]), [
    { id: "branch-badge", want: true },
  ]);
});

test("config 用 rename 方式替换后仍能检测到开关变化", () => {
  writeConfigAtomic({ "zcode-folder-full-path@mp": true });
  assert.deepStrictEqual(loader.syncFromConfig("test"), ["folder-full-path"]);
  // 内容不变：不重复应用
  assert.deepStrictEqual(loader.syncFromConfig("test"), []);

  // 关闭后再次 rename 覆盖（macOS 上 fs.watch 会丢这类事件，轮询必须兜住）
  writeConfigAtomic({ "zcode-folder-full-path@mp": false });
  assert.deepStrictEqual(loader.syncFromConfig("test"), ["folder-full-path"]);

  // 再次开启也必须有变化
  writeConfigAtomic({ "zcode-folder-full-path@mp": true });
  assert.deepStrictEqual(loader.syncFromConfig("test"), ["folder-full-path"]);
});

test("配置读到半截 JSON 时保持现状，不误拆模块", () => {
  // 先归零再开启，保证本用例拿到一次真实变化（测试间共享模块状态）
  writeConfigAtomic({ "zcode-folder-full-path@mp": false });
  loader.syncFromConfig("test");
  writeConfigAtomic({ "zcode-folder-full-path@mp": true });
  assert.deepStrictEqual(loader.syncFromConfig("test"), ["folder-full-path"]);

  // 模拟撞上写入中间态：非法 JSON
  const tmp = tmpConfig + ".tmp";
  fs.writeFileSync(tmp, '{"plugins": {"enabledPlugins": {"zcode-folder-');
  fs.renameSync(tmp, tmpConfig);
  assert.deepStrictEqual(loader.syncFromConfig("test"), [], "解析失败不能当成全部关闭");

  // 文件恢复完整且内容与当前一致：也不应产生变化
  writeConfigAtomic({ "zcode-folder-full-path@mp": true });
  assert.deepStrictEqual(loader.syncFromConfig("test"), []);
});

test("syncFromConfig 在配置缺失时不抛错", () => {
  fs.rmSync(tmpConfig, { force: true });
  assert.deepStrictEqual(loader.syncFromConfig("test"), []);
});

test("activate 写入 active.json 激活凭证，重复激活返回 already", () => {
  assert.strictEqual(loader.activate(), "ok");
  const active = JSON.parse(fs.readFileSync(path.join(tmpHome, "active.json"), "utf8"));
  assert.strictEqual(typeof active.pid, "number");
  assert.ok(active.pid > 0);
  assert.match(active.activatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.strictEqual(active.version, 1);
  assert.strictEqual(loader.activate(), "already");
});

test("core.cjs 变更触发热更新：无需重启即可应用新核心", async () => {
  // 把壳 + 核心复制到独立目录，require 第二个壳实例（不污染 shared 真源）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zch-hot-"));
  fs.copyFileSync(path.join(__dirname, "..", "shared", "loader.cjs"), path.join(tmp, "loader.cjs"));
  fs.copyFileSync(path.join(__dirname, "..", "shared", "core.cjs"), path.join(tmp, "core.cjs"));
  const prevHome = process.env.ZCODE_LOADER_HOME;
  const prevConfig = process.env.ZCODE_LOADER_CONFIG;
  process.env.ZCODE_LOADER_HOME = tmp;
  process.env.ZCODE_LOADER_CONFIG = path.join(tmp, "config.json");
  try {
    const shim = require(path.join(tmp, "loader.cjs"));
    assert.strictEqual(shim.activate(), "ok");
    const before = JSON.parse(fs.readFileSync(path.join(tmp, "active.json"), "utf8")).activatedAt;

    // 模拟 hook 自同步 / 自同步写入新核心：文件指纹变化即触发
    fs.appendFileSync(path.join(tmp, "core.cjs"), "\n// hot-reload marker\n");
    await new Promise((r) => setTimeout(r, 2500)); // 壳的 1s 轮询 + 300ms 防抖 + 重载

    const after = JSON.parse(fs.readFileSync(path.join(tmp, "active.json"), "utf8")).activatedAt;
    assert.notStrictEqual(after, before, "核心应被热更新并重新激活");
    const logTxt = fs.readFileSync(path.join(tmp, "loader.log"), "utf8");
    assert.ok(logTxt.includes("热更新核心"), "应记录热更新日志");
    assert.strictEqual(shim.activate(), "already", "壳级幂等不受热更新影响");
  } finally {
    if (prevHome === undefined) delete process.env.ZCODE_LOADER_HOME;
    else process.env.ZCODE_LOADER_HOME = prevHome;
    if (prevConfig === undefined) delete process.env.ZCODE_LOADER_CONFIG;
    else process.env.ZCODE_LOADER_CONFIG = prevConfig;
  }
});

test("自同步：发现插件缓存更高版本时更新 core.cjs 并热加载", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zch-selfsync-"));
  fs.copyFileSync(path.join(__dirname, "..", "shared", "loader.cjs"), path.join(tmp, "loader.cjs"));
  fs.copyFileSync(path.join(__dirname, "..", "shared", "core.cjs"), path.join(tmp, "core.cjs"));
  // 伪造插件缓存：某市场下有 9.9.9 新版本
  const cacheRoot = path.join(tmp, "cache");
  const newLoaderDir = path.join(cacheRoot, "some-market", "zcode-folder-full-path", "9.9.9", "loader");
  fs.mkdirSync(newLoaderDir, { recursive: true });
  fs.writeFileSync(
    path.join(newLoaderDir, "core.cjs"),
    'const CORE_VERSION = "9.9.9";\n' +
      'module.exports = { CORE_VERSION, activate: function () { return "ok"; }, dispose: function () {} };\n'
  );
  const prevHome = process.env.ZCODE_LOADER_HOME;
  const prevConfig = process.env.ZCODE_LOADER_CONFIG;
  const prevCache = process.env.ZCODE_LOADER_CACHE;
  process.env.ZCODE_LOADER_HOME = tmp;
  process.env.ZCODE_LOADER_CONFIG = path.join(tmp, "config.json");
  process.env.ZCODE_LOADER_CACHE = cacheRoot;
  try {
    const shim = require(path.join(tmp, "loader.cjs"));
    assert.strictEqual(shim.activate(), "ok");
    // 生产里由 1s 轮询触发；测试环境核心不开轮询，直接调用保持确定性
    shim.selfSyncFromCache();
    assert.ok(
      fs.readFileSync(path.join(tmp, "core.cjs"), "utf8").includes("9.9.9"),
      "core.cjs 应被自同步覆盖为新版本"
    );
    await new Promise((r) => setTimeout(r, 2000)); // 等壳的热更新
    const logTxt = fs.readFileSync(path.join(tmp, "loader.log"), "utf8");
    assert.ok(logTxt.includes("自同步"), "应记录自同步日志");
    assert.ok(logTxt.includes("热更新核心"), "自同步的新核心应被热加载");
    assert.strictEqual(shim.CORE_VERSION, "9.9.9", "导出的核心版本应随热更新刷新");
  } finally {
    if (prevHome === undefined) delete process.env.ZCODE_LOADER_HOME;
    else process.env.ZCODE_LOADER_HOME = prevHome;
    if (prevConfig === undefined) delete process.env.ZCODE_LOADER_CONFIG;
    else process.env.ZCODE_LOADER_CONFIG = prevConfig;
    if (prevCache === undefined) delete process.env.ZCODE_LOADER_CACHE;
    else process.env.ZCODE_LOADER_CACHE = prevCache;
  }
});
/* ===== 合并视图（0.2.7 observer 架构）：用户级打底 + 工作区项目文件覆盖 ===== */

function makeWorkspace(enabledMap, opts) {
  /* 造一个带 .zcode/config.json 的临时工作区，返回其路径 */
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), (opts && opts.prefix) || "zch-ws-"));
  fs.mkdirSync(path.join(ws, ".zcode"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, ".zcode", "config.json"),
    JSON.stringify({ plugins: { enabledPlugins: enabledMap } })
  );
  return ws;
}

test("projectConfigFilesFor 按根→workdir 收集，zcode.json 先于 .zcode/config.json", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zch-proj-"));
  const sub = path.join(root, "sub");
  fs.mkdirSync(sub, { recursive: true });
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.writeFileSync(path.join(root, "zcode.json"), "{}");
  fs.mkdirSync(path.join(root, ".zcode"), { recursive: true });
  fs.writeFileSync(path.join(root, ".zcode", "config.json"), "{}");
  const expect = [path.join(root, "zcode.json"), path.join(root, ".zcode", "config.json")];
  assert.deepStrictEqual(loader.projectConfigFilesFor(sub), expect, "从 sub 向上找到 .git 根即止");
  assert.deepStrictEqual(loader.projectConfigFilesFor(root), expect, "workdir 本身就是仓库根");
});

test("mergedEnabledMap 工作区覆盖用户级：原 desync 两方向都按 UI 语义", () => {
  // 方向一（原 bug）：用户级 false、工作区 true → on（UI 显示开，loader 必须同步开）
  writeConfigAtomic({ "zcode-branch-badge@mp": false });
  const wsOn = makeWorkspace({ "zcode-branch-badge@mp": true });
  assert.deepStrictEqual(loader.enabledModulesFromMap(loader.mergedEnabledMap(wsOn)), [
    "branch-badge",
  ]);

  // 方向二：用户级 true、工作区 false → off（UI 关掉后 loader 必须同步关）
  writeConfigAtomic({ "zcode-branch-badge@mp": true });
  const wsOff = makeWorkspace({ "zcode-branch-badge@mp": false });
  assert.deepStrictEqual(loader.enabledModulesFromMap(loader.mergedEnabledMap(wsOff)), []);
});

test("无工作区回落用户级；只有 === true 才算启用（与 agent 判定一致）", () => {
  writeConfigAtomic({ "zcode-branch-badge@mp": true });
  assert.deepStrictEqual(loader.enabledModulesFromMap(loader.mergedEnabledMap(null)), [
    "branch-badge",
  ]);
  writeConfigAtomic({ "zcode-branch-badge@mp": 1 });
  assert.deepStrictEqual(loader.enabledModulesFromMap(loader.mergedEnabledMap(null)), []);
});

test("工作区配置解析失败时跳过该层，不误拆模块", () => {
  writeConfigAtomic({ "zcode-branch-badge@mp": true });
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "zch-wsbad-"));
  fs.mkdirSync(path.join(ws, ".zcode"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".zcode", "config.json"), "{ broken");
  assert.deepStrictEqual(loader.enabledModulesFromMap(loader.mergedEnabledMap(ws)), [
    "branch-badge",
  ]);
});

test("同目录 zcode.json 与 .zcode/config.json 并存时后者优先", () => {
  writeConfigAtomic({});
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "zch-wstwo-"));
  fs.writeFileSync(
    path.join(ws, "zcode.json"),
    JSON.stringify({ plugins: { enabledPlugins: { "zcode-branch-badge@mp": true } } })
  );
  fs.mkdirSync(path.join(ws, ".zcode"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, ".zcode", "config.json"),
    JSON.stringify({ plugins: { enabledPlugins: { "zcode-branch-badge@mp": false } } })
  );
  assert.deepStrictEqual(loader.enabledModulesFromMap(loader.mergedEnabledMap(ws)), []);
});

test("用户级 config 损坏时 readEnabled/mergedEnabledMap 返回 null（不误判全关）", () => {
  writeConfigAtomic({ "zcode-branch-badge@mp": false });
  loader.syncFromConfig("test"); // 归零
  const tmp = tmpConfig + ".tmp";
  fs.writeFileSync(tmp, "{ broken", "utf8");
  fs.renameSync(tmp, tmpConfig);
  assert.strictEqual(loader.readEnabled(), null);
  assert.strictEqual(loader.mergedEnabledMap(null), null);
  writeConfigAtomic({}); // 恢复
});

test("discoverAgentWorkspace 增量扫描日志建立候选并参与合并", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zch-logdisc-"));
  const prev = process.env.ZCODE_LOADER_LOGDIR;
  process.env.ZCODE_LOADER_LOGDIR = dir;
  try {
    const log = path.join(dir, "zcode-2020-01-01.jsonl"); // 非今天 → mtime 兜底选中
    const wsA = makeWorkspace({ "zcode-branch-badge@mp": false });
    writeConfigAtomic({ "zcode-branch-badge@mp": true });
    const base = fs.statSync(tmpConfig).mtimeMs;
    fs.utimesSync(tmpConfig, new Date(base - 30000), new Date(base - 30000));
    fs.utimesSync(
      path.join(wsA, ".zcode", "config.json"),
      new Date(base - 20000),
      new Date(base - 20000)
    );
    fs.writeFileSync(log, JSON.stringify({ context: { workspacePath: wsA } }) + "\n");

    loader.discoverAgentWorkspace(); // 首扫：全文件建立候选
    assert.deepStrictEqual(
      loader.enabledModulesFromMap(loader.mergedEnabledMap()),
      [],
      "候选 wsA(false) 比过去时间线的用户级新 → off"
    );

    // 增量：追加 wsB(true) 行（文件 mtime 比 wsA 新）→ 只读新增段落拾取
    const wsB = makeWorkspace({ "zcode-branch-badge@mp": true });
    fs.appendFileSync(log, JSON.stringify({ context: { workspacePath: wsB } }) + "\n");
    loader.discoverAgentWorkspace();
    assert.deepStrictEqual(
      loader.enabledModulesFromMap(loader.mergedEnabledMap()),
      ["branch-badge"],
      "增量出现的 wsB(true) 最新 → on"
    );

    // 无新内容：重复扫描不产生变化
    loader.discoverAgentWorkspace();
    assert.deepStrictEqual(
      loader.enabledModulesFromMap(loader.mergedEnabledMap()),
      ["branch-badge"]
    );
  } finally {
    if (prev === undefined) delete process.env.ZCODE_LOADER_LOGDIR;
    else process.env.ZCODE_LOADER_LOGDIR = prev;
  }
});

test("tailText 只读文件末尾指定字节", () => {
  const big = fs.mkdtempSync(path.join(os.tmpdir(), "zch-log-")) + "/log.jsonl";
  fs.writeFileSync(big, "x".repeat(200000) + '\n{"context":{"workspacePath":"/tmp/tail-ws"}}\n');
  const tail = loader.tailText(big, 128);
  assert.ok(tail.length <= 128, "不应超过指定字节数");
  assert.ok(tail.includes("/tmp/tail-ws"), "尾部内容应完整保留");
  const tail2 = loader.tailText(big, 10 * 1024 * 1024);
  assert.ok(tail2.includes("/tmp/tail-ws"), "超出文件大小时应读全文");
  assert.strictEqual(loader.tailText(big + "-missing", 100), "");
});

test("latestAgentLogPath 优先今天的日志，缺省取最新 mtime", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zch-logdir-"));
  const prev = process.env.ZCODE_LOADER_LOGDIR;
  process.env.ZCODE_LOADER_LOGDIR = dir;
  try {
    const now = new Date();
    const ymd =
      now.getFullYear() +
      "-" +
      String(now.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(now.getDate()).padStart(2, "0");
    // 昨天的文件（mtime 较旧）+ 今天的文件：应选今天
    const older = path.join(dir, "zcode-2020-01-01.jsonl");
    const today = path.join(dir, "zcode-" + ymd + ".jsonl");
    fs.writeFileSync(older, '{"context":{"workspacePath":"/tmp/old"}}\n');
    fs.writeFileSync(today, '{"context":{"workspacePath":"/tmp/new"}}\n');
    assert.strictEqual(loader.latestAgentLogPath(), today);
    // 今天的不存在：回落 mtime 最新的 jsonl
    fs.rmSync(today, { force: true });
    fs.utimesSync(older, new Date(), new Date(Date.now() + 5000));
    assert.strictEqual(loader.latestAgentLogPath(), older);
  } finally {
    if (prev === undefined) delete process.env.ZCODE_LOADER_LOGDIR;
    else process.env.ZCODE_LOADER_LOGDIR = prev;
  }
});

test("多候选工作区：最后被写入的层胜出（多会话交错场景）", () => {
  writeConfigAtomic({ "zcode-branch-badge@mp": true });
  const base = fs.statSync(tmpConfig).mtimeMs;
  const wsA = makeWorkspace({ "zcode-branch-badge@mp": false });
  const wsB = makeWorkspace({ "zcode-branch-badge@mp": true });
  const touch = (p, ms) => fs.utimesSync(p, new Date(ms), new Date(ms));
  // 全部压到过去时间线：用户级 < A < B（避免未来时间戳让用户级永远赢不了）
  touch(tmpConfig, base - 30000);
  touch(path.join(wsA, ".zcode", "config.json"), base - 20000);
  touch(path.join(wsB, ".zcode", "config.json"), base - 10000);
  // B 最后被写 → 跟随 B：on
  assert.deepStrictEqual(
    loader.enabledModulesFromMap(loader.mergedEnabledMap([wsA, wsB])),
    ["branch-badge"]
  );
  // A 又写了一次（更新）→ 跟随 A：off
  touch(path.join(wsA, ".zcode", "config.json"), base - 5000);
  assert.deepStrictEqual(
    loader.enabledModulesFromMap(loader.mergedEnabledMap([wsA, wsB])),
    []
  );
  // 用户级再写一次（最新）→ 回落用户级：on
  writeConfigAtomic({ "zcode-branch-badge@mp": true });
  assert.deepStrictEqual(
    loader.enabledModulesFromMap(loader.mergedEnabledMap([wsA, wsB])),
    ["branch-badge"]
  );
});
