import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { SEARCH_VENDORS } from "./search.ts";
import { TOPIC_DEFAULT_CRON, TOPIC_MAX, TopicsStore } from "./topics.ts";

/**
 * 课题存储单测（2026-11-07 长期课题跟进 §十）：
 * cron 换算 / 同题查重 / 上限 / 饱和计数 / 提议过期 / 推送一次性。
 * 每个用例用独立临时文件，不碰 .data/。
 */

// 搜索门禁读的是 search.json + env：把配置指到不存在的临时路径，
// 避免开发机 .data/search.json / 其他搜索 key 让「未配置」用例假绿。
process.env.SEARCH_CONFIG_PATH = join(
	tmpdir(),
	`lifediary-topics-search-${randomUUID()}.json`,
);
for (const vendor of SEARCH_VENDORS) delete process.env[vendor.keyEnv];
process.env.DEEPSEEK_SEARCH_API_KEY = "probe-search-key";

after(() => {
	delete process.env.DEEPSEEK_SEARCH_API_KEY;
	delete process.env.SEARCH_CONFIG_PATH;
});

function newStore(): { store: TopicsStore; path: string } {
	const path = join(tmpdir(), `lifediary-topics-test-${randomUUID()}.json`);
	return { store: new TopicsStore(path), path };
}

function propose(store: TopicsStore, question: string, over: Partial<{ flavor: "watch" | "dig"; cron: string }> = {}) {
	const result = store.proposeTopic({
		question,
		flavor: over.flavor ?? "watch",
		...(over.cron ? { cron: over.cron } : {}),
		origin: "user",
	});
	if (!result.ok) throw new Error(`提议失败：${result.reason} ${result.message}`);
	return result.proposal;
}

test("topics：提议默认每周一 09:00，确认后建 active 课题（revision=1）", () => {
	const { store } = newStore();
	const proposal = propose(store, "  中国利率  未来一年怎么走 ");
	assert.equal(proposal.cron, TOPIC_DEFAULT_CRON);
	assert.equal(proposal.status, "pending");
	assert.equal(proposal.origin, "user");
	assert.equal(proposal.question, "中国利率 未来一年怎么走", "空白归一化");
	assert.ok(Date.parse(proposal.expiresAt) - Date.parse(proposal.createdAt) > 71 * 3_600_000);

	const accepted = store.acceptProposal(proposal.id);
	assert.equal(accepted.ok, true);
	if (!accepted.ok) return;
	assert.equal(accepted.topic.status, "active");
	assert.equal(accepted.topic.revision, 1);
	assert.equal(accepted.topic.findings.length, 0);
	assert.equal(store.getProposal(proposal.id)?.status, "accepted");
});

test("topics：同题查重（空白归一化）返回已有课题 id", () => {
	const { store } = newStore();
	const proposal = propose(store, "美联储 降息");
	const accepted = store.acceptProposal(proposal.id);
	assert.equal(accepted.ok, true);
	const again = store.proposeTopic({
		question: "  美联储   降息 ",
		flavor: "dig",
		origin: "proposal",
	});
	assert.equal(again.ok, false);
	if (again.ok) return;
	assert.equal(again.reason, "exists");
	if (accepted.ok) assert.equal(again.existingTopicId, accepted.topic.id);
});

test("topics：上限 5 个（提议与确认都挡）", () => {
	const { store } = newStore();
	const proposals = Array.from({ length: TOPIC_MAX + 1 }, (_, index) =>
		propose(store, `第 ${index + 1} 个课题`),
	);
	for (const proposal of proposals.slice(0, TOPIC_MAX)) {
		assert.equal(store.acceptProposal(proposal.id).ok, true);
	}
	const sixth = proposals[TOPIC_MAX];
	assert.ok(sixth);
	const over = store.acceptProposal(sixth.id);
	assert.equal(over.ok, false);
	if (!over.ok) assert.equal(over.reason, "limit");

	const extra = store.proposeTopic({
		question: "第六个课题",
		flavor: "watch",
		origin: "proposal",
	});
	assert.equal(extra.ok, false);
	if (!extra.ok) assert.equal(extra.reason, "limit");
});

test("topics：搜索未配置时开不了课题（提议与确认都拒绝）", () => {
	const key = process.env.DEEPSEEK_SEARCH_API_KEY;
	const { store } = newStore();
	const proposal = propose(store, "先建后验");
	delete process.env.DEEPSEEK_SEARCH_API_KEY;
	try {
		const again = store.proposeTopic({
			question: "另一个题",
			flavor: "watch",
			origin: "user",
		});
		assert.equal(again.ok, false);
		if (!again.ok) {
			assert.equal(again.reason, "search_not_configured");
			assert.match(again.message, /模型/);
		}
		const accepted = store.acceptProposal(proposal.id);
		assert.equal(accepted.ok, false);
		if (!accepted.ok) assert.equal(accepted.reason, "search_not_configured");
	} finally {
		process.env.DEEPSEEK_SEARCH_API_KEY = key;
	}
});

test("topics：appendFinding 置 pendingPush、饱和计数、markPushed 一次性", () => {
	const { store } = newStore();
	const proposal = propose(store, "通胀数据");
	const accepted = store.acceptProposal(proposal.id);
	assert.equal(accepted.ok, true);
	if (!accepted.ok) return;
	const id = accepted.topic.id;

	store.appendFinding(id, { summary: "CPI 回落", body: "正文", noNew: false });
	let topic = store.get(id);
	assert.ok(topic);
	assert.equal(topic.findings.length, 1);
	assert.equal(topic.pendingPush, true);
	assert.equal(topic.noNewStreak, 0);
	assert.ok(topic.lastRunAt);

	store.appendFinding(id, { summary: "无变化", body: "正文", noNew: true });
	store.appendFinding(id, { summary: "还是无变化", body: "正文", noNew: true });
	topic = store.get(id);
	assert.ok(topic);
	assert.equal(topic.noNewStreak, 2);

	store.appendFinding(id, { summary: "有新东西", body: "正文", noNew: false });
	assert.equal(store.get(id)?.noNewStreak, 0);

	const drained = store.drainPendingPushes();
	assert.equal(drained.length, 1);
	assert.equal(store.get(id)?.pendingPush, false);
	assert.deepEqual(store.drainPendingPushes(), [], "第二次取不到（每课题每次活跃只报一次）");
});

test("topics：patch 校验 cron / 状态机；close 留原因；digest 只列 active", () => {
	const { store } = newStore();
	const proposal = propose(store, "半导体周期");
	const accepted = store.acceptProposal(proposal.id);
	assert.equal(accepted.ok, true);
	if (!accepted.ok) return;
	const id = accepted.topic.id;

	assert.equal(store.patch(id, { cron: "not a cron" }).ok, false);
	const patched = store.patch(id, { cron: "0 8 * * 3" });
	assert.equal(patched.ok, true);
	if (patched.ok) {
		assert.equal(patched.topic.cron, "0 8 * * 3");
		assert.equal(patched.topic.revision, 2);
	}
	assert.match(store.digestForInjection(), /半导体周期/);

	const paused = store.patch(id, { status: "paused" });
	assert.equal(paused.ok, true);
	assert.equal(store.digestForInjection(), "", "暂停的课题不进清单");
	const resumed = store.patch(id, { status: "active" });
	assert.equal(resumed.ok, true);
	if (resumed.ok) assert.equal(resumed.topic.revision, 4);

	const closed = store.close(id, "不想跟了");
	assert.ok(closed);
	assert.equal(closed?.status, "closed");
	assert.equal(closed?.closeReason, "不想跟了");
	assert.equal(store.digestForInjection(), "");
	assert.equal(store.listActive().length, 0);
});

test("topics：72h 过期提议 → expired，确认返回 expired", () => {
	const path = join(tmpdir(), `lifediary-topics-expired-${randomUUID()}.json`);
	const past = new Date(Date.now() - 86_400_000).toISOString();
	const id = randomUUID();
	writeFileSync(
		path,
		JSON.stringify({
			version: 1,
			topics: [],
			proposals: [
				{
					id,
					question: "老提议",
					flavor: "watch",
					cron: TOPIC_DEFAULT_CRON,
					origin: "user",
					status: "pending",
					createdAt: past,
					expiresAt: past,
				},
			],
		}),
		"utf8",
	);
	const store = new TopicsStore(path);
	assert.equal(store.expireProposals(), 1);
	assert.equal(store.getProposal(id)?.status, "expired");
	const accepted = store.acceptProposal(id);
	assert.equal(accepted.ok, false);
	if (!accepted.ok) assert.equal(accepted.reason, "expired");
});
