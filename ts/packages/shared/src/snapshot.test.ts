import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ChatMessageSchema,
	ChatRequestSchema,
	ChatTranscriptSchema,
	FinishReasonSchema,
	RoleSchema,
	TranscriptMessageSchema,
	createSseDecoder,
	encodeSseEvent,
	type ChatEvent,
} from "./index.ts";

/**
 * 契约快照：shared 是服务端与手机端共用的单文件契约，
 * 任何字段增删改都该在 review 里显形（接口文档 §7「文档滞后即 bug」）。
 *
 * 做法：自己写 shapeOf 按 zod 3.25 的 _def 抽「字段形状」（不是值），
 * 再序列化成 key 排序的确定性 JSON 跟内联快照比 —— 不引入新依赖、不落 .snap 文件。
 */

interface Def {
	typeName?: string;
	values?: readonly string[];
	shape?: () => Record<string, unknown>;
	type?: unknown;
	innerType?: unknown;
}

function shapeOf(schema: unknown): unknown {
	const def = (schema as { _def: Def })._def;
	switch (def.typeName) {
		case "ZodObject": {
			const shape = def.shape!();
			const fields: Record<string, unknown> = {};
			// 字段名排序：序列化结果跨平台稳定。
			for (const key of Object.keys(shape).sort()) fields[key] = shapeOf(shape[key]);
			return { kind: "object", fields };
		}
		case "ZodEnum":
			return { kind: "enum", values: [...(def.values ?? [])] };
		case "ZodString":
			return { kind: "string" };
		case "ZodNumber":
			return { kind: "number" };
		case "ZodBoolean":
			return { kind: "boolean" };
		case "ZodArray":
			return { kind: "array", of: shapeOf(def.type) };
		case "ZodOptional":
			return { kind: "optional", of: shapeOf(def.innerType) };
		case "ZodNullable":
			return { kind: "nullable", of: shapeOf(def.innerType) };
		default:
			// 未知类型以原始 typeName 顶上来：将来 schema 换了种类，快照立刻显形。
			return { kind: def.typeName ?? "unknown" };
	}
}

/** key 排序的确定性序列化：跨平台 / 跨 zod 小版本稳定。 */
function canonical(value: unknown): string {
	if (value === undefined) return "undefined";
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const obj = value as Record<string, unknown>;
		return `{${Object.keys(obj)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

const SCHEMAS = {
	ChatRequestSchema,
	ChatMessageSchema,
	TranscriptMessageSchema,
	ChatTranscriptSchema,
	RoleSchema,
	FinishReasonSchema,
};

/** 内联快照：形状改动在 diff 里一目了然，不另起 .snap 文件。 */
const EXPECTED: Record<string, unknown> = {
	RoleSchema: { kind: "enum", values: ["system", "user", "assistant"] },
	FinishReasonSchema: { kind: "enum", values: ["stop", "length", "aborted", "error"] },
	ChatMessageSchema: {
		kind: "object",
		fields: {
			content: { kind: "string" },
			role: { kind: "enum", values: ["system", "user", "assistant"] },
		},
	},
	TranscriptMessageSchema: {
		kind: "object",
		fields: {
			at: { kind: "number" },
			role: { kind: "enum", values: ["user", "assistant"] },
			text: { kind: "string" },
		},
	},
	ChatTranscriptSchema: {
		kind: "object",
		fields: {
			conversationId: { kind: "string" },
			messages: {
				kind: "array",
				of: {
					kind: "object",
					fields: {
						at: { kind: "number" },
						role: { kind: "enum", values: ["user", "assistant"] },
						text: { kind: "string" },
					},
				},
			},
		},
	},
	ChatRequestSchema: {
		kind: "object",
		fields: {
			conversationId: { kind: "optional", of: { kind: "string" } },
			messages: {
				kind: "array",
				of: {
					kind: "object",
					fields: {
						content: { kind: "string" },
						role: { kind: "enum", values: ["system", "user", "assistant"] },
					},
				},
			},
			requestId: { kind: "optional", of: { kind: "string" } },
		},
	},
};

// ===== 2.1 字段形状快照 =====

test("契约字段形状快照：六个 schema 的形状与内联快照一致", () => {
	for (const [name, schema] of Object.entries(SCHEMAS)) {
		assert.equal(
			canonical(shapeOf(schema)),
			canonical(EXPECTED[name]),
			`${name} 字段形状变了（加/删/改字段需过 review）`,
		);
	}
});

// ===== 2.2 SSE 编解码行为回归 =====

test("encodeSseEvent 只写 data 行、不写 event: 行", () => {
	assert.equal(
		encodeSseEvent({ type: "delta", text: "hi" }),
		"data: {\"type\":\"delta\",\"text\":\"hi\"}\n\n",
	);
});

test("createSseDecoder：帧被逐字符切分也能完整解出", () => {
	const decoder = createSseDecoder();
	const frame = encodeSseEvent({ type: "delta", text: "你好" });
	const got: ChatEvent[] = [];
	for (const ch of frame) got.push(...decoder.push(ch));
	assert.deepEqual(got, [{ type: "delta", text: "你好" }]);
});

test("createSseDecoder：两个事件粘在一个 chunk 里能都解出", () => {
	const decoder = createSseDecoder();
	const chunk =
		encodeSseEvent({ type: "delta", text: "a" }) +
		encodeSseEvent({ type: "done", id: "m1", finishReason: "stop" });
	assert.deepEqual(decoder.push(chunk), [
		{ type: "delta", text: "a" },
		{ type: "done", id: "m1", finishReason: "stop" },
	]);
});

test("createSseDecoder：畸形 JSON 帧被跳过且后续帧不受影响", () => {
	const decoder = createSseDecoder();
	const chunk = "data: {不是 JSON}\n\n" + encodeSseEvent({ type: "delta", text: "ok" });
	assert.deepEqual(decoder.push(chunk), [{ type: "delta", text: "ok" }]);
});

// ===== 2.3 ChatEvent 联合成员清单 =====

type ChatEventType = ChatEvent["type"];
const ALL_EVENT_TYPES = [
	"start",
	"delta",
	"thinking",
	"progress",
	"tool",
	"done",
	"error",
	"delegate",
	"attention",
	"approval",
] as const satisfies readonly ChatEventType[];

type Listed = (typeof ALL_EVENT_TYPES)[number];
type AssertNever<T extends never> = true;
// 正向：清单不能拼错；反向：不能漏成员。少写一个，Exclude 不是 never → typecheck 直接红。
type _NoTypo = AssertNever<Exclude<Listed, ChatEventType>>;
type _NoMissing = AssertNever<Exclude<ChatEventType, Listed>>;

const SAMPLES: ChatEvent[] = [
	{ type: "start", id: "m1", conversationId: "c1" },
	{ type: "delta", text: "hi" },
	{ type: "thinking", text: "..." },
	{ type: "progress", phase: "thinking" },
	{ type: "tool", name: "read", status: "start" },
	{ type: "done", id: "m1", finishReason: "stop" },
	{ type: "error", message: "boom" },
	{ type: "delegate", ticketId: "t1", domain: "d", phase: "running", done: 0, total: 1, current: "x" },
	{ type: "attention", ticketId: "t1", domain: "d", kind: "need_input", question: "q?" },
	{ type: "approval", callId: "a1", tool: "bash", args: "{}", deadlineAt: "2026-11-04T00:00:00Z" },
];

test("ChatEvent 十个成员都有代表性样例，编码回读后 type 都在清单里", () => {
	const known = new Set<string>(ALL_EVENT_TYPES);
	for (const sample of SAMPLES) {
		const encoded = encodeSseEvent(sample);
		const parsed = JSON.parse(encoded.slice("data: ".length).trim()) as { type: string };
		assert.equal(parsed.type, sample.type);
		assert.ok(known.has(parsed.type), `未知事件类型 ${parsed.type}`);
	}
	assert.equal(SAMPLES.length, ALL_EVENT_TYPES.length, "样例数要跟成员清单对齐");
});
