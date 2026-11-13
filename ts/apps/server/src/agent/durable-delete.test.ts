import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";

/**
 * 永久删除（2026-11-13 归档管理对齐 ZCode 批A）服务端测试。
 *
 * 与 archive.test.ts 的隔离套路同款：先设 env 再动态 import（CHAT_META_PATH / DB_PATH
 * 在模块加载时读）。这里**起真 Harness + 真临时 SQLite**（LLM_PROVIDER=faux 只是为了让
 * readLlmConfig 不空，不真调模型；条目全部用 write submission 写入，零模型调用）——
 * SQLite 手术、维护互斥、映射文档清理、chat-meta 清理都走真实路径（mock 不许空转）。
 *
 * 忙态夹具：直接经 tx.doc(LiveDoc) 写 `run` 字段（内核注释"present exactly while busy"）。
 * 这是忙态的唯一事实源，写它等于把会话摆到"正在运行"的状态，不依赖模型时长、确定性。
 *
 * 没覆盖：批 C 的 http 探针（真起服务的端到端）；这里用 mountDurableDelete 的裸 Hono
 * app 覆盖端点行为本身。
 */

const root = mkdtempSync(join(tmpdir(), "lifediary-durable-delete-"));
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
// 只为 readLlmConfig() 不空：faux 假模型，条目全走 write submission，零模型调用
process.env.LLM_PROVIDER = "faux";

const { BACKGROUND_CONTEXT: CTX } = await import("@earendil-works/chord/context");
const { LiveDoc } = await import("@earendil-works/pi-durable");
const session = await import("./session.ts");
const lifecycle = await import("./lifecycle.ts");
const durableDelete = await import("./durable-delete.ts");
const { Chats, ChatKinds, ChatProjects } = await import("./shared.ts");
const { openNodeSqliteDatabase } = await import("@earendil-works/pi-durable/storage/sqlite/node");

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

// ── 夹具工具 ─────────────────────────────────────────────

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

/** 新建一个普通会话（worker 种类）并写一条 pi.user；返回对外/内部 id。 */
async function createWorkerChat(
  firstText: string,
  at = Date.now(),
): Promise<{ externalId: string; internalId: number }> {
  const chat = await session.openChat(undefined, undefined, "worker");
  if (!chat) throw new Error("夹具建会话失败（readLlmConfig 为空？）");
  await writeUserEntry(chat.externalId, firstText, at);
  return { externalId: chat.externalId, internalId: chat.internalId };
}

/** 从源会话 fork 一个子会话（带对外映射与 worker 种类，与 forkForEdit 同口径）。 */
async function forkWorker(sourceInternalId: number, newExternalId: string): Promise<number> {
  const harness = await lifecycle.getHarness();
  const source = await harness.conversation(sourceInternalId as never, CTX);
  if (!source) throw new Error("夹具源会话不存在");
  const view = await source.context(CTX);
  const at = view.entries.at(-1)?.id;
  if (!at) throw new Error("夹具源会话没有条目，不能 fork");
  const conversation = await source.fork(
    at,
    {
      ownership: { kind: "ownerless" },
      init: async (tx, conversationId) => {
        const chats = await tx.doc(Chats);
        chats.byExternal[newExternalId] = Number(conversationId);
        const kinds = await tx.doc(ChatKinds);
        kinds.byInternal[String(conversationId)] = "worker";
      },
    },
    CTX,
  );
  return Number(conversation.id);
}

/** 忙态夹具：写/清 `pi.live.run`（"present exactly while busy" 是内核注释原文）。 */
async function setFakeBusy(internalId: number, busy: boolean): Promise<void> {
  const harness = await lifecycle.getHarness();
  await harness.commit(async (tx) => {
    const live = await tx.doc(LiveDoc, internalId as never);
    if (busy) live.run = { taskId: 9_000_001 as never, inputs: [] as never };
    else delete live.run;
  }, CTX);
}

async function chatMappings(): Promise<{
  chats: Record<string, number>;
  kinds: Record<string, string>;
  projects: Record<string, string>;
}> {
  const harness = await lifecycle.getHarness();
  const [chats, kinds, projects] = await Promise.all([
    harness.snapshot(Chats, CTX),
    harness.snapshot(ChatKinds, CTX),
    harness.snapshot(ChatProjects, CTX),
  ]);
  return {
    chats: { ...(chats?.byExternal ?? {}) },
    kinds: { ...(kinds?.byInternal ?? {}) },
    projects: { ...(projects?.byInternal ?? {}) },
  };
}

/** 裸 SQL 点名：按谓词计数（? 会被逐 id 替换），删除残留断言用。 */
async function countRowsWhere(table: string, where: string, ids: number[]): Promise<number> {
  const db = await openNodeSqliteDatabase(process.env.AGENT_DB_PATH!);
  try {
    let total = 0;
    for (const id of ids) {
      const row = await db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${table} WHERE ${where.replace("?", "?")}`,
        id,
      );
      total += Number(row?.n ?? 0);
    }
    return total;
  } finally {
    await db.close();
  }
}

function readMetaFile(): Record<string, unknown> {
  return JSON.parse(readFileSync(process.env.AGENT_CHAT_META_PATH!, "utf8")) as Record<
    string,
    unknown
  >;
}

/** 非 worker 夹具（chief / task-）的对外 id：blocked 用例登记，删除用例断言"别的会话不动"。 */
const keptExternalIds: string[] = [];

// ── 纯函数：子树 BFS ─────────────────────────────────────

test("排他维护段：并发删除串行执行，后一段看到前一段的效果", async () => {
  const order: string[] = [];
  const first = lifecycle.runExclusiveMaintenance(async () => {
    order.push("a-start");
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push("a-end");
    return "a";
  });
  const second = lifecycle.runExclusiveMaintenance(async () => {
    order.push("b-start");
    return "b";
  });
  assert.deepEqual(await first, "a");
  assert.deepEqual(await second, "b");
  assert.deepEqual(order, ["a-start", "a-end", "b-start"], "b 必须等 a 出段才开始");
  // 段都结束：闸放行（active=false）
  assert.equal(lifecycle.harnessMaintenanceActive(), false);
  // 抛错的段不堵队列：下一段照常执行
  await assert.rejects(
    lifecycle.runExclusiveMaintenance(async () => {
      throw new Error("第一段炸了");
    }),
    /第一段炸了/,
  );
  const after = await lifecycle.runExclusiveMaintenance(async () => "ok");
  assert.equal(after, "ok");
});

test("子树 BFS：父→子→孙逐层收集、无父边的行跳过、坏 JSON 不炸", () => {
  const rows = [
    { id: 1, record: JSON.stringify({ id: 1 }) },
    { id: 2, record: JSON.stringify({ id: 2, parent: { conversationId: 1, at: 5 } }) },
    { id: 3, record: JSON.stringify({ id: 3, parent: { conversationId: 2, at: 9 } }) },
    { id: 4, record: JSON.stringify({ id: 4, parent: { conversationId: 3, at: 9 } }) },
    { id: 5, record: "不是 JSON" },
    { id: 6, record: JSON.stringify({ id: 6, parent: { conversationId: "坏类型" } }) },
    { id: 7, record: JSON.stringify({ id: 7, parent: { conversationId: 99, at: 1 } }) }, // 父在集合外
  ];
  const index = durableDelete.buildForkChildrenIndex(rows);
  // 根=1 的子树：1、2、3、4（5/6 没有有效父边；7 的父 99 不在子树，从 1 出发收不到）
  assert.deepEqual(durableDelete.forkSubtreeOf(index, 1), [1, 2, 3, 4]);
  // 独立根：只有自己
  assert.deepEqual(durableDelete.forkSubtreeOf(index, 7), [7]);
  assert.deepEqual(durableDelete.forkSubtreeOf(index, 3), [3, 4], "从中间节点出发收它下面的枝");
});

// ── busy 拒绝归档（任务1）────────────────────────────────

test("busy 拒绝归档：archiveChatGuarded 忙时 400，空闲照旧归档", async () => {
  const { externalId, internalId } = await createWorkerChat("busy-400 夹具会话");

  await setFakeBusy(internalId, true);
  const busy = await session.archiveChatGuarded(externalId);
  assert.equal(busy.ok, false, "运行中拒绝归档");
  if (!busy.ok) {
    assert.equal(busy.status, 400);
    assert.equal(busy.error, "conversation_busy");
    assert.equal(busy.message, "会话正在运行，请先停止再归档");
  }
  assert.deepEqual(session.chatMetaSummary(), { archived: 0 }, "拒绝时不得写归档");

  await setFakeBusy(internalId, false);
  const idle = await session.archiveChatGuarded(externalId);
  assert.deepEqual(idle, { ok: true }, "空闲照旧归档");
  assert.deepEqual(session.chatMetaSummary(), { archived: 1 });
});

// ── 预检 blocked（not-archived / kind / busy）──────────────

test("预检 blocked：not-archived（门槛第一）；kind（chief / task- / partner）；busy", async () => {
  // not-archived：普通 worker 会话没归档
  const fresh = await createWorkerChat("未归档不能删");
  const freshPreview = await durableDelete.previewChatDeletion(fresh.externalId);
  assert.ok(freshPreview.ok, "预检本身应当成功（blocked 是响应内的字段）");
  if (freshPreview.ok) {
    assert.equal(freshPreview.preview.blocked?.reason, "not-archived");
    assert.deepEqual(freshPreview.preview.subtree, [], "blocked 时子树名单为空数组");
  }

  // kind=chief：总管会话（缺项即 chief），归档了也拒
  const chief = await session.openChat(undefined);
  assert.ok(chief);
  await writeUserEntry(chief.externalId, "总管会话正文");
  keptExternalIds.push(chief.externalId);
  session.archiveChat(chief.externalId, 100);
  const chiefPreview = await durableDelete.previewChatDeletion(chief.externalId);
  assert.ok(chiefPreview.ok);
  if (chiefPreview.ok) {
    assert.equal(chiefPreview.preview.blocked?.reason, "kind");
    assert.match(chiefPreview.preview.blocked?.detail ?? "", /总管/);
  }

  // kind=task-：任务会话（openOrCreateChat 是 task- 专线的建会话路径）
  const task = await session.openOrCreateChat("task-TST-1");
  await writeUserEntry(task.externalId, "任务专线正文");
  keptExternalIds.push(task.externalId);
  session.archiveChat(task.externalId, 200);
  const taskPreview = await durableDelete.previewChatDeletion(task.externalId);
  assert.ok(taskPreview.ok);
  if (taskPreview.ok) {
    assert.equal(taskPreview.preview.blocked?.reason, "kind");
    assert.match(taskPreview.preview.blocked?.detail ?? "", /任务/);
  }

  // kind=partner：执事专线（partner_session_links 决定，客户端不能自报）
  const partners = await import("../partners.ts");
  const store = partners.partnersStore();
  const partner = store.create("删除测试执事");
  const partnerChat = await session.openChat(undefined);
  assert.ok(partnerChat);
  await writeUserEntry(partnerChat.externalId, "执事专线正文");
  keptExternalIds.push(partnerChat.externalId);
  store.linkSession({
    partnerId: partner.id,
    role: "canonical",
    routeKey: "canonical",
    sessionId: partnerChat.internalId,
  });
  session.archiveChat(partnerChat.externalId, 300);
  const partnerPreview = await durableDelete.previewChatDeletion(partnerChat.externalId);
  assert.ok(partnerPreview.ok);
  if (partnerPreview.ok) {
    assert.equal(partnerPreview.preview.blocked?.reason, "kind");
    assert.match(partnerPreview.preview.blocked?.detail ?? "", /执事/);
  }

  // busy：根会话忙
  const busyTarget = await createWorkerChat("忙会话不能删");
  session.archiveChat(busyTarget.externalId, 400);
  await setFakeBusy(busyTarget.internalId, true);
  const busyPreview = await durableDelete.previewChatDeletion(busyTarget.externalId);
  assert.ok(busyPreview.ok);
  if (busyPreview.ok) {
    assert.equal(busyPreview.preview.blocked?.reason, "busy");
    assert.match(busyPreview.preview.blocked?.detail ?? "", /正在运行/);
    assert.deepEqual(busyPreview.preview.subtree, []);
  }
  await setFakeBusy(busyTarget.internalId, false);
});

test("端点：未知名 404；开关关 400「永久删除已关闭」；删除 blocked 400", async () => {
  const app = new Hono();
  durableDelete.mountDurableDelete(app);

  const unknownPreview = await app.request("/api/v1/agent/chat/nope/deletion-preview");
  assert.equal(unknownPreview.status, 404);
  const unknownDelete = await app.request("/api/v1/agent/chat/nope/delete", { method: "POST" });
  assert.equal(unknownDelete.status, 404);

  // 开关关：两端点 400（回滚开关）
  process.env.CHAT_HARD_DELETE = "false";
  try {
    const offPreview = await app.request("/api/v1/agent/chat/x/deletion-preview");
    assert.equal(offPreview.status, 400);
    const offBody = (await offPreview.json()) as { message: string };
    assert.equal(offBody.message, "永久删除已关闭");
    const offDelete = await app.request("/api/v1/agent/chat/x/delete", { method: "POST" });
    assert.equal(offDelete.status, 400);
    const offDeleteBody = (await offDelete.json()) as { message: string };
    assert.equal(offDeleteBody.message, "永久删除已关闭");
  } finally {
    delete process.env.CHAT_HARD_DELETE;
  }

  // blocked 删除：未归档 → 400 + blocked 结构
  const fresh = await createWorkerChat("delete-blocked 夹具");
  const blocked = await app.request(`/api/v1/agent/chat/${fresh.externalId}/delete`, {
    method: "POST",
  });
  assert.equal(blocked.status, 400);
  const blockedBody = (await blocked.json()) as {
    error: string;
    message: string;
    blocked: { reason: string };
  };
  assert.equal(blockedBody.error, "delete_blocked");
  assert.equal(blockedBody.blocked.reason, "not-archived");
});

test("删除前重跑预检：预检通过后被恢复（状态漂移），执行拒绝 not-archived", async () => {
  const drift = await createWorkerChat("状态漂移夹具");
  session.archiveChat(drift.externalId, 500);
  const before = await durableDelete.previewChatDeletion(drift.externalId);
  assert.ok(before.ok);
  if (before.ok) assert.equal(before.preview.blocked, undefined, "预检应当通过");

  // 预检与执行之间被恢复：执行前重跑的预检必须挡下
  session.unarchiveChat(drift.externalId);
  const rejected = await durableDelete.deleteChatForever(drift.externalId);
  assert.ok(!rejected.ok, "漂移后执行必须拒绝");
  if (!rejected.ok) {
    assert.equal(rejected.blocked?.reason, "not-archived");
    assert.equal(rejected.status, 400);
  }

  // 数据没动：会话行还在
  assert.equal(await countRowsWhere("conversations", "id = ?", [drift.internalId]), 1);
  session.archiveChat(drift.externalId, 600);
});

// ── 全量删除：子树连根删 + 计数 + 无残留 ──────────────────

test("永久删除：预检形状、执行计数、映射与 chat-meta 无残留、搜索源不含它", async () => {
  // 子树：W → C1 → C2（父→子→孙，fork 边真实存在于 conversations.record）
  const W = await createWorkerChat("唯一锚点词 zanzibar77：根会话第一句", 1_000);
  await writeUserEntry(W.externalId, "根会话第二句", 2_000);
  const C1 = randomUUID();
  const c1Internal = await forkWorker(W.internalId, C1);
  await writeUserEntry(C1, "分叉一自己的一句", 3_000);
  const C2 = randomUUID();
  const c2Internal = await forkWorker(c1Internal, C2);
  await writeUserEntry(C2, "分叉二自己的一句", 4_000);

  const before = await chatMappings();
  assert.equal(before.chats[W.externalId], W.internalId);
  assert.equal(before.chats[C1], c1Internal);
  assert.equal(before.chats[C2], c2Internal);
  assert.equal(before.kinds[String(W.internalId)], "worker");
  assert.equal(before.kinds[String(c1Internal)], "worker");
  assert.equal(before.kinds[String(c2Internal)], "worker");

  // 项目归属夹具（清 ChatProjects 条目的断言面）
  const harness = await lifecycle.getHarness();
  await harness.commit(async (tx) => {
    const projects = await tx.doc(ChatProjects);
    projects.byInternal[String(W.internalId)] = "project-del-1";
    projects.byInternal[String(c1Internal)] = "project-del-1";
  }, CTX);

  // chat-meta 夹具：三个都归档 + 标题 + C1 还带一个置顶
  session.archiveChat(W.externalId, 10_000);
  session.archiveChat(C1, 11_000);
  session.archiveChat(C2, 12_000);
  session.renameChat(W.externalId, "要删的根会话");
  session.pinChat(C1, true);

  // 预检形状（非 blocked）：名单含整棵子树 + estimate
  const preview = await durableDelete.previewChatDeletion(W.externalId);
  assert.ok(preview.ok);
  if (!preview.ok) return;
  const p = preview.preview;
  assert.equal(p.conversationId, W.externalId);
  assert.equal(p.title, "要删的根会话");
  assert.equal(p.rounds, 2, "根会话两条用户消息 = 2 轮");
  assert.ok(p.lastAt > 0);
  assert.equal(p.archivedAt, 10_000);
  assert.equal(p.blocked, undefined);
  assert.deepEqual(
    p.subtree.map((node) => node.conversationId).sort(),
    [W.externalId, C1, C2].sort(),
    "子树名单 = 根 + 两级分叉",
  );
  assert.equal(p.estimate.conversations, 3);
  assert.equal(p.estimate.entries, 4, "根2 + 分叉一1 + 分叉二1（fork 不复制 entries）");
  assert.equal(p.estimate.submissions, 4, "每条 write submission 一行");
  assert.equal(p.estimate.tasks, 0, "夹具没有定时任务");

  // 执行
  const result = await durableDelete.deleteChatForever(W.externalId);
  assert.ok(result.ok, `删除应成功：${result.ok ? "" : JSON.stringify(result)}`);
  if (!result.ok) return;
  assert.deepEqual(result.deleted, { conversations: 3, entries: 4, tasks: 0, submissions: 4 });

  // durable 残留：conversations / entries / 会话作用域文档全空
  const subtreeIds = [W.internalId, c1Internal, c2Internal];
  assert.equal(await countRowsWhere("conversations", "id = ?", subtreeIds), 0);
  assert.equal(await countRowsWhere("entries", "conversation_id = ?", subtreeIds), 0);
  assert.equal(
    await countRowsWhere("documents", "scope_kind = 'conversation' AND owner_id = ?", subtreeIds),
    0,
    "会话作用域文档（pi.agent / pi.live…）一并清掉",
  );

  // 三张映射：子树条目清光，别的会话原样
  const after = await chatMappings();
  for (const externalId of [W.externalId, C1, C2]) {
    assert.equal(after.chats[externalId], undefined, `Chats 不再有 ${externalId.slice(0, 8)}…`);
  }
  for (const internalId of subtreeIds) {
    assert.equal(after.kinds[String(internalId)], undefined, "ChatKinds 条目清掉");
    assert.equal(after.projects[String(internalId)], undefined, "ChatProjects 条目清掉");
  }
  for (const externalId of keptExternalIds) {
    assert.notEqual(after.chats[externalId], undefined, `别的会话映射还在：${externalId.slice(0, 8)}…`);
  }

  // chat-meta：四组痕迹全清，别的条目不动
  const meta = readMetaFile();
  const archived = (meta.archived as string[]) ?? [];
  const titles = (meta.titles as Record<string, string>) ?? {};
  const pins = (meta.pins as string[]) ?? [];
  const archivedAt = (meta.archivedAt as Record<string, number>) ?? {};
  for (const externalId of [W.externalId, C1, C2]) {
    assert.equal(archived.includes(externalId), false);
    assert.equal(externalId in titles, false);
    assert.equal(externalId in archivedAt, false);
    assert.equal(pins.includes(externalId), false);
  }
  for (const externalId of keptExternalIds) {
    assert.ok(archived.includes(externalId), "别的会话的归档记录不动");
  }

  // 搜索源（枚举面 = Chats 映射）不再含它：唯一锚点词搜不到；被删会话按 id 打不开
  const hits = await session.searchTranscripts("zanzibar77");
  assert.deepEqual(hits, [], "映射清了，搜索自动不含被删会话");
  assert.equal(await session.openChat(W.externalId), null);
  assert.equal(await session.openChat(C1), null);

  // 删除后 harness 照常工作：chief / task- 还能解析
  for (const externalId of keptExternalIds) {
    assert.notEqual(await session.openChat(externalId), null);
  }
});
