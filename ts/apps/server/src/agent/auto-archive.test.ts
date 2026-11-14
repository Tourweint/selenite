import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

/**
 * 自动归档调度器（2026-11-13 对齐 ZCode 批A）测试。
 *
 * 两层：
 *   1. 判定纯函数（selectAutoArchiveCandidates）：置顶/忙/非 worker/空会话/未到期/已归档
 *      的跳过与最旧优先排序——直接喂快照，不搭 durable。
 *   2. 真 Harness + 真临时 SQLite 的 sweepOnce（与 durable-delete.test.ts 同一隔离套路）：
 *      老会话真的被 archiveChat、置顶/忙/非 worker/未到期真的不动、上限 50 截断。
 *   3. 调度器定时器：开关关不开、动态关清定时器（sync 的两条路，不真等 5 分钟）。
 */

const root = mkdtempSync(join(tmpdir(), "lifediary-auto-archive-"));
process.env.AGENT_DB_PATH = join(root, "agent.sqlite");
process.env.AGENT_CHAT_META_PATH = join(root, "chat-meta.json");
process.env.AGENT_APPROVALS_PATH = join(root, "approvals.json");
process.env.AGENT_POLICY_PATH = join(root, "policy.json");
process.env.AGENT_GATE_AUDIT_PATH = join(root, "gate-blocks.jsonl");
process.env.AGENT_FLAGS_PATH = join(root, "agent-flags.json");
process.env.MEMORY_ENABLED = "false";
process.env.PARTNERS_DB_PATH = join(root, "partners.sqlite");
process.env.PARTNER_HOMES_ROOT = join(root, "partner-homes");
process.env.CHIEF_PARTNER = "false";
process.env.PROJECTS_DB_PATH = join(root, "projects.sqlite");
process.env.TOPICS_STATE_PATH = join(root, "topics.json");
process.env.LLM_PROVIDER = "faux";
// 派活单目录也钉到临时目录：否则采集器会去扫开发机真实的 runs/，夹具就没法控制
// 「在办的单不收」这条。测试里只放两张假的 ticket.json。
process.env.CHANCELLOR_WORK_ROOT = join(root, "runs");

const { BACKGROUND_CONTEXT: CTX } = await import("@earendil-works/chord/context");
const { LiveDoc } = await import("@earendil-works/pi-durable");
const session = await import("./session.ts");
const lifecycle = await import("./lifecycle.ts");
const autoArchive = await import("./auto-archive.ts");

after(async () => {
  // 收尾把 Harness / 惰性单例的句柄都交出来（Windows 下不关干净 rmSync 会 EPERM）
  try {
    await lifecycle.closeHarnessForMaintenance();
  } catch {
    /* 已关 */
  }
  try {
    const { partnersStore } = await import("../partners.ts");
    partnersStore().close();
  } catch {
    /* 没开过 */
  }
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* 个别句柄被系统延迟释放：临时目录留给 OS 清，不影响测试结论 */
  }
});

// ── 夹具 ────────────────────────────────────────────────

async function writeUserEntry(externalId: string, text: string, at = Date.now()): Promise<void> {
  const chat = await session.openChat(externalId);
  if (!chat) throw new Error(`夹具会话不存在: ${externalId}`);
  await chat.conversation.submit(
    {
      type: "write",
      entry: {
        kind: "pi.user",
        model: [{ role: "user", content: [{ type: "text", text }], timestamp: at }],
      },
    },
    CTX,
  );
}

async function createWorkerChat(
  firstText: string,
  at = Date.now(),
): Promise<{ externalId: string; internalId: number }> {
  const chat = await session.openChat(undefined, undefined, "worker");
  if (!chat) throw new Error("夹具建会话失败");
  await writeUserEntry(chat.externalId, firstText, at);
  return { externalId: chat.externalId, internalId: chat.internalId };
}

/** 忙态夹具：写/清 `pi.live.run`（忙态唯一事实源，确定性）。 */
async function setFakeBusy(internalId: number, busy: boolean): Promise<void> {
  const harness = await lifecycle.getHarness();
  await harness.commit(async (tx) => {
    const live = await tx.doc(LiveDoc, internalId as never);
    if (busy) live.run = { taskId: 9_000_002 as never, inputs: [] as never };
    else delete live.run;
  }, CTX);
}

function readMetaFile(): Record<string, unknown> {
  return JSON.parse(readFileSync(process.env.AGENT_CHAT_META_PATH!, "utf8")) as Record<
    string,
    unknown
  >;
}

// ── 开关与天数（env 懒读）────────────────────────────────

test("archiveAutoEnabled / archiveAutoDays：默认关、默认 30、非法回落", () => {
  const saved = { enabled: process.env.ARCHIVE_AUTO_ENABLED, days: process.env.ARCHIVE_AUTO_DAYS };
  try {
    delete process.env.ARCHIVE_AUTO_ENABLED;
    delete process.env.ARCHIVE_AUTO_DAYS;
    assert.equal(autoArchive.archiveAutoEnabled(), false, "默认关（翻案的是能力，不是替用户做主）");
    assert.equal(autoArchive.archiveAutoDays(), 30, "默认 30 天");
    for (const value of ["true", "1", "on"]) {
      process.env.ARCHIVE_AUTO_ENABLED = value;
      assert.equal(autoArchive.archiveAutoEnabled(), true, value);
    }
    for (const value of ["false", "0", "off", ""]) {
      process.env.ARCHIVE_AUTO_ENABLED = value;
      assert.equal(autoArchive.archiveAutoEnabled(), false, value);
    }
    for (const [value, expected] of [
      ["1", 1],
      ["7", 7],
      [" 45 ", 45],
      ["0", 30],
      ["-3", 30],
      ["abc", 30],
      ["2.5", 30],
    ] as const) {
      process.env.ARCHIVE_AUTO_DAYS = value;
      assert.equal(autoArchive.archiveAutoDays(), expected, `days=${value}`);
    }
  } finally {
    if (saved.enabled === undefined) delete process.env.ARCHIVE_AUTO_ENABLED;
    else process.env.ARCHIVE_AUTO_ENABLED = saved.enabled;
    if (saved.days === undefined) delete process.env.ARCHIVE_AUTO_DAYS;
    else process.env.ARCHIVE_AUTO_DAYS = saved.days;
  }
});

// ── 判定纯函数 ──────────────────────────────────────────

test("判定：非收集类 / 单还在办 / 已归档 / 置顶 / 空会话 / 未到期 / 忙逐级跳过，命中按最旧优先", () => {
  const now = 1_000_000_000_000;
  const day = 86_400_000;
  // 2026-11-14：任务专线（task-）按用户口径也收，但只收单已落终态的；worker 与 task 互斥
  const entries = [
    { externalId: "chief-1", lastAt: now - 40 * day, worker: false, task: false, ticketSettled: true, archived: false, pinned: false, busy: false },
    { externalId: "partner-1", lastAt: now - 40 * day, worker: false, task: false, ticketSettled: true, archived: false, pinned: false, busy: false },
    { externalId: "task-open-1", lastAt: now - 40 * day, worker: false, task: true, ticketSettled: false, archived: false, pinned: false, busy: false },
    { externalId: "archived-1", lastAt: now - 40 * day, worker: true, task: false, ticketSettled: true, archived: true, pinned: false, busy: false },
    { externalId: "pinned-1", lastAt: now - 40 * day, worker: true, task: false, ticketSettled: true, archived: false, pinned: true, busy: false },
    { externalId: "empty-1", lastAt: null, worker: true, task: false, ticketSettled: true, archived: false, pinned: false, busy: false },
    { externalId: "fresh-1", lastAt: now - 1 * day, worker: true, task: false, ticketSettled: true, archived: false, pinned: false, busy: false },
    { externalId: "busy-1", lastAt: now - 40 * day, worker: true, task: false, ticketSettled: true, archived: false, pinned: false, busy: true },
    { externalId: "old-2", lastAt: now - 50 * day, worker: true, task: false, ticketSettled: true, archived: false, pinned: false, busy: false },
    { externalId: "old-1", lastAt: now - 90 * day, worker: true, task: false, ticketSettled: true, archived: false, pinned: false, busy: false },
    { externalId: "old-3", lastAt: now - 31 * day, worker: true, task: false, ticketSettled: true, archived: false, pinned: false, busy: false },
    { externalId: "edge-1", lastAt: now - 30 * day, worker: true, task: false, ticketSettled: true, archived: false, pinned: false, busy: false },
    { externalId: "task-done-1", lastAt: now - 60 * day, worker: false, task: true, ticketSettled: true, archived: false, pinned: false, busy: false },
  ];
  const { hits, skipped } = autoArchive.selectAutoArchiveCandidates(entries, now - 30 * day);
  assert.deepEqual(
    hits.map((hit) => hit.externalId),
    ["old-1", "task-done-1", "old-2", "old-3"],
    "收超过 30 天没动的普通对话与已结束的任务专线，最旧的先；恰好在 30 天线上的不收（< 严格小于）",
  );
  assert.deepEqual(skipped, { kind: 2, openTicket: 1, archived: 1, pinned: 1, empty: 1, fresh: 2, busy: 1 });
});

// ── 调度器定时器（不真等 5 分钟）─────────────────────────

test("调度器：开关关不开定时器；动态开→挂首轮；动态关→清定时器", () => {
  let enabled = false;
  let sweepCalls = 0;
  const scheduler = autoArchive.autoArchiveScheduler({
    enabled: () => enabled,
    sweep: async () => {
      sweepCalls += 1;
    },
  });
  try {
    scheduler.sync();
    assert.deepEqual(scheduler.timerState(), { firstRun: false, interval: false, running: false });
    assert.equal(sweepCalls, 0, "开关关：零开销（不开定时器不扫描）");

    enabled = true;
    scheduler.sync();
    assert.deepEqual(
      scheduler.timerState(),
      { firstRun: true, interval: false, running: false },
      "开：挂 5 分钟首轮（此后才转每小时 interval）",
    );

    enabled = false;
    scheduler.sync();
    assert.deepEqual(scheduler.timerState(), { firstRun: false, interval: false, running: false }, "动态关：定时器清掉");
    assert.equal(sweepCalls, 0);
  } finally {
    scheduler.resetForTest();
  }
});

// ── 真实 sweepOnce（真 Harness + 真临时库）────────────────

test("sweepOnce：老普通对话与已结束的任务专线收进归档；在办单 / 置顶 / 忙 / 非收集类 / 已归档 / 未到期不动；上限 50", async () => {
  const now = Date.now();
  const day = 86_400_000;

  // 会收的：普通对话（41 / 40 天没动）
  const old1 = await createWorkerChat("老会话一", now - 41 * day);
  const old2 = await createWorkerChat("老会话二", now - 40 * day);

  // 任务专线三种（2026-11-14 新口径）：单已 done 收；单文件已不在磁盘也收；单还在跑不收
  const workRoot = process.env.CHANCELLOR_WORK_ROOT!;
  const writeTicket = (ticketId: string, status: string): void => {
    mkdirSync(join(workRoot, ticketId), { recursive: true });
    writeFileSync(join(workRoot, ticketId, "ticket.json"), JSON.stringify({ id: ticketId, status }));
  };
  const taskDone = await session.openOrCreateChat("task-AUTO-DONE");
  await writeUserEntry(taskDone.externalId, "已结束的任务专线", now - 45 * day);
  writeTicket("AUTO-DONE", "done");
  const taskGone = await session.openOrCreateChat("task-AUTO-GONE");
  await writeUserEntry(taskGone.externalId, "单已不在磁盘的任务专线", now - 42 * day);
  // AUTO-GONE 刻意不落 ticket.json：单办完目录被清掉是常态
  const taskRunning = await session.openOrCreateChat("task-AUTO-RUN");
  await writeUserEntry(taskRunning.externalId, "在办的任务专线", now - 40 * day);
  writeTicket("AUTO-RUN", "running");

  // 不收的：各关卡一样一个
  const pinned = await createWorkerChat("置顶会话", now - 40 * day);
  session.pinChat(pinned.externalId, true);
  const busy = await createWorkerChat("忙会话", now - 40 * day);
  await setFakeBusy(busy.internalId, true);
  const chief = await session.openChat(undefined);
  assert.ok(chief);
  await writeUserEntry(chief.externalId, "总管老对话", now - 40 * day);
  const alreadyArchived = await createWorkerChat("已归档会话", now - 40 * day);
  session.archiveChat(alreadyArchived.externalId, now);
  const fresh = await createWorkerChat("新会话", now);
  const empty = await session.openChat(undefined, undefined, "worker"); // 空会话（无条目）

  // 上限夹具：再铺 51 个 35 天没动的普通对话（4 个具名命中 + 51 = 55 > 50，被截到 50）
  const extraOlds: string[] = [];
  for (let index = 0; index < 51; index += 1) {
    const chat = await createWorkerChat(`上限夹具 ${index}`, now - 35 * day);
    extraOlds.push(chat.externalId);
  }

  await autoArchive.autoArchiveScheduler().sweepOnce(await lifecycle.getHarness());

  const meta = readMetaFile();
  const archived = new Set((meta.archived as string[]) ?? []);
  assert.ok(archived.has(old1.externalId), "老会话被自动归档");
  assert.ok(archived.has(old2.externalId));
  assert.ok(archived.has(taskDone.externalId), "单已 done 的任务专线也收");
  assert.ok(archived.has(taskGone.externalId), "单已不在磁盘的任务专线也收");
  assert.equal(archived.has(taskRunning.externalId), false, "单还在跑的任务专线不收");
  assert.equal(archived.has(pinned.externalId), false, "置顶不动");
  assert.equal(archived.has(busy.externalId), false, "忙不动");
  assert.equal(archived.has(chief!.externalId), false, "总管不是收集类，不收");
  assert.equal(archived.has(alreadyArchived.externalId), true, "已归档保持原样");
  assert.equal(archived.has(fresh.externalId), false, "未到期不动");
  assert.equal(archived.has(empty!.externalId), false, "空会话不动");

  // 上限：本轮恰好收 50（4 个具名 + 46 个夹具），加上先前手动归档的 1 条
  assert.equal(archived.size, 51, "本轮总归档数 = 上限 50");
  assert.equal(
    extraOlds.filter((externalId) => archived.has(externalId)).length,
    46,
    "最旧的先收：具名 4 条都在批内，夹具按最旧优先占满余下 46 个名额",
  );

  // 忙态夹具清理（不影响断言，只还库一个干净态）
  await setFakeBusy(busy.internalId, false);
});

test("flags 端点写 ARCHIVE_AUTO_DAYS：数值校验走 min=1（PUT 0 拒、PUT 7 收）", async () => {
  const { mountFlags } = await import("../flags.ts");
  const app = new Hono();
  mountFlags(app);
  const bad = await app.request("/api/v1/agent/flags/ARCHIVE_AUTO_DAYS", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value: "0" }),
  });
  assert.equal(bad.status, 400, "小于 1 的天数拒收");
  const good = await app.request("/api/v1/agent/flags/ARCHIVE_AUTO_DAYS", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value: "7" }),
  });
  assert.equal(good.status, 200);
  assert.equal(process.env.ARCHIVE_AUTO_DAYS, "7", "懒读消费处当场生效");
  const junk = await app.request("/api/v1/agent/flags/ARCHIVE_AUTO_DAYS", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value: "abc" }),
  });
  assert.equal(junk.status, 400);
  delete process.env.ARCHIVE_AUTO_DAYS;
});
