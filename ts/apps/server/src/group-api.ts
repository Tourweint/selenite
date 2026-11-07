import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
	GROUP_MEMBER_MAX,
	GROUP_MEMBER_MIN,
	GROUP_MESSAGE_LIMIT,
	type ChatEvent,
	type FinishReason,
	type GroupSender,
} from "@lifediary/shared";
import { partnersStore, type GroupRow } from "./partners.ts";
import { readLlmConfig } from "./provider.ts";
import { GroupRouteError, resolveGroupSpeakers } from "./group-routing.ts";
import { groupRoundRunning, startGroupRound, stopGroupRound, type GroupStreamEvent } from "./group-runtime.ts";
// 建群校验与落库的唯一实现在 group-manage（模型侧 group_manage 工具共用同一份）。
// 开关也从那里 re-export：工具装配要按同一个开关决定注不注册，不能再各写一份。
import {
	createGroupChecked,
	groupsAvailable,
	normalizeResponderKind,
} from "./group-manage.ts";

export { GROUPS_ENABLED, groupsAvailable } from "./group-manage.ts";

/**
 * 群组接口（2026-11-06 群组方案，接口文档 §2.14）。
 *
 * `GROUPS_ENABLED=false` 或 `COMPANIONS_ENABLED=false`（成员都没了）：一个路由都不挂，
 * 404 语义 = 未启用（同 COMPANIONS 口径；鉴权失败才是 403 空体，业务拒绝才 400 带说明）。
 * 本模块只做 HTTP 形状映射与校验：路由与回合在 group-routing / group-runtime，
 * 建群校验在 group-manage（与模型侧 group_manage 工具共用），存储在 partners.ts
 * ——和 companion-api 同一条分层纪律。
 */

export function mountGroups(app: Hono): void {
	if (!groupsAvailable()) return;
	const store = () => partnersStore();

	// ── 建群 ─────────────────────────────────────────────
	app.post("/api/v1/groups", async (c) => {
		const body = (await c.req.json().catch(() => null)) as
			| {
					name?: string;
					memberIds?: string[];
					responderKind?: string;
					responderPartnerId?: string;
					notice?: string;
			  }
			| null;
		// 校验 + 落库走 group-manage 的唯一实现（模型侧 group_manage 同一份）；这里只映射 HTTP 形状。
		const created = createGroupChecked(body ?? {}, store());
		if (!created.ok) {
			return c.json({ error: "bad_request", message: created.error }, 400);
		}
		return c.json({ ok: true, group: groupProjection(created.value) }, 201);
	});

	// ── 查 ───────────────────────────────────────────────
	app.get("/api/v1/groups", (c) => {
		return c.json({ ok: true, groups: store().listGroups().map(groupProjection) });
	});

	app.get("/api/v1/groups/:id", (c) => {
		const group = store().getGroup(c.req.param("id"));
		if (!group) return c.json({ ok: false, error: "not_found" }, 404);
		return c.json({ ok: true, group: groupProjection(group) });
	});

	// ── 改（改名/公告/应答口径/加减成员）──────────────────
	app.patch("/api/v1/groups/:id", async (c) => {
		const id = c.req.param("id");
		const body = (await c.req.json().catch(() => null)) as
			| {
					name?: string;
					notice?: string;
					responderKind?: string;
					responderPartnerId?: string | null;
					addMemberIds?: string[];
					removeMemberIds?: string[];
			  }
			| null;
		const existing = store().getGroup(id);
		if (!existing) return c.json({ ok: false, error: "not_found" }, 404);

		if (body?.name !== undefined && (!body.name.trim() || body.name.length > 40)) {
			return c.json({ error: "bad_request", message: "name 必填且不超过 40 字" }, 400);
		}
		if (body?.notice !== undefined && body.notice.length > 500) {
			return c.json({ error: "bad_request", message: "公告不超过 500 字" }, 400);
		}
		// 成员数校验看改后的最终名单：先在内存里演算一遍，不过就不落库
		const after = new Set(existing.members.map((m) => m.partnerId));
		for (const pid of body?.removeMemberIds ?? []) after.delete(pid);
		for (const pid of body?.addMemberIds ?? []) after.add(pid);
		if (after.size < GROUP_MEMBER_MIN || after.size > GROUP_MEMBER_MAX) {
			return c.json(
				{ error: "bad_request", message: `成员要 ${GROUP_MEMBER_MIN}–${GROUP_MEMBER_MAX} 名执事` },
				400,
			);
		}
		const addMemberIds = (body?.addMemberIds ?? []).filter((pid) => !existing.members.some((m) => m.partnerId === pid));
		const addedPartners = addMemberIds.map((pid) => store().get(pid));
		if (addMemberIds.length && addedPartners.some((p) => !p)) {
			return c.json({ error: "bad_request", message: "有执事不存在，刷新后再试" }, 400);
		}
		// 改后的最终名单里不许有重名（@ 歧义拒绝不猜）：现有成员 + 新增成员合起来查
		const finalNames = [
			...existing.members
				.filter((m) => after.has(m.partnerId))
				.map((m) => m.name),
			...addedPartners.filter((p) => p && !existing.members.some((m) => m.partnerId === p!.id)).map((p) => p!.name),
		];
		if (new Set(finalNames).size !== finalNames.length) {
			return c.json({ error: "bad_request", message: "群里有重名执事，@ 会分不清人，请先改名" }, 400);
		}

		const kind = body?.responderKind !== undefined ? normalizeResponderKind(body.responderKind) : existing.responderKind;
		let duty: string | null | undefined;
		if (body?.responderPartnerId !== undefined) {
			duty = body.responderPartnerId?.trim() || null;
		}
		const effectiveKind = kind;
		const effectiveDuty = duty !== undefined ? duty : existing.responderPartnerId;
		if (effectiveKind === "member") {
			if (!effectiveDuty || !after.has(effectiveDuty)) {
				return c.json(
					{ error: "bad_request", message: "值日执事必须是群成员（先把值日换成在群里的人）" },
					400,
				);
			}
		}
		const updated = store().updateGroup(id, {
			...(body?.name !== undefined ? { name: body.name } : {}),
			...(body?.notice !== undefined ? { notice: body.notice } : {}),
			...(body?.responderKind !== undefined ? { responderKind: kind } : {}),
			...(duty !== undefined ? { responderPartnerId: duty } : {}),
			...(addMemberIds.length ? { addMemberIds } : {}),
			...(body?.removeMemberIds?.length ? { removeMemberIds: body.removeMemberIds } : {}),
		});
		if (!updated) return c.json({ ok: false, error: "not_found" }, 404);
		return c.json({ ok: true, group: groupProjection(updated) });
	});

	// ── 删（硬删：群 + 成员 + 消息）──────────────────────
	app.delete("/api/v1/groups/:id", (c) => {
		const removed = store().deleteGroup(c.req.param("id"));
		if (!removed) return c.json({ ok: false, error: "not_found" }, 404);
		return c.json({ ok: true });
	});

	// ── 时间线回读 ───────────────────────────────────────
	app.get("/api/v1/groups/:id/messages", (c) => {
		const group = store().getGroup(c.req.param("id"));
		if (!group) return c.json({ ok: false, error: "not_found" }, 404);
		const beforeSeq = numberQuery(c.req.query("beforeSeq"));
		const limit = numberQuery(c.req.query("limit")) ?? 100;
		const messages = store().listGroupMessages(group.id, {
			...(beforeSeq !== undefined ? { beforeSeq } : {}),
			limit,
		});
		return c.json({ ok: true, messages, lastSeq: store().lastGroupSeq(group.id) });
	});

	// ── 发言（SSE 回合）──────────────────────────────────
	app.post("/api/v1/groups/:id/chat", async (c) => {
		const group = store().getGroup(c.req.param("id"));
		if (!group) return c.json({ ok: false, error: "not_found" }, 404);
		const body = (await c.req.json().catch(() => null)) as { text?: string } | null;
		const text = body?.text?.trim() ?? "";
		if (!text) return c.json({ error: "bad_request", message: "需要 text" }, 400);
		if (text.length > GROUP_MESSAGE_LIMIT) {
			return c.json({ error: "bad_request", message: `消息不超过 ${GROUP_MESSAGE_LIMIT} 字` }, 400);
		}
		// @ 歧义在发消息时就 400 拒绝（不猜）；这里先解一次，回合内部还会解一次（幂等）
		try {
			resolveGroupSpeakers(
				text,
				{ responderKind: group.responderKind, responderPartnerId: group.responderPartnerId },
				group.members,
			);
		} catch (error) {
			if (error instanceof GroupRouteError) {
				return c.json({ error: "bad_request", message: error.message }, 400);
			}
			throw error;
		}
		if (groupRoundRunning(group.id)) {
			return c.json(
				{ error: "busy", message: "这个群上一轮还在跑，等它说完再发（或点停止）" },
				409,
			);
		}
		if (!readLlmConfig()) {
			return c.json({ ok: false, reason: "llm_not_configured" }, 503);
		}

		const { roundId, channel } = startGroupRound(group, text);
		return streamSSE(c, async (stream) => {
			// 只推送。客户端断开这里会抛——回合照跑完落库（断线 ≠ 取消，方案 §2.4）
			try {
				for await (const event of channel.subscribe()) {
					await stream.writeSSE({ data: JSON.stringify(toChatEvent(event, roundId)) });
				}
			} catch {
				// 断开属正常路径：吞掉，落库由 group-runtime 负责
			}
		});
	});

	// ── 停止 ─────────────────────────────────────────────
	app.post("/api/v1/groups/:id/stop", async (c) => {
		const group = store().getGroup(c.req.param("id"));
		if (!group) return c.json({ ok: false, error: "not_found" }, 404);
		await stopGroupRound(group.id);
		return c.json({ ok: true, conversationId: group.id });
	});
}

function numberQuery(raw: string | undefined): number | undefined {
	if (raw === undefined || raw === "") return undefined;
	const value = Number(raw);
	return Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

/** 回合事件 → 共享契约的 ChatEvent（接口文档 §2.14：纯增量帧） */
function toChatEvent(event: GroupStreamEvent, roundId: string): ChatEvent {
	switch (event.type) {
		case "start":
			return { type: "start", id: roundId, conversationId: event.conversationId, sender: event.sender };
		case "delta":
			return { type: "delta", text: event.text };
		case "thinking":
			return { type: "thinking", text: event.text };
		case "progress":
			return { type: "progress", phase: event.phase };
		case "tool":
			return {
				type: "tool",
				name: event.name,
				status: event.status,
				...(event.label !== undefined ? { label: event.label } : {}),
				...(event.ok !== undefined ? { ok: event.ok } : {}),
				...(event.output !== undefined ? { output: event.output } : {}),
				...(event.args !== undefined ? { args: event.args } : {}),
			};
		case "notice":
			return { type: "notice", text: event.text };
		case "done":
			return { type: "done", id: event.id, finishReason: event.finishReason as FinishReason };
	}
}

/** 对外投影：群行 + 成员（成员只给 id/名/在群状态，内部自增 id 不出网） */
function groupProjection(group: GroupRow) {
	return {
		id: group.id,
		name: group.name,
		notice: group.notice,
		responderKind: group.responderKind,
		responderPartnerId: group.responderPartnerId,
		members: group.members.map((m) => ({
			partnerId: m.partnerId,
			name: m.name,
			status: m.status,
		})),
		createdAt: group.createdAt,
		updatedAt: group.updatedAt,
	};
}
