import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 归档模块（2026-11-12）服务端数据层单测。
 *
 * 覆盖：
 *   1. chat-meta 旧键 `hidden` → 新键 `archived` / `archivedAt` 的读兼容与写迁移；
 *   2. 归档 / 单条恢复 / 全部恢复（含重复归档更新时间、unarchive 幂等）；
 *   3. 项目连带归档的纯过滤（只认 projectId，跳过 task- / partner-，缺映射跳过）；
 *   4. 回滚开关 `PROJECT_ARCHIVE_CHATS`；
 *   5. 项目归档端点的响应形状（`archivedChats` / restore 不恢复会话），开关关闭时不拉 durable。
 *
 * 没覆盖：`listChats` / `listArchivedChats` 的 durable 读路径（要真起 harness），
 * 由 batch C 的 http 探针做真服务覆盖；这里只钉数据层与纯函数。
 */

const root = mkdtempSync(join(tmpdir(), "lifediary-archive-"));
const metaPath = join(root, "chat-meta.json");
// CHAT_META_PATH 在 session.ts 模块加载时读取，所以必须先设 env 再动态 import。
process.env.AGENT_CHAT_META_PATH = metaPath;
// 本文件不测连带归档的真 durable 路径；默认关掉，避免端点测试意外拉起 harness。
process.env.PROJECT_ARCHIVE_CHATS = "false";
const session = await import("./agent/session.ts");

after(() => {
	rmSync(root, { recursive: true, force: true });
});

function writeMeta(value: unknown): void {
	writeFileSync(metaPath, JSON.stringify(value, null, 2), "utf8");
}

function readMeta(): Record<string, unknown> {
	return JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
}

test("chat-meta：旧键 hidden 能读；首次写入落 archived / archivedAt 且不再写 hidden", () => {
	writeMeta({
		titles: { "legacy-1": "旧标题" },
		hidden: ["legacy-1", "legacy-2"],
		pins: ["legacy-2"],
	});

	assert.deepEqual(session.chatMetaSummary(), { archived: 2 }, "旧 hidden 应被读成归档");

	session.unarchiveChat("legacy-1");
	const meta = readMeta();
	assert.deepEqual(meta.archived, ["legacy-2"], "恢复只移除目标 id");
	assert.deepEqual(meta.archivedAt, {}, "旧数据没有归档时间");
	assert.equal("hidden" in meta, false, "写入新键后不能再回写旧键");
	assert.deepEqual(meta.titles, { "legacy-1": "旧标题" }, "标题不丢");
	assert.deepEqual(meta.pins, ["legacy-2"], "置顶不丢");
});

test("archive / unarchive / restore：重复归档更新时间、unarchive 幂等、全部恢复计数", () => {
	writeMeta({});

	session.archiveChat("chat-a", 100);
	session.archiveChat("chat-b", 200);
	let meta = readMeta();
	assert.deepEqual(meta.archived, ["chat-a", "chat-b"]);
	assert.deepEqual(meta.archivedAt, { "chat-a": 100, "chat-b": 200 });
	assert.deepEqual(session.chatMetaSummary(), { archived: 2 });

	session.archiveChat("chat-a", 300);
	meta = readMeta();
	assert.deepEqual(meta.archived, ["chat-a", "chat-b"], "重复归档不产生重复条目");
	assert.equal((meta.archivedAt as Record<string, number>)["chat-a"], 300, "重复归档更新时间");

	session.unarchiveChat("chat-a");
	session.unarchiveChat("chat-a");
	meta = readMeta();
	assert.deepEqual(meta.archived, ["chat-b"]);
	assert.deepEqual(meta.archivedAt, { "chat-b": 200 });

	assert.equal(session.restoreArchivedChats(), 1);
	meta = readMeta();
	assert.deepEqual(meta.archived, []);
	assert.deepEqual(meta.archivedAt, {});
	assert.deepEqual(session.chatMetaSummary(), { archived: 0 });
	assert.equal(session.restoreArchivedChats(), 0, "没有归档时全部恢复返回 0");

	// 兼容别名（旧调用方仍可用）
	assert.equal(session.hideChat, session.archiveChat);
	assert.equal(session.restoreChats, session.restoreArchivedChats);
});

test("chat-meta：文件不存在按空处理", () => {
	rmSync(metaPath, { force: true });
	assert.deepEqual(session.chatMetaSummary(), { archived: 0 });
	session.archiveChat("only-one", 1);
	assert.deepEqual(session.chatMetaSummary(), { archived: 1 });
});

test("归档清单映射：按 chat-meta 顺序反查，不经过活跃清单的 limit 截断", () => {
	// 300 条归档（远超 listChats 常见 limit）：纯映射必须全部保留；旧数据没有 archivedAt
	// 也照样能反查到（archivedAt 的回退在 listArchivedChats 里做）。
	const archivedIds = Array.from({ length: 300 }, (_, index) => `chat-${index}`);
	const chatsByExternal = Object.fromEntries(
		archivedIds.map((id, index) => [id, index + 1]),
	);
	const pairs = session.archivedChatPairs(archivedIds, chatsByExternal);
	assert.equal(pairs.length, 300, "不能按活跃清单截断");
	assert.equal(pairs[0]?.conversationId, "chat-0", "保持 chat-meta 的归档顺序");
	assert.equal(pairs[299]?.conversationId, "chat-299");
	assert.deepEqual(session.archivedChatPairs(["missing", "chat-1"], { "chat-1": 7 }), [
		{ conversationId: "chat-1", internalId: 7 },
	]);
});

test("项目连带归档的纯过滤：只认 projectId，跳过 task- / partner-，缺映射跳过", () => {
	const chatProjects = {
		"10": "project-1",
		"11": "project-1",
		"12": "project-1", // task- 前缀
		"13": "project-2", // 别的项目
		"14": "project-1", // partner- 前缀
		"15": "project-1", // 没有 external 映射
	};
	const chatsByExternal = {
		"chat-a": 10,
		"chat-b": 11,
		"task-T1": 12,
		"chat-c": 13,
		"partner-x": 14,
	};

	assert.deepEqual(
		session.projectChatExternalIds(chatProjects, chatsByExternal, "project-1"),
		["chat-a", "chat-b"],
	);
	assert.deepEqual(session.projectChatExternalIds(chatProjects, chatsByExternal, "project-2"), [
		"chat-c",
	]);
	assert.deepEqual(session.projectChatExternalIds({}, {}, "project-1"), [], "没有归属映射不猜");
	assert.deepEqual(
		session.projectChatExternalIds({ "99": "project-1" }, {}, "project-1"),
		[],
		"没有对外 id 的残留内部 id 跳过",
	);
});

test("回滚开关 PROJECT_ARCHIVE_CHATS：缺省开，只有 false 关", async () => {
	const { projectArchiveChatsEnabled } = await import("./projects.ts");
	const saved = process.env.PROJECT_ARCHIVE_CHATS;
	try {
		delete process.env.PROJECT_ARCHIVE_CHATS;
		assert.equal(projectArchiveChatsEnabled(), true, "缺省开");
		for (const value of ["true", "1", ""]) {
			process.env.PROJECT_ARCHIVE_CHATS = value;
			assert.equal(projectArchiveChatsEnabled(), true, value);
		}
		for (const value of ["false", "FALSE", " false "]) {
			process.env.PROJECT_ARCHIVE_CHATS = value;
			assert.equal(projectArchiveChatsEnabled(), false, value);
		}
	} finally {
		if (saved === undefined) delete process.env.PROJECT_ARCHIVE_CHATS;
		else process.env.PROJECT_ARCHIVE_CHATS = saved;
	}
});

test("项目归档端点：/archive 主入口与 /remove 别名带 archivedChats，restore 不动会话", async () => {
	const projects = await import("./projects.ts");
	const { Hono } = await import("hono");
	const savedDb = process.env.PROJECTS_DB_PATH;
	const savedFlag = process.env.PROJECT_ARCHIVE_CHATS;
	process.env.PROJECTS_DB_PATH = join(root, "projects.sqlite");
	// 端点测试不拉 durable：开关关掉时归档只改登记位，archivedChats 必须是 0。
	process.env.PROJECT_ARCHIVE_CHATS = "false";
	const workspace = join(root, "ws");
	let store: InstanceType<typeof projects.ProjectsStore> | null = null;
	try {
		mkdirSync(workspace, { recursive: true });
		store = projects.projectsStore();
		store.setWorkspace(workspace);
		const proposal = store.proposeProject("归档项目", "demo");
		const project = store.confirmProposal(proposal.id);

		const app = new Hono();
		projects.mountProjects(app);

		const archived = await app.request(`/api/v1/projects/${project.id}/archive`, {
			method: "POST",
		});
		assert.equal(archived.status, 200);
		const archivedBody = (await archived.json()) as {
			ok: boolean;
			project: { archived: boolean };
			archivedChats: number;
		};
		assert.equal(archivedBody.ok, true);
		assert.equal(archivedBody.project.archived, true);
		assert.equal(archivedBody.archivedChats, 0, "开关关时不连带归档");

		const removed = await app.request(`/api/v1/projects/${project.id}/remove`, {
			method: "POST",
		});
		const removedBody = (await removed.json()) as {
			ok: boolean;
			archivedChats: number;
		};
		assert.equal(removedBody.ok, true, "/remove 是 /archive 的兼容别名");
		assert.equal(removedBody.archivedChats, 0);

		const restored = await app.request(`/api/v1/projects/${project.id}/restore`, {
			method: "POST",
		});
		const restoredBody = (await restored.json()) as {
			ok: boolean;
			project: { archived: boolean };
			archivedChats?: number;
		};
		assert.equal(restoredBody.ok, true);
		assert.equal(restoredBody.project.archived, false);
		assert.equal("archivedChats" in restoredBody, false, "恢复只回项目登记，不碰会话");
	} finally {
		store?.close();
		if (savedDb === undefined) delete process.env.PROJECTS_DB_PATH;
		else process.env.PROJECTS_DB_PATH = savedDb;
		if (savedFlag === undefined) delete process.env.PROJECT_ARCHIVE_CHATS;
		else process.env.PROJECT_ARCHIVE_CHATS = savedFlag;
	}
});
