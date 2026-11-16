import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	appendPersonaExport,
	appendPersonaExportAsync,
	personaExportEnabled,
	type PersonaExportChat,
	type PersonaExportDeps,
} from "./persona-export.ts";

/**
 * persona 导出器（2026-11-09 接入批二）单测。
 *
 * 全部落临时目录（不碰真实 `.data`），会话过滤与开关走注入替身
 * （不打开 partners.sqlite）；行格式以方案文档「契约：导出文件行格式」为准。
 */

const ON = { PERSONA_EXPORT_ENABLED: "true" };
const CHAT: PersonaExportChat = { internalId: 7, externalId: "11111111-2222-3333-4444-555555555555" };

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "lifediary-persona-export-"));
}

function depsOf(dir: string, over: PersonaExportDeps = {}): PersonaExportDeps {
	return {
		env: ON,
		dir,
		now: () => new Date(2026, 10, 9, 20, 15, 3),
		turnId: "turn-1",
		isGroupSession: () => false,
		isPartnerSession: () => false,
		...over,
	};
}

function linesOf(path: string): string[] {
	return readFileSync(path, "utf8").split("\n").filter(Boolean);
}

/** 等异步落盘（同步门面是 fire-and-forget，测试里只能等文件出现）。 */
async function waitForFile(path: string): Promise<void> {
	for (let i = 0; i < 100; i += 1) {
		if (existsSync(path)) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail(`等不到导出文件：${path}`);
}

test("personaExportEnabled：默认开（2026-11-16 翻案），显式 false/0/off 才关", () => {
	assert.equal(personaExportEnabled({}), true);
	assert.equal(personaExportEnabled({ PERSONA_EXPORT_ENABLED: "" }), true);
	assert.equal(personaExportEnabled({ PERSONA_EXPORT_ENABLED: "false" }), false);
	assert.equal(personaExportEnabled({ PERSONA_EXPORT_ENABLED: "0" }), false);
	assert.equal(personaExportEnabled({ PERSONA_EXPORT_ENABLED: "off" }), false);
	assert.equal(personaExportEnabled({ PERSONA_EXPORT_ENABLED: " TRUE " }), true);
	assert.equal(personaExportEnabled({ PERSONA_EXPORT_ENABLED: "1" }), true);
	assert.equal(personaExportEnabled({ PERSONA_EXPORT_ENABLED: "on" }), true);
});

test("正常一轮：一行、JSON 可解析、字段齐、按月落文件", async () => {
	const dir = tempDir();
	try {
		const written = await appendPersonaExportAsync(
			CHAT,
			[
				{ role: "assistant", content: "上一轮的回答" },
				{ role: "user", content: "今天想整理一下旧照片" },
				{ role: "assistant", content: "好，先从哪一年开始？" },
			],
			"test-model",
			depsOf(dir),
		);
		assert.equal(written, 1);
		assert.deepEqual(readdirSync(dir), ["2026-11.jsonl"]);

		const rows = linesOf(join(dir, "2026-11.jsonl"));
		assert.equal(rows.length, 1);
		const row = JSON.parse(rows[0]!) as Record<string, unknown>;
		assert.deepEqual(Object.keys(row).sort(), [
			"assistantText",
			"conversationId",
			"model",
			"ts",
			"turnId",
			"userText",
			"v",
		]);
		assert.equal(row.v, 1);
		assert.equal(row.conversationId, CHAT.externalId);
		assert.equal(row.turnId, "turn-1");
		assert.equal(row.userText, "今天想整理一下旧照片");
		assert.equal(row.assistantText, "好，先从哪一年开始？");
		assert.equal(row.model, "test-model");
		assert.match(String(row.ts), /^2026-11-09T20:15:03[+-]\d{2}:\d{2}$/);
		assert.ok(!Number.isNaN(Date.parse(String(row.ts))), "ts 必须可解析");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("assistant 取本轮最终回复：plain 只有 user 时用 reply 懒读取补齐", async () => {
	const dir = tempDir();
	try {
		const written = await appendPersonaExportAsync(
			CHAT,
			[{ role: "user", content: "帮我看看这个" }],
			"test-model",
			depsOf(dir, { reply: async () => "这是最终回复" }),
		);
		assert.equal(written, 1);
		const row = JSON.parse(linesOf(join(dir, "2026-11.jsonl"))[0]!) as Record<string, unknown>;
		assert.equal(row.userText, "帮我看看这个");
		assert.equal(row.assistantText, "这是最终回复");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("task-/群/执事会话都不导出", async () => {
	const cases: { name: string; chat: PersonaExportChat; over: PersonaExportDeps }[] = [
		{ name: "task-", chat: { ...CHAT, externalId: "task-abc123" }, over: {} },
		{ name: "群", chat: CHAT, over: { isGroupSession: () => true } },
		{ name: "执事", chat: CHAT, over: { isPartnerSession: () => true } },
	];
	for (const item of cases) {
		const dir = tempDir();
		try {
			const written = await appendPersonaExportAsync(
				item.chat,
				[{ role: "user", content: "不该被写进去" }],
				"m",
				depsOf(dir, item.over),
			);
			assert.equal(written, 0, `${item.name}会话不该导出`);
			assert.deepEqual(readdirSync(dir), [], `${item.name}会话不该建文件`);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

test("全空轮不写（至少一个字段非空）", async () => {
	const dir = tempDir();
	try {
		const written = await appendPersonaExportAsync(
			CHAT,
			[
				{ role: "user", content: "   " },
				{ role: "assistant", content: "" },
			],
			"m",
			depsOf(dir),
		);
		assert.equal(written, 0);
		assert.deepEqual(readdirSync(dir), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("开关默认开就写（2026-11-16 翻案）；显式 false 不写（同步门面返回值同口径）", async () => {
	const plain = [{ role: "user", content: "一句话" }];
	const offDir = tempDir();
	const onDir = tempDir();
	const defDir = tempDir();
	try {
		assert.equal(appendPersonaExport(CHAT, plain, "m", depsOf(offDir, { env: { PERSONA_EXPORT_ENABLED: "false" } })), 0);
		assert.equal(await appendPersonaExportAsync(CHAT, plain, "m", depsOf(offDir, { env: { PERSONA_EXPORT_ENABLED: "false" } })), 0);
		assert.equal(appendPersonaExport(CHAT, plain, "m", depsOf(onDir)), 1);
		// 同步门面只排队，写盘异步；等它落一行再断言。
		await waitForFile(join(onDir, "2026-11.jsonl"));
		assert.equal(linesOf(join(onDir, "2026-11.jsonl")).length, 1);
		// 默认开：空 env（什么都不配）也写一行。
		assert.equal(await appendPersonaExportAsync(CHAT, plain, "m", depsOf(defDir, { env: {} })), 1);
		assert.equal(linesOf(join(defDir, "2026-11.jsonl")).length, 1);
		assert.deepEqual(readdirSync(offDir), [], "显式关不该建文件");
	} finally {
		rmSync(offDir, { recursive: true, force: true });
		rmSync(onDir, { recursive: true, force: true });
		rmSync(defDir, { recursive: true, force: true });
	}
});

test("同月两轮追加两行；跨月分两个文件", async () => {
	const dir = tempDir();
	try {
		await appendPersonaExportAsync(
			CHAT,
			[{ role: "user", content: "第一轮" }, { role: "assistant", content: "回复一" }],
			"m",
			depsOf(dir, { turnId: "turn-1" }),
		);
		await appendPersonaExportAsync(
			CHAT,
			[{ role: "user", content: "第二轮" }, { role: "assistant", content: "回复二" }],
			"m",
			depsOf(dir, { turnId: "turn-2" }),
		);
		assert.equal(linesOf(join(dir, "2026-11.jsonl")).length, 2);

		await appendPersonaExportAsync(
			CHAT,
			[{ role: "user", content: "跨月" }, { role: "assistant", content: "回复三" }],
			"m",
			depsOf(dir, { turnId: "turn-3", now: () => new Date(2026, 11, 1, 9, 0, 0) }),
		);
		assert.deepEqual(readdirSync(dir).sort(), ["2026-11.jsonl", "2026-12.jsonl"]);
		assert.equal(linesOf(join(dir, "2026-11.jsonl")).length, 2);
		assert.equal(linesOf(join(dir, "2026-12.jsonl")).length, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("turnId 缺省回落 conversationId:ts（可重复解析）", async () => {
	const dir = tempDir();
	try {
		await appendPersonaExportAsync(
			CHAT,
			[{ role: "user", content: "一句话" }],
			"m",
			depsOf(dir, { turnId: undefined, reply: async () => "" }),
		);
		const row = JSON.parse(linesOf(join(dir, "2026-11.jsonl"))[0]!) as Record<string, unknown>;
		assert.equal(row.turnId, `${CHAT.externalId}:${String(row.ts)}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
