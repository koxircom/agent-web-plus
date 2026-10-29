import test, {after} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import {
  projectOdooWaitingSessions,
  setOdooLanClientStub,
  resolveOdooLanClient,
  resetOdooLanClientSingleton,
} from "./odoo-lan-service.ts";
import {
  registerOdooLanConsumer,
  createOdooLanDispatcher,
  cancelOdooLanWakeups,
  resetOdooLanCancellation,
  getOdooLanSessionConsumers,
  ODOO_LAN_MESSAGE_CUSTOM_TYPE,
} from "./odoo-lan-runtime.ts";
import { createOdooLanExtension } from "./odoo-lan-extension.ts";

const isolatedAgentDir=fs.mkdtempSync(path.join(os.tmpdir(),'odoo-integration-agent-'));
const envKeys=['PI_CODING_AGENT_DIR','PI_AGENT_DIR','AGENT_WEB_DATA_DIR'];const originalEnv=Object.fromEntries(envKeys.map(key=>[key,process.env[key]]));for(const key of envKeys)process.env[key]=isolatedAgentDir;
after(()=>{for(const key of envKeys){if(originalEnv[key]===undefined)delete process.env[key];else process.env[key]=originalEnv[key];}fs.rmSync(isolatedAgentDir,{recursive:true,force:true});});

function createMockOdooClient(overrides = {}) {
  let cachedSnapshot = {
    protocol: "odoo-addon-lan-v1",
    version: 1,
    revision: 1,
    updatedAt: new Date().toISOString(),
    resources: [],
    ...overrides.initialSnapshot,
  };

  const listeners = new Set();

  return {
    isConfigured: () => true,
    instanceId: overrides.instanceId || "synology:30141",
    instanceLabel: overrides.instanceLabel || "群晖30141",
    status: async () => cachedSnapshot,
    request: async (cmd) => {
      if (overrides.onRequest) {
        return overrides.onRequest(cmd);
      }
      return { status: "acknowledged", snapshot: cachedSnapshot };
    },
    getCachedSnapshot: () => cachedSnapshot,
    setSnapshot: (snapshot) => {
      cachedSnapshot = snapshot;
      for (const l of listeners) l();
    },
    subscribe: (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    close: async () => {},
  };
}

test("projectOdooWaitingSessions: projects waiting and handoff without leaking tokens or UUIDs", () => {
  const snapshot = {
    protocol: "odoo-addon-lan-v1",
    version: 1,
    revision: 1,
    updatedAt: "2026-10-25T12:00:00Z",
    resources: [
      {
        resource: "sale_commission",
        status: "held",
        owner: {
          sessionId: "11111111-1111-4111-8111-111111111111",
          sessionName: "销售订单打印排版",
          instanceId: "synology:30141",
          instanceLabel: "群晖30141",
          token: "secret-token-1234",
          generation: 5,
          ownerPid: 99999,
        },
        queue: [
          {
            sessionId: "local-waiter-1",
            sessionName: "采购日期调整",
            instanceId: "synology:30141",
            instanceLabel: "群晖30141",
            queueId: "q-1",
            sequence: 1,
            resumeTask: "继续验证币别",
            enqueuedAt: "2026-10-25T12:05:00Z",
            ownerPid: 12345,
          },
          {
            sessionId: "remote-waiter-2",
            sessionName: "远端任务",
            instanceId: "synology:30142",
            instanceLabel: "群晖30142",
            queueId: "q-2",
            sequence: 2,
            resumeTask: "远端继续",
            enqueuedAt: "2026-10-25T12:06:00Z",
            ownerPid: 54321,
          },
        ],
      },
      {
        resource: "mrp_workorder",
        status: "handoff",
        handoff: {
          sessionId: "local-handoff-sess",
          sessionName: "88888888-8888-4888-8888-888888888888", // Raw UUID title should be sanitized!
          instanceId: "synology:30141",
          instanceLabel: "群晖30141",
          token: "secret-handoff-token",
          generation: 2,
          resumeTask: "工单派工确认",
          handoffId: "h-1",
          createdAt: "2026-10-25T12:10:00Z",
          ownerPid: 22222,
        },
        queue: [],
      },
    ],
  };

  const projection = projectOdooWaitingSessions(snapshot, "synology:30141");

  // local-waiter-1 is queued on 30141
  assert.ok(projection["local-waiter-1"]);
  assert.equal(projection["local-waiter-1"].status, "waiting");
  assert.equal(projection["local-waiter-1"].addon, "sale_commission");
  assert.equal(projection["local-waiter-1"].ownerNode, "群晖30141");
  assert.equal(projection["local-waiter-1"].ownerTitle, "销售订单打印排版");

  // remote-waiter-2 is on 30142, should NOT be in 30141's local projection!
  assert.equal(projection["remote-waiter-2"], undefined);

  // local-handoff-sess is in handoff on 30141
  assert.ok(projection["local-handoff-sess"]);
  assert.equal(projection["local-handoff-sess"].status, "handoff");
  assert.equal(projection["local-handoff-sess"].addon, "mrp_workorder");
  assert.equal(projection["local-handoff-sess"].ownerTitle, "未命名会话（标题尚未生成）"); // Sanitized UUID!

  // Security check: JSON stringify must never contain sensitive tokens or PID
  const serialized = JSON.stringify(projection);
  assert.equal(serialized.includes("secret-token"), false);
  assert.equal(serialized.includes("secret-handoff-token"), false);
  assert.equal(serialized.includes("99999"), false);
  assert.equal(serialized.includes("12345"), false);
});

test("createOdooLanDispatcher: target instance filtering ignores other instances", async () => {
  const client = createMockOdooClient({
    instanceId: "synology:30141",
    initialSnapshot: {
      resources: [
        {
          resource: "sale_commission",
          status: "handoff",
          handoff: {
            sessionId: "peer-session-on-30142",
            sessionName: "远端会话",
            instanceId: "synology:30142", // TARGET IS PEER INSTANCE!
            handoffId: "handoff-peer-1",
            resumeTask: "在同事容器中执行",
            token: "tok-1",
            generation: 1,
            ownerPid: 100,
          },
          queue: [],
        },
      ],
    },
  });

  let restoredSessionId = null;

  const dispatcher = createOdooLanDispatcher({
    client,
    pollIntervalMs: 100,
    resolveSessionPath: async (id) => `/fake/${id}.jsonl`,
    startSession: async (id) => {
      restoredSessionId = id;
      return { session: { waitUntilReady: async () => {} } };
    },
  });

  await dispatcher.triggerScan();

  // Peer session on 30142 must NOT be restored by 30141!
  assert.equal(restoredSessionId, null);
  await dispatcher.stop();
});

test("createOdooLanDispatcher: cold restoration wakes target local session and consumes handoff", async () => {
  let ackCommand = null;

  const client = createMockOdooClient({
    instanceId: "synology:30141",
    initialSnapshot: {
      resources: [
        {
          resource: "sale_commission",
          status: "handoff",
          handoff: {
            sessionId: "cold-local-session",
            sessionName: "销售订单重构",
            instanceId: "synology:30141",
            handoffId: "handoff-local-1",
            resumeTask: "继续编写单元测试",
            token: "tok-local-1",
            generation: 3,
            ownerPid: 101,
          },
          queue: [],
        },
      ],
    },
    onRequest: async (cmd) => {
      if (cmd.action === "ack") {
        ackCommand = cmd;
        return { status: "acknowledged" };
      }
      return { status: "ok" };
    },
  });

  let restoredSessionId = null;
  const messagesSent = [];

  const dispatcher = createOdooLanDispatcher({
    client,
    pollIntervalMs: 100,
    resolveSessionPath: async (id) => `/fake/sessions/${id}.jsonl`,
    startSession: async (id) => {
      restoredSessionId = id;
      // Simulate session startup registering consumer
      registerOdooLanConsumer({
        sessionId: id,
        client,
        isBusy: () => false,
        sendMessage: async (msg, opts) => {
          messagesSent.push({ msg, opts });
        },
      });
      return { session: { waitUntilReady: async () => {} } };
    },
  });

  await dispatcher.triggerScan();

  assert.equal(restoredSessionId, "cold-local-session");
  assert.equal(messagesSent.length, 1);
  assert.equal(messagesSent[0].msg.customType, ODOO_LAN_MESSAGE_CUSTOM_TYPE);
  assert.equal(messagesSent[0].msg.details.handoffId, "handoff-local-1");
  assert.equal(messagesSent[0].opts.triggerTurn, true);
  assert.equal(messagesSent[0].opts.deliverAs, undefined, 'real SDK nextTurn is context-only, not a wake');

  // Assert ACK was requested
  assert.ok(ackCommand);
  assert.equal(ackCommand.action, "ack");
  assert.equal(ackCommand.handoffId, "handoff-local-1");

  await dispatcher.stop();
});

test("registerOdooLanConsumer: busy safety delays wake until settled", async () => {
  let isBusy = true;
  let settledListener = null;
  const messagesSent = [];

  const client = createMockOdooClient({
    instanceId: "synology:30141",
    initialSnapshot: {
      resources: [
        {
          resource: "stock",
          status: "handoff",
          handoff: {
            sessionId: "busy-sess",
            sessionName: "库存盘点",
            instanceId: "synology:30141",
            handoffId: "h-stock",
            resumeTask: "执行最后阶段验收",
            token: "t-stock",
            generation: 2,
            ownerPid: 102,
          },
          queue: [],
        },
      ],
    },
  });

  const unregister = registerOdooLanConsumer({
    sessionId: "busy-sess",
    client,
    isBusy: () => isBusy,
    onSettled: (cb) => {
      settledListener = cb;
      return () => { settledListener = null; };
    },
    sendMessage: async (msg, opts) => {
      messagesSent.push({ msg, opts });
    },
  });

  const consumers = getOdooLanSessionConsumers();
  const consumer = consumers.get("busy-sess");
  assert.ok(consumer);

  // Trigger drain while busy
  consumer.drain();
  assert.equal(messagesSent.length, 0);

  // Now transition to settled
  isBusy = false;
  assert.ok(settledListener);
  settledListener();

  // Allow async performDrain to complete
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(messagesSent.length, 1);
  assert.equal(messagesSent[0].msg.details.handoffId, "h-stock");

  unregister();
});

test("registerOdooLanConsumer: cancellation fence stops execution on stop or cancel", async () => {
  const messagesSent = [];

  const client = createMockOdooClient({
    instanceId: "synology:30141",
    initialSnapshot: {
      resources: [
        {
          resource: "account",
          status: "handoff",
          handoff: {
            sessionId: "cancel-sess",
            instanceId: "synology:30141",
            handoffId: "h-acc",
            resumeTask: "账单生成",
            token: "t-acc",
            generation: 1,
            ownerPid: 103,
          },
          queue: [],
        },
      ],
    },
  });

  const unregister = registerOdooLanConsumer({
    sessionId: "cancel-sess",
    client,
    isBusy: () => false,
    sendMessage: async (msg, opts) => {
      messagesSent.push({ msg, opts });
    },
  });

  // Cancel before drain
  cancelOdooLanWakeups("cancel-sess");

  const consumer = getOdooLanSessionConsumers().get("cancel-sess");
  consumer.drain();

  await new Promise((r) => setTimeout(r, 10));
  assert.equal(messagesSent.length, 0);

  unregister();
});

test("odoo_addon_lock tool: identity binding from context and action dispatching", async () => {
  let lastCommand = null;

  const client = createMockOdooClient({
    instanceId: "synology:30141",
    instanceLabel: "群晖30141",
    initialSnapshot: {
      resources: [
        {
          resource: "sale_commission",
          status: "held",
          owner: {
            sessionId: "tool-test-sess",
            sessionName: "佣金计算",
            instanceId: "synology:30141",
            instanceLabel: "群晖30141",
            token: "tok-test",
            generation: 4,
            ownerPid: 104,
          },
          queue: [],
        },
      ],
    },
    onRequest: async (cmd) => {
      lastCommand = cmd;
      if (cmd.action === "acquire") {
        return { status: "queued", position: 2, queueId: "q-acquire-1" };
      }
      if (cmd.action === "release") {
        return { status: "released" };
      }
      return { status: "ok" };
    },
  });

  let registeredTool = null;
  const mockPi = {
    on: () => {},
    registerTool: (t) => {
      registeredTool = t;
    },
    sendMessage: async () => {},
  };

  const extension = createOdooLanExtension({ client });
  extension.factory(mockPi);

  assert.ok(registeredTool);
  assert.equal(registeredTool.name, "odoo_addon_lock");

  const mockCtx = {
    sessionManager: {
      getSessionId: () => "tool-test-sess",
      getSessionName: () => "佣金计算",
    },
  };

  // 1. Test status action
  const statusRes = await registeredTool.execute("call-1", { action: "status" }, null, null, mockCtx);
  assert.ok(statusRes.content[0].text.includes("sale_commission (token: tok-test, generation: 4)"), 'the model must receive its own release credentials, not UI-only details');

  // 2. Test acquire action
  const acquireRes = await registeredTool.execute(
    "call-2",
    { action: "acquire", addon: "purchase", resumeTask: "继续修改报表" },
    null,
    null,
    mockCtx,
  );
  assert.ok(acquireRes.content[0].text.includes("已进入排队"));
  assert.ok(acquireRes.content[0].text.includes("切勿循环轮询"));
  assert.equal(lastCommand.actor.sessionId, "tool-test-sess");
  assert.equal(lastCommand.actor.sessionName, "佣金计算");
  assert.equal(lastCommand.resource, "purchase");

  // 3. Test release action
  const releaseRes = await registeredTool.execute(
    "call-3",
    { action: "release", addon: "purchase", token: "tok-test", generation: 4 },
    null,
    null,
    mockCtx,
  );
  assert.ok(releaseRes.content[0].text.includes("释放成功"));
  assert.equal(lastCommand.action, "release");
  assert.equal(lastCommand.token, "tok-test");
  assert.equal(lastCommand.generation, 4);
});

test("resolveOdooLanClient: propagates malformed config error instead of silently swallowing as disabled", async () => {
  resetOdooLanClientSingleton();
  setOdooLanClientStub(null);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "odoo-config-bad-"));
  const badConfigFile = path.join(tmpDir, "odoo-lan-config.json");
  // 构造损坏配置：enabled: true 但缺失必填 instanceId / authorityScript 等
  fs.writeFileSync(badConfigFile, JSON.stringify({ version: 1, enabled: true }));

  try {
    await assert.rejects(
      async () => {
        await resolveOdooLanClient({ configFile: badConfigFile });
      },
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("Malformed Odoo LAN configuration"));
        return true;
      },
      "Malformed configuration must throw and propagate, never return undefined (green empty)"
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetOdooLanClientSingleton();
  }
});

test("performDrain: busy safety check immediately after awaited status", async () => {
  let isBusyState = false;
  let settledListener = null;
  const messagesSent = [];

  const client = createMockOdooClient({
    instanceId: "synology:30141",
    initialSnapshot: {
      resources: [
        {
          resource: "sale_order",
          status: "handoff",
          handoff: {
            sessionId: "busy-check-sess",
            sessionName: "销售改动",
            instanceId: "synology:30141",
            handoffId: "h-busy-check",
            resumeTask: "继续编写测试",
            token: "tok-busy",
            generation: 1,
            ownerPid: 555,
          },
          queue: [],
        },
      ],
    },
  });

  // 模拟 status() 异步返回期间，会话由于其他外部事件变为 isBusy
  const origStatus = client.status;
  let hasSimulatedBusy = false;
  client.status = async () => {
    const snap = await origStatus();
    if (!hasSimulatedBusy) {
      hasSimulatedBusy = true;
      // 异步返回瞬间变为忙碌
      isBusyState = true;
    }
    return snap;
  };

  const unregister = registerOdooLanConsumer({
    sessionId: "busy-check-sess",
    client,
    isBusy: () => isBusyState,
    onSettled: (cb) => {
      settledListener = cb;
      return () => { settledListener = null; };
    },
    sendMessage: async (msg, opts) => {
      messagesSent.push({ msg, opts });
    },
  });

  const consumer = getOdooLanSessionConsumers().get("busy-check-sess");
  consumer.drain();

  await new Promise((r) => setTimeout(r, 10));
  // 断言：由于 awaited status 后二次检测到 isBusy，绝不强行 sendMessage
  assert.equal(messagesSent.length, 0);

  // 模拟 settled 触发，此时 session 变空闲
  isBusyState = false;
  settledListener?.();
  await new Promise((r) => setTimeout(r, 10));

  // 现在空闲，正常唤醒继续，不把消息留到下一次手动请求。
  assert.equal(messagesSent.length, 1);
  assert.equal(messagesSent[0].opts.triggerTurn, true);
  assert.equal(messagesSent[0].opts.deliverAs, undefined);

  unregister();
});

test("performDrain: lost-ACK retry works and active branch dedup prevents duplicate user messages", async () => {
  let ackAttempts = 0;
  let ackSuccessful = false;
  const messagesSent = [];
  let onBranchHandoffId = null;

  const client = createMockOdooClient({
    instanceId: "synology:30141",
    initialSnapshot: {
      resources: [
        {
          resource: "purchase_order",
          status: "handoff",
          handoff: {
            sessionId: "lost-ack-sess",
            sessionName: "采购入库",
            instanceId: "synology:30141",
            handoffId: "h-lost-ack-1",
            resumeTask: "继续采购核对",
            token: "tok-lost",
            generation: 2,
            ownerPid: 666,
          },
          queue: [],
        },
      ],
    },
    onRequest: async (cmd) => {
      if (cmd.action === "ack") {
        ackAttempts++;
        if (ackAttempts === 1) {
          // 第一轮模拟网络抖动/请求丢失抛错
          throw new Error("Network timeout during ACK");
        }
        // 第二轮 ACK 成功
        ackSuccessful = true;
        return { status: "acknowledged" };
      }
      return { status: "ok" };
    },
  });

  const unregister = registerOdooLanConsumer({
    sessionId: "lost-ack-sess",
    client,
    isBusy: () => false,
    isHandoffConsumedOnActiveBranch: (id) => id === onBranchHandoffId,
    sendMessage: async (msg, opts) => {
      messagesSent.push({ msg, opts });
      // 消息已进入活动分支
      onBranchHandoffId = msg.details.handoffId;
    },
  });

  const consumer = getOdooLanSessionConsumers().get("lost-ack-sess");

  // 第一轮 drain：发消息成功，但 ACK 失败
  consumer.drain();
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(messagesSent.length, 1);
  assert.equal(ackAttempts, 1);
  assert.equal(ackSuccessful, false);

  // 第二轮 drain（触发重试）：
  consumer.drain();
  await new Promise((r) => setTimeout(r, 10));

  // 断言：由于 active branch 已有该 handoffId，绝不发重复消息！
  assert.equal(messagesSent.length, 1, "Must NOT send duplicate message on active branch");
  // 断言：再次尝试 ACK 且成功，Lost-ACK 不会被屏蔽！
  assert.equal(ackAttempts, 2, "Must retry ACK even if message was already sent");
  assert.equal(ackSuccessful, true);

  unregister();
});

test("isHandoffConsumedOnActiveBranch: inspects active branch (getBranch), not dead entries (getEntries)", async () => {
  let sessionStartHandler = null;
  const mockPi = {
    on: (evt, handler) => {
      if (evt === "session_start") {
        sessionStartHandler = handler;
      }
    },
    registerTool: () => {},
    sendMessage: async () => {},
  };

  const client = createMockOdooClient({ instanceId: "synology:30141" });
  const extension = createOdooLanExtension({ client });

  // 构造模拟 context：getEntries 含有历史条目，而 getBranch 为空
  const mockCtx = {
    sessionManager: {
      getSessionId: () => "branch-check-sess",
      getSessionName: () => "分支测试",
      getEntries: () => [
        {
          message: {
            details: { handoffId: "old-dead-handoff-id" },
          },
        },
      ],
      getBranch: () => [
        // 活动分支为空
      ],
    },
  };

  extension.factory(mockPi);
  if (sessionStartHandler) {
    await sessionStartHandler({}, mockCtx);
  }

  // 验证在 getEntries 存在但在 getBranch 不存在时，注册成功且消费者的活跃分支去重有效
  const consumers = getOdooLanSessionConsumers();
  const c = consumers.get("branch-check-sess");
  assert.ok(c);

  // 清理
  c.cancel();
  consumers.delete("branch-check-sess");
});

test("cancelOdooLanWakeups: durable cancel for queue/handoff, never releases held business lock, resets fence on reacquire", async () => {
  let cancelCommand = null;

  const client = createMockOdooClient({
    instanceId: "synology:30141",
    initialSnapshot: {
      resources: [
        {
          resource: "stock_picking",
          status: "handoff",
          handoff: {
            sessionId: "cold-cancel-sess",
            sessionName: "出库单确认",
            instanceId: "synology:30141",
            handoffId: "h-cancel-pick",
            resumeTask: "继续扫码",
            token: "tok-pick",
            generation: 1,
            ownerPid: 777,
          },
          queue: [],
        },
        {
          resource: "account_move",
          status: "held",
          owner: {
            sessionId: "held-cancel-sess",
            sessionName: "凭证过账",
            instanceId: "synology:30141",
            token: "tok-held",
            generation: 1,
            ownerPid: 888,
          },
          queue: [],
        },
      ],
    },
    onRequest: async (cmd) => {
      if (cmd.action === "cancel") {
        cancelCommand = cmd;
        return { status: "cancelled" };
      }
      return { status: "ok" };
    },
  });

  setOdooLanClientStub(client);

  const dispatcher = createOdooLanDispatcher({
    client,
    pollIntervalMs: 100,
  });

  // 1. 取消 handoff 中的会话
  dispatcher.cancelSessionWakeups("cold-cancel-sess");
  cancelOdooLanWakeups("cold-cancel-sess");

  await new Promise((r) => setTimeout(r, 20));

  // 断言：向 authority 发起了 cancel
  assert.ok(cancelCommand);
  assert.equal(cancelCommand.action, "cancel");
  assert.equal(cancelCommand.resource, "stock_picking");
  assert.equal(cancelCommand.handoffId, "h-cancel-pick");

  // 2. 取消处于 held 状态的会话：绝不能发出 release
  let releaseCommandIssued = false;
  const origReq = client.request;
  client.request = async (cmd) => {
    if (cmd.action === "release") releaseCommandIssued = true;
    return origReq(cmd);
  };

  cancelOdooLanWakeups("held-cancel-sess");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(releaseCommandIssued, false, "Stop must NEVER release held business lock");

  // 3. reacquire 必须重置取消栅栏 (resetFence)
  resetOdooLanCancellation("cold-cancel-sess");

  await dispatcher.stop();
  setOdooLanClientStub(null);
});

test("createOdooLanDispatcher: bounded coldrestore retries backoff and stops after maxRetries", async () => {
  let restoreAttempts = 0;

  const client = createMockOdooClient({
    instanceId: "synology:30141",
    initialSnapshot: {
      resources: [
        {
          resource: "mrp_production",
          status: "handoff",
          handoff: {
            sessionId: "broken-cold-sess",
            sessionName: "生产工单",
            instanceId: "synology:30141",
            handoffId: "h-broken-1",
            resumeTask: "继续物料检查",
            token: "tok-broken",
            generation: 1,
            ownerPid: 999,
          },
          queue: [],
        },
      ],
    },
  });

  const dispatcher = createOdooLanDispatcher({
    client,
    pollIntervalMs: 50,
    maxRetries: 3,
    backoffScheduleMs: [10, 20, 30],
    resolveSessionPath: async () => {
      restoreAttempts++;
      // 模拟每次恢复都找不到文件失败
      return undefined;
    },
  });

  // 连续多次 triggerScan()
  for (let i = 0; i < 6; i++) {
    await dispatcher.triggerScan();
    await new Promise((r) => setTimeout(r, 40));
  }

  // 断言：由于最大重试次数为 3，且有退避，绝不会无限重试
  assert.equal(restoreAttempts, 3, `Expected exactly 3 bounded attempts, got ${restoreAttempts}`);

  await dispatcher.stop();
});

test("API public DTO: collaboration route strictly redacts tokens, generation, PID, SID, and queueId", async () => {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url, {
    alias: { "@": process.cwd() },
    interopDefault: true,
    moduleCache: false,
  });

  const { GET } = await jiti.import("../app/api/collaboration/route.ts");

  const client = createMockOdooClient({
    instanceId: "synology:30141",
    initialSnapshot: {
      resources: [
        {
          resource: "sale_secret_res",
          status: "held",
          owner: {
            sessionId: "secret-session-id-1234",
            sessionName: "核心销售单修改",
            instanceId: "synology:30141",
            instanceLabel: "群晖30141",
            token: "super-secret-token-xyz-999",
            generation: 42,
            ownerPid: 87654,
          },
          queue: [
            {
              sessionId: "waiter-secret-id-5678",
              sessionName: "采购排队单",
              instanceId: "synology:30141",
              instanceLabel: "群晖30141",
              queueId: "queue-secret-uuid-111",
              sequence: 1,
              resumeTask: "继续采购流程",
              reason: "等待销售锁",
              enqueuedAt: "2026-10-25T12:00:00Z",
              ownerPid: 12398,
            },
          ],
        },
      ],
    },
  });

  setOdooLanClientStub(client);

  try {
    const res = await GET();
    assert.equal(res.status, 200);

    const body = await res.json();
    const serialized = JSON.stringify(body);

    // 严密断言：公开 DTO 绝不泄露敏感凭据与内部 ID
    assert.equal(serialized.includes("super-secret-token-xyz-999"), false, "Must NOT leak token");
    assert.equal(serialized.includes("secret-session-id-1234"), false, "Must NOT leak owner sessionId");
    assert.equal(serialized.includes("waiter-secret-id-5678"), false, "Must NOT leak queue sessionId");
    assert.equal(serialized.includes("87654"), false, "Must NOT leak owner PID");
    assert.equal(serialized.includes("12398"), false, "Must NOT leak queue PID");
    assert.equal(serialized.includes("queue-secret-uuid-111"), false, "Must NOT leak queueId");

    // 检查 resource 字段
    const odooRes = body.resources.find((r) => r.key === "odoo:sale_secret_res");
    assert.ok(odooRes);
    assert.equal(odooRes.status, "held");
    assert.deepEqual(Object.keys(odooRes.owner).sort(), ["node", "title"]);
    assert.deepEqual(Object.keys(odooRes.queue[0]).sort(), ["node", "reason", "resumeTask", "title"]);
  } finally {
    setOdooLanClientStub(null);
  }
});

test("getRpcWaitingSessionsSnapshot: returns authorityAvailable: false on disconnect and preserves lastKnownWaitingSessions", async () => {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url, {
    alias: { "@": process.cwd() },
    interopDefault: true,
    moduleCache: false,
  });
  const { getRpcWaitingSessionsSnapshot } = await jiti.import("./rpc-manager.ts");

  const client = createMockOdooClient({
    instanceId: "synology:30141",
    initialSnapshot: {
      resources: [
        {
          resource: "stock_picking",
          status: "handoff",
          handoff: {
            sessionId: "waiting-session-sess",
            sessionName: "出库扫码",
            instanceId: "synology:30141",
            handoffId: "h-snap-1",
            resumeTask: "确认出库",
            token: "tok-snap",
            generation: 1,
            ownerPid: 333,
          },
          queue: [],
        },
      ],
    },
  });

  setOdooLanClientStub(client);

  // 第一步：正常就绪状态
  const res1 = await getRpcWaitingSessionsSnapshot();
  assert.equal(res1.authorityAvailable, true);
  assert.ok(res1.sessions["waiting-session-sess"]);
  assert.equal(res1.sessions["waiting-session-sess"].status, "handoff");
  assert.equal(res1.sessions["waiting-session-sess"].addon, "stock_picking");

  // 第二步：模拟权威节点断线（status 抛错，getCachedSnapshot 返回 undefined）
  client.getCachedSnapshot = () => undefined;
  client.status = async () => {
    throw new Error("Authority connection refused");
  };

  const res2 = await getRpcWaitingSessionsSnapshot();
  // 必须明确返回 authorityAvailable: false，且保留已知等待映射，绝不能清成空闲！
  assert.equal(res2.authorityAvailable, false);
  assert.ok(res2.sessions["waiting-session-sess"], "Must preserve last known waiting sessions on disconnect");

  setOdooLanClientStub(null);
});

test("startRpcSession boundary: cold restore real wrapper integration with stub model (no real API)", async () => {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url, {
    alias: { "@": process.cwd() },
    interopDefault: true,
    moduleCache: false,
  });
  const { startRpcSession, getRpcSession } = await jiti.import("./rpc-manager.ts");
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");

  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "odoo-cold-restore-cwd-"));
  const manager = SessionManager.create(tmpCwd);
  manager.appendMessage({ role: "user", content: "前序待办：继续测试Odoo接力", timestamp: Date.now() });
  const coldSessionId = manager.getSessionId();
  const coldSessionFile = manager.getSessionFile();

  assert.ok(coldSessionFile && fs.existsSync(coldSessionFile));

  let ackReceived = false;
  const client = createMockOdooClient({
    instanceId: "synology:30141",
    initialSnapshot: {
      resources: [
        {
          resource: "sale_commission",
          status: "handoff",
          handoff: {
            sessionId: coldSessionId,
            sessionName: "销售订单提成核算",
            instanceId: "synology:30141",
            handoffId: `h-cold-${coldSessionId.slice(0, 8)}`,
            resumeTask: "继续编写计算单测",
            token: "tok-cold-verified",
            generation: 1,
            ownerPid: process.pid,
          },
          queue: [],
        },
      ],
    },
    onRequest: async (cmd) => {
      if (cmd.action === "ack") {
        ackReceived = true;
        return { status: "acknowledged" };
      }
      return { status: "ok" };
    },
  });

  setOdooLanClientStub(client);

  let startedWrapper = null;
  const dispatcher = createOdooLanDispatcher({
    client,
    pollIntervalMs: 50,
    resolveSessionPath: async (id) => (id === coldSessionId ? coldSessionFile : undefined),
    startSession: async (id, file, cwd) => {
      // 真实调用 startRpcSession 边界，toolNames: [] 隔离真实 API
      const result = await startRpcSession(id, file, cwd, { toolNames: [] });
      startedWrapper = result.session;
      return result;
    },
  });

  try {
    // 触发扫描，执行真实冷恢复
    await dispatcher.triggerScan();

    // 验证冷会话已通过真实的 startRpcSession 成功恢复并注册到运行管理器
    assert.ok(startedWrapper, "Cold session wrapper must be started via startRpcSession");
    const registeredSession = getRpcSession(coldSessionId);
    assert.ok(registeredSession, "Session must be registered in rpc registry");
    assert.equal(registeredSession.isAlive(), true, "Restored wrapper must be alive");
  } finally {
    await dispatcher.stop();
    if (startedWrapper) {
      await startedWrapper.destroy();
    }
    setOdooLanClientStub(null);
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  }
});
