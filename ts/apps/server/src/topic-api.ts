import type { Hono } from "hono";
import {
	TOPICS_ENABLED,
	formatTopicWhen,
	nextTopicFire,
	topicsStore,
	type Topic,
	type TopicStatus,
} from "./topics.ts";
import { ensureScheduled, runTopicNow } from "./topic-runtime.ts";

/**
 * 课题接口（2026-11-07 长期课题跟进 §七，web 专用一期）。
 *
 * `TOPICS_ENABLED=false` 时一个路由都不挂（404 = 未启用，同 COMPANIONS / GROUPS 口径）。
 * 鉴权走 index.ts 的全局中间件，本模块不单独处理：鉴权失败 403 空体，
 * 业务拒绝 400 `{ ok:false, error, message }`。
 *
 * 提议**没有直接的 HTTP 入口**：口只有两个（用户直说 / 总管嗅探），
 * 都先经 `propose_topic` 工具落成 pending 提议；这里只负责确认 / 拒绝 / 查询状态。
 */

export function mountTopics(app: Hono): void {
	if (!TOPICS_ENABLED) return;
	const store = () => topicsStore();

	// ── 提议（批二卡片刷新 / 双按钮）──────────────────────
	app.get("/api/v1/topics/proposals/:id", (c) => {
		store().expireProposals();
		const proposal = store().getProposal(c.req.param("id"));
		if (!proposal) return c.json({ ok: false, error: "not_found" }, 404);
		return c.json({ ok: true, proposal });
	});

	app.post("/api/v1/topics/proposals/:id/accept", async (c) => {
		const result = store().acceptProposal(c.req.param("id"));
		if (!result.ok) {
			// 业务拒绝一律 400 带说明（§七：search_not_configured / topic_limit / expired / not_found）
			return c.json(
				{
					ok: false,
					error: result.reason === "limit" ? "topic_limit" : result.reason,
					message: result.message,
					...(result.existingTopicId ? { existingTopicId: result.existingTopicId } : {}),
				},
				400,
			);
		}
		const topic = result.topic;
		try {
			await ensureScheduled(topic.id);
		} catch (error) {
			console.error(
				`[topic] 排程失败 ${topic.id.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return c.json(
				{ ok: false, error: "schedule_failed", message: "课题已建好，但排程失败，请稍后重试" },
				500,
			);
		}
		return c.json({ ok: true, topic: topicProjection(topic, false) });
	});

	app.post("/api/v1/topics/proposals/:id/decline", (c) => {
		return store().declineProposal(c.req.param("id"))
			? c.json({ ok: true })
			: c.json({ ok: false, error: "not_found", message: "提议不存在或已处理" }, 400);
	});

	// ── 课题 ────────────────────────────────────────────
	app.get("/api/v1/topics", (c) => {
		store().expireProposals();
		const topics = store().list();
		return c.json({
			ok: true,
			topics: topics.map((topic) => topicProjection(topic, false)),
			activeCount: topics.filter((topic) => topic.status === "active").length,
		});
	});

	app.get("/api/v1/topics/:id", (c) => {
		const topic = store().get(c.req.param("id"));
		if (!topic) return c.json({ ok: false, error: "not_found" }, 404);
		return c.json({ ok: true, topic: topicProjection(topic, true) });
	});

	app.patch("/api/v1/topics/:id", async (c) => {
		const body = (await c.req.json().catch(() => null)) as
			| { cron?: unknown; status?: unknown }
			| null;
		const id = c.req.param("id");
		const patch: { cron?: string; status?: TopicStatus } = {};
		if (body?.cron !== undefined) {
			if (typeof body.cron !== "string") {
				return c.json({ ok: false, error: "bad_request", message: "cron 需要字符串" }, 400);
			}
			patch.cron = body.cron;
		}
		if (body?.status !== undefined) {
			if (body.status !== "active" && body.status !== "paused") {
				return c.json(
					{ ok: false, error: "bad_request", message: "status 只能是 active / paused（关闭走 close）" },
					400,
				);
			}
			patch.status = body.status;
		}
		if (patch.cron === undefined && patch.status === undefined) {
			return c.json({ ok: false, error: "bad_request", message: "需要 cron 或 status" }, 400);
		}
		const result = store().patch(id, patch);
		if (!result.ok) {
			if (result.reason === "not_found") return c.json({ ok: false, error: "not_found" }, 404);
			return c.json(
				{
					ok: false,
					error: "bad_request",
					message:
						result.reason === "bad_cron"
							? "cron 看不懂（需要 5 段：分 时 日 月 周）"
							: "status 只能是 active / paused",
				},
				400,
			);
		}
		// 改 cron / 恢复 → 按新 revision 重排；暂停不排（旧任务醒来会因 revision 不符作废）。
		if (result.topic.status === "active") {
			await ensureScheduled(result.topic.id);
		}
		return c.json({ ok: true, topic: topicProjection(result.topic, false) });
	});

	app.post("/api/v1/topics/:id/close", async (c) => {
		const body = (await c.req.json().catch(() => null)) as { reason?: unknown } | null;
		const reason = typeof body?.reason === "string" ? body.reason : undefined;
		const topic = store().close(c.req.param("id"), reason);
		if (!topic) return c.json({ ok: false, error: "not_found" }, 404);
		return c.json({ ok: true, topic: topicProjection(topic, false) });
	});

	app.post("/api/v1/topics/:id/run_now", async (c) => {
		const topic = store().get(c.req.param("id"));
		if (!topic) return c.json({ ok: false, error: "not_found" }, 404);
		if (topic.status !== "active") {
			return c.json(
				{ ok: false, error: "inactive", message: "课题不在进行中，先恢复再跑" },
				400,
			);
		}
		const run = await runTopicNow(topic.id);
		return c.json({ ok: true, run });
	});
}

/** 对外投影：全 uuid；列表不展开 finding 正文，详情才给全量。 */
function topicProjection(topic: Topic, full: boolean) {
	const next = nextTopicFire(topic);
	const latest = topic.findings[0];
	return {
		id: topic.id,
		question: topic.question,
		flavor: topic.flavor,
		cron: topic.cron,
		status: topic.status,
		revision: topic.revision,
		origin: topic.origin,
		pendingPush: topic.pendingPush,
		noNewStreak: topic.noNewStreak,
		lastRunAt: topic.lastRunAt ?? null,
		lastError: topic.lastError ?? null,
		createdAt: topic.createdAt,
		closedAt: topic.closedAt ?? null,
		closeReason: topic.closeReason ?? null,
		nextFireAt: next ? next.toISOString() : null,
		nextFireLabel: next ? formatTopicWhen(next) : null,
		findingCount: topic.findings.length,
		latestFinding: latest
			? { id: latest.id, date: latest.date, summary: latest.summary, noNew: latest.noNew }
			: null,
		...(full ? { findings: topic.findings } : {}),
	};
}
