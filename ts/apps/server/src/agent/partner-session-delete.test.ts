import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 分支会话删除（2026-11-18）服务端测试。
 *
 * 与 durable-delete.test.ts 同一套隔离：先设 env 再动态 import，真 Harness + 真临时 SQLite，
 * LLM_PROVIDER=faux 只为 readLlmConfig 不空（条目走 write submission，零模型调用）。
 *
 * 覆盖：side 成功删除（会话行 / 映射 / ChatOrigins / 链接 / chat-meta 全清）、
 * canonical 拒绝、总管无来源副本拒绝、有子分支拒绝、busy 拒绝、开关关拒绝。
 */

const root = mkdtempSync(join(tmpdir(), "lifediary-partner-session-delete-"));
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
process.env.COMPANIONS_ENABLED = "true";
process.env.PARTNER_SIDE_SESSIONS = "true";
process.env.PARTNER_SESSION_MANAGE = "true";
process.env.LLM_PROVIDER = "faux";

const { BACKGROUND_CONTEXT: CTX } = await import("@earendil-works/chord/context");
const { LiveDoc } = await import("@earendil-works/pi-durable");
const session = await import("./session.ts");
const lifecycle = await import("./lifecycle.ts");
const { deletePartnerSession } = await import("./partner-session-delete.ts");
const { Chats, ChatKinds, ChatOrigins } = await import("./shared.ts");
const { partnersStore } = await import("../partners.ts");

after(async () => {
  try {
    await lifecycle.closeHarnessForMaintenance();
  } catch {
    /* 已关 */
  }
  try {
    partnersStore().close();
  } catch {
    /* 没开过 */
  }
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* 句柄被系统延迟释放：留给 OS 清 */
  }
});

let seq = 0;

function nextPartnerId(): string {
  seq += 1;
  return `partner-test-${seq}-${Date.now()}`;
}

async function writeUserEntry(externalId: string, text: string): Promise<void> {
  const chat = await session.openChat(externalId);
  if (!chat) throw new Error(`夹具会话不存在: ${externalId}`);
  await chat.conversation.submit(
    {
      type: "write",
      entry: {
        kind: "pi.user",
        model: [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }],
      },
    },
    CTX,
  );
}

/** 建一条真实会话；kind=worker 会写 ChatKinds，chief 不写（chatKindOfInternal 的默认）。 */
async function createChat(kind: "worker" | "chief" = "worker"): Promise<{
  externalId: string;
  internalId: number;
}> {
  const chat = await session.openChat(undefined, undefined, kind);
  if (!chat) throw new Error("夹具建会话失败（readLlmConfig 为空？）");
  await writeUserEntry(chat.externalId, `夹具消息 ${chat.externalId}`);
  return { externalId: chat.externalId, internalId: chat.internalId };
}

function linkSide(partnerId: string, externalId: string, internalId: number): void {
  partnersStore().linkSession({
    partnerId,
    role: "side",
    routeKey: externalId,
    sessionId: internalId,
  });
}

async function setOrigin(childExternalId: string, sourceExternalId: string): Promise<void> {
  const harness = await lifecycle.getHarness();
  await harness.commit(async (tx) => {
    const origins = await tx.doc(ChatOrigins);
    origins.byExternal[childExternalId] = { source: sourceExternalId, at: Date.now() };
  }, CTX);
}

async function setFakeBusy(internalId: number): Promise<void> {
  const harness = await lifecycle.getHarness();
  await harness.commit(async (tx) => {
    const live = await tx.doc(LiveDoc, internalId as never);
    live.run = { taskId: 9_000_002 as never, inputs: [] as never };
  }, CTX);
}

async function mappings(): Promise<{
  chats: Record<string, number>;
  origins: Record<string, { source: string }>;
}> {
  const harness = await lifecycle.getHarness();
  const [chats, origins] = await Promise.all([
    harness.snapshot(Chats, CTX),
    harness.snapshot(ChatOrigins, CTX),
  ]);
  return {
    chats: { ...(chats?.byExternal ?? {}) },
    origins: { ...(origins?.byExternal ?? {}) },
  };
}

function readMetaFile(): Record<string, unknown> {
  return JSON.parse(readFileSync(process.env.AGENT_CHAT_META_PATH!, "utf8")) as Record<
    string,
    unknown
  >;
}

// ── 用例 ─────────────────────────────────────────────────

test("删 side 副会话：会话行 / 映射 / ChatOrigins / 链接 / chat-meta 全清", async () => {
  const partnerId = nextPartnerId();
  const { externalId, internalId } = await createChat("worker");
  linkSide(partnerId, externalId, internalId);
  await setOrigin(externalId, "partner-source-not-in-list");
  session.renameChat(externalId, "要删的分支");

  const result = await deletePartnerSession(partnerId, externalId);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(result.conversationId, externalId);
  assert.ok(result.deleted.conversations >= 1);
  assert.ok(result.deleted.entries >= 1);

  // durable 里已经打不开
  assert.equal(await session.openChat(externalId), null);
  const after = await mappings();
  assert.equal(after.chats[externalId], undefined, "Chats 映射应清掉");
  assert.equal(after.origins[externalId], undefined, "ChatOrigins 应清掉");
  assert.equal(partnersStore().linkOfSession(internalId), null, "side 链接应删掉");

  const meta = readMetaFile();
  const titles = (meta.titles ?? {}) as Record<string, string>;
  assert.equal(titles[externalId], undefined, "chat-meta 标题应清掉");
});

test("canonical 主对话拒绝：409 not_side_session", async () => {
  const partnerId = nextPartnerId();
  const { externalId, internalId } = await createChat("worker");
  partnersStore().linkSession({
    partnerId,
    role: "canonical",
    routeKey: externalId,
    sessionId: internalId,
  });

  const result = await deletePartnerSession(partnerId, externalId);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 409);
  assert.equal(result.error, "not_side_session");
  assert.ok(await session.openChat(externalId), "被拒后会话还在");
});

test("总管无来源的会话拒绝：409 not_side_session", async () => {
  const { externalId } = await createChat("chief");
  const result = await deletePartnerSession("chief", externalId);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 409);
  assert.equal(result.error, "not_side_session");
  assert.ok(await session.openChat(externalId), "主对话还在");
});

test("有子分支拒绝：400 has_branches，母会话原样保留", async () => {
  const partnerId = nextPartnerId();
  const parent = await createChat("worker");
  linkSide(partnerId, parent.externalId, parent.internalId);
  const child = await createChat("worker");
  linkSide(partnerId, child.externalId, child.internalId);
  await setOrigin(child.externalId, parent.externalId);

  const result = await deletePartnerSession(partnerId, parent.externalId);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 400);
  assert.equal(result.error, "has_branches");
  assert.match(result.message, /1 条分支/);
  assert.ok(await session.openChat(parent.externalId), "母会话还在");
});

test("缺 side 链接的分支副本：沿 ChatOrigins 认回执事，仍可删", async () => {
  const partnerId = nextPartnerId();
  const parent = await createChat("worker");
  linkSide(partnerId, parent.externalId, parent.internalId);
  const child = await createChat("worker");
  // 刻意不登记 side 链接：老数据可能只有 ChatOrigins，选择器仍会把它补出来。
  await setOrigin(child.externalId, parent.externalId);

  const result = await deletePartnerSession(partnerId, child.externalId);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(await session.openChat(child.externalId), null);
  assert.ok(await session.openChat(parent.externalId), "母会话不受影响");
});

test("busy 拒绝：400 conversation_busy", async () => {
  const partnerId = nextPartnerId();
  const { externalId, internalId } = await createChat("worker");
  linkSide(partnerId, externalId, internalId);
  await setFakeBusy(internalId);

  const result = await deletePartnerSession(partnerId, externalId);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 400);
  assert.equal(result.error, "conversation_busy");
});

test("开关关：400 partner_session_manage_disabled", async () => {
  const partnerId = nextPartnerId();
  const { externalId, internalId } = await createChat("worker");
  linkSide(partnerId, externalId, internalId);
  process.env.PARTNER_SESSION_MANAGE = "false";
  try {
    const result = await deletePartnerSession(partnerId, externalId);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 400);
    assert.equal(result.error, "partner_session_manage_disabled");
    assert.ok(await session.openChat(externalId), "开关关时不能删");
  } finally {
    process.env.PARTNER_SESSION_MANAGE = "true";
  }
});
