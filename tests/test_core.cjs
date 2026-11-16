/* core.cjs 心跳逻辑测试（node --test tests/test_core.cjs）。
 * 只测 sendHeartbeat 的端口选择与记忆：起真 HTTP 服务在系统分配端口，
 * 不碰真实的 39217-39221（测试机可能有真实 daemon 在跑）。
 * core.cjs 顶层只读 env 构建路径常量，无写盘副作用，普通 node 可加载。 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

/* 临时 loader 主目录：避免读到开发机的真实 ~/.zcode/zcode-helper */
process.env.ZCODE_LOADER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "zch-core-"));

const core = require(path.join(__dirname, "..", "shared", "core.cjs"));

function listenZero() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      server.hits += 1;
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    });
    server.hits = 0;
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function portOf(server) {
  return server.address().port;
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

/* 起一个服务再关掉，拿一个「确定无监听」的端口（connect 立即被拒）。 */
async function deadPort() {
  const server = await listenZero();
  const port = portOf(server);
  await close(server);
  return port;
}

test("sendHeartbeat 跳过无服务端口并返回首个成功端口", async () => {
  const p1 = await deadPort();
  const server = await listenZero();
  try {
    const p2 = portOf(server);
    const got = await core.sendHeartbeat([p1, p2]);
    assert.equal(got, p2, "应跳过失败端口、返回首个 200 的端口");
    assert.equal(server.hits, 1, "成功端口应恰好收到一次心跳");
  } finally {
    await close(server); // 断言失败也要关掉 server，否则进程挂着不退出
  }
});

test("sendHeartbeat 全部不可达返回 0", async () => {
  const p1 = await deadPort();
  const got = await core.sendHeartbeat([p1]);
  assert.equal(got, 0, "全失败应返回 0");
});

test("sendHeartbeat 记住成功端口并优先重试", async () => {
  const a = await listenZero();
  const b = await listenZero();
  try {
    const pa = portOf(a);
    const pb = portOf(b);
    assert.equal(await core.sendHeartbeat([pa]), pa, "先建立成功端口缓存");
    a.hits = 0;
    b.hits = 0;
    // 传入列表顺序翻转（b 在前）：缓存的 pa 仍应被提到最前
    assert.equal(await core.sendHeartbeat([pb, pa]), pa, "应优先上次的成功端口");
    assert.equal(a.hits, 1, "缓存端口收到心跳");
    assert.equal(b.hits, 0, "非缓存端口不应被打到");
  } finally {
    await close(a);
    await close(b);
  }
});

test("心跳协议常量：默认端口段与发送间隔", () => {
  assert.deepEqual(core.HEARTBEAT_PORTS, [39217, 39218, 39219, 39220, 39221]);
  assert.equal(core.HEARTBEAT_EVERY_TICKS, 10, "1s tick 每 10 个发一次（10 秒）");
});
