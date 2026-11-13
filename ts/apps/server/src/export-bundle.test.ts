import assert from "node:assert/strict";
import { test } from "node:test";
import { inflateRawSync } from "node:zlib";
import {
	composeBundle,
	exportStamp,
	isoOrNull,
	localStamp,
	parseExportImages,
	parseExportParts,
	renderMessagesJson,
	renderReadme,
	renderTranscriptMarkdown,
	slugifyTitle,
	type BundlePart,
	EXPORT_MESSAGE_LIMIT,
} from "./export-bundle.ts";
import type { ChatIndexEntry } from "./agent.ts";
import type { ExportMessage } from "./export-bundle.ts";

/**
 * 导出包的结构单测：钉的是"文件怎么组织、清单长什么样"，
 * 不依赖数据库——真实采集由 http 探针端到端跑。
 */

const ENTRY: ChatIndexEntry = {
	conversationId: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
	createdAt: Date.parse("2026-11-03T01:12:00Z"),
	lastAt: Date.parse("2026-11-04T14:10:00Z"),
	firstText: "毕业设计答辩怎么准备",
	title: "毕业设计答辩怎么准备",
	turns: 3,
	chatKind: "chief",
	pinned: true,
	archived: true,
	archivedAt: Date.parse("2026-11-12T02:00:00Z"),
	projectId: "p-1",
	projectName: "lifediary",
};

const MESSAGES: ExportMessage[] = [
	{ role: "user", at: isoOrNull(ENTRY.createdAt), text: "帮我看看答辩 PPT", id: "uuid-user" },
	{
		role: "assistant",
		at: isoOrNull(ENTRY.lastAt),
		text: "先讲清楚问题。",
		images: [{ mimeType: "image/png", path: "images/0001-abcdef12.png", bytes: 123, sha256: "0".repeat(64) }],
		steps: [{ name: "read", ok: true, ms: 1200 }],
		workMs: 90_000,
	},
];

test("parts 解析：缺省全选、未知/空/重复都是 null", () => {
	assert.deepEqual(parseExportParts(undefined), [
		"conversations",
		"memory",
		"library",
		"team",
		"config",
	]);
	assert.deepEqual(parseExportParts("memory,config"), ["memory", "config"]);
	assert.equal(parseExportParts(""), null);
	assert.equal(parseExportParts("memory,"), null);
	assert.equal(parseExportParts("nope"), null);
	assert.equal(parseExportParts("memory,memory"), null);
});

test("images 解析：只认 0 / 1，缺省带图", () => {
	assert.equal(parseExportImages(undefined), true);
	assert.equal(parseExportImages("1"), true);
	assert.equal(parseExportImages("0"), false);
	assert.equal(parseExportImages("true"), null);
});

test("标题 slug：去非法字符、压空格、保留中文、有兜底", () => {
	assert.equal(slugifyTitle('毕业/设计:答辩?*"<>|准备'), "毕业设计答辩准备");
	assert.equal(slugifyTitle("  多  空格   "), "多-空格");
	assert.equal(Array.from(slugifyTitle("🎓".repeat(50))).length, 40, "按 code point 截，不把 emoji 劈两半");
	assert.equal(slugifyTitle("///"), "chat");
});

test("时间口径：JSON 用 ISO，正文用本地时间", () => {
	assert.equal(isoOrNull(0), "1970-01-01T00:00:00.000Z");
	assert.equal(isoOrNull(null), null);
	assert.match(localStamp(ENTRY.createdAt), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
	assert.match(exportStamp(new Date(2026, 10, 13, 14, 30)), /^2026-11-13-1430$/);
});

test("messages.json：自包含、带归档与项目、截断标记", () => {
	const json = JSON.parse(renderMessagesJson(ENTRY, "2026-11-03-毕业设计答辩怎么准备-0f1e2d3c", MESSAGES, true));
	assert.equal(json.id, ENTRY.conversationId);
	assert.equal(json.title, "毕业设计答辩怎么准备");
	assert.equal(json.archived, true);
	assert.equal(json.project.name, "lifediary");
	assert.equal(json.truncated, true);
	assert.equal(json.messages[1].images[0].path, "images/0001-abcdef12.png");
	assert.equal(json.messages[1].steps[0].name, "read");
	assert.equal(json.messages[0].at, "2026-11-03T01:12:00.000Z");
});

test("transcript.md：正文 + 图片相对路径 + 步骤只留名字", () => {
	const markdown = renderTranscriptMarkdown(ENTRY, MESSAGES, true);
	assert.match(markdown, /^# 毕业设计答辩怎么准备/);
	assert.match(markdown, /已归档/);
	assert.match(markdown, /项目：lifediary/);
	assert.match(markdown, /只保留最近 500 条/);
	assert.match(markdown, /!\[图片\]\(images\/0001-abcdef12\.png\)/);
	assert.match(markdown, /> 工具：read 1\.2s/);
	assert.doesNotMatch(markdown, /先讲清楚问题。.*\n.*先讲清楚问题。/, "正文不该重复");
});

test("manifest + README：逐块状态、上限、刻意不带的东西都写出来", () => {
	const parts: BundlePart[] = [
		{
			id: "conversations",
			label: "会话与消息",
			status: "ok",
			files: [{ path: "conversations/index.json", text: "{}" }],
			counts: { conversations: 3, messages: 120, truncatedChats: 1 },
			limits: { messagesPerChat: EXPORT_MESSAGE_LIMIT, images: true },
			notes: [],
		},
		{
			id: "team",
			label: "团队（执事/群组）",
			status: "failed",
			files: [],
			counts: {},
			notes: [],
			error: "数据库被占用",
		},
	];
	const readme = renderReadme(parts, {
		exportedAt: new Date(2026, 10, 13, 14, 30),
		files: 4,
		bytes: 1024,
		images: true,
	});
	assert.match(readme, /导出时间：2026-11-13 14:30:00/);
	assert.match(readme, /\| 会话与消息 \| 已导出 \| 1 \| 120 \|/);
	assert.match(readme, /失败原因：数据库被占用/);
	assert.match(readme, /任务专线会话/);
	assert.match(readme, /不是可一键恢复的备份格式/);

	const bundle = composeBundle(parts, new Date(2026, 10, 13, 14, 30));
	const manifest = bundle.manifest as {
		format: string;
		formatVersion: number;
		parts: { id: string; status: string; files: number }[];
		totals: { files: number };
		limits: Record<string, number>;
	};
	assert.equal(manifest.format, "lifediary-export");
	assert.equal(manifest.formatVersion, 1);
	assert.equal(manifest.parts[0]!.status, "ok");
	assert.equal(manifest.parts[1]!.status, "failed");
	assert.equal(manifest.totals.files, 1 + 2); // 1 块内文件 + README + manifest
	assert.equal(manifest.limits.messagesPerChat, 500);
	assert.equal(bundle.partial, true);
	assert.equal(bundle.fileName, "selenite-export-2026-11-13-1430.zip");
	assert.notEqual(bundle.buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])), -1);
});

test("zip 里每条路径都带根目录前缀，README/manifest 在根上", () => {
	const parts: BundlePart[] = [
		{
			id: "memory",
			label: "记忆",
			status: "ok",
			files: [{ path: "memory/records.jsonl", text: '{"id":"a"}\n' }],
			counts: { records: 1 },
			notes: [],
		},
	];
	const bundle = composeBundle(parts, new Date(2026, 10, 13, 14, 30));
	const names = centralNames(bundle.buffer);
	assert.deepEqual(
		names.sort(),
		[
			"selenite-export-2026-11-13-1430/README.md",
			"selenite-export-2026-11-13-1430/manifest.json",
			"selenite-export-2026-11-13-1430/memory/records.jsonl",
		].sort(),
	);
	assert.equal(readText(bundle.buffer, "selenite-export-2026-11-13-1430/memory/records.jsonl"), '{"id":"a"}\n');
});

/** 读中央目录里的名字（解包只为了断言路径，压缩流在 zip.test.ts 里验过） */
function centralNames(buffer: Buffer): string[] {
	const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
	const count = buffer.readUInt16LE(eocd + 10);
	let cursor = buffer.readUInt32LE(eocd + 16);
	const names: string[] = [];
	for (let index = 0; index < count; index += 1) {
		const nameLength = buffer.readUInt16LE(cursor + 28);
		const extraLength = buffer.readUInt16LE(cursor + 30);
		const commentLength = buffer.readUInt16LE(cursor + 32);
		names.push(buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8"));
		cursor += 46 + nameLength + extraLength + commentLength;
	}
	return names;
}

function readText(buffer: Buffer, name: string): string {
	const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
	const count = buffer.readUInt16LE(eocd + 10);
	let cursor = buffer.readUInt32LE(eocd + 16);
	for (let index = 0; index < count; index += 1) {
		const nameLength = buffer.readUInt16LE(cursor + 28);
		const extraLength = buffer.readUInt16LE(cursor + 30);
		const commentLength = buffer.readUInt16LE(cursor + 32);
		const method = buffer.readUInt16LE(cursor + 10);
		const compressed = buffer.readUInt32LE(cursor + 20);
		const localOffset = buffer.readUInt32LE(cursor + 42);
		const entryName = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
		if (entryName === name) {
			const localNameLength = buffer.readUInt16LE(localOffset + 26);
			const localExtraLength = buffer.readUInt16LE(localOffset + 28);
			const start = localOffset + 30 + localNameLength + localExtraLength;
			const body = buffer.subarray(start, start + compressed);
			return (method === 8 ? inflateRawSync(body) : body).toString("utf8");
		}
		cursor += 46 + nameLength + extraLength + commentLength;
	}
	throw new Error(`包里没有 ${name}`);
}
