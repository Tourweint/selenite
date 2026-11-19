import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ChatMessageSchema,
	ChatRequestSchema,
	ChatTranscriptSchema,
	FinishReasonSchema,
	RoleSchema,
	TranscriptMessageSchema,
	TranscriptStepSchema,
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
	/** ZodUnion / ZodDiscriminatedUnion 的成员 */
	options?: readonly unknown[];
	/** ZodLiteral 的字面值 */
	value?: unknown;
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
		case "ZodLiteral":
			return { kind: "literal", value: def.value };
		case "ZodArray":
			return { kind: "array", of: shapeOf(def.type) };
		case "ZodOptional":
			return { kind: "optional", of: shapeOf(def.innerType) };
		case "ZodNullable":
			return { kind: "nullable", of: shapeOf(def.innerType) };
		case "ZodUnion":
		case "ZodDiscriminatedUnion":
			return { kind: "union", of: (def.options ?? []).map(shapeOf) };
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
	TranscriptStepSchema,
	ChatTranscriptSchema,
	RoleSchema,
	FinishReasonSchema,
};

/** 步骤形状被两处引用（TranscriptStep / messages[].steps），抽出来免得改一处漏一处。 */
const STEP_SHAPE = {
	kind: "object",
	fields: {
		args: { kind: "optional", of: { kind: "string" } },
		diff: { kind: "optional", of: { kind: "string" } },
		// 「说」步渲染档（2026-11-10 批 32）：md = output 按正文渲染，缺省 = 工具输出 pre
		format: { kind: "optional", of: { kind: "literal", value: "md" } },
		label: { kind: "optional", of: { kind: "string" } },
		ms: { kind: "optional", of: { kind: "number" } },
		name: { kind: "string" },
		ok: { kind: "boolean" },
		output: { kind: "optional", of: { kind: "string" } },
	},
};

/** 上行内容分段（2026-11-08 扫尾批 4a）：text | image，形状对齐 pi-ai；
 *  2026-11-13 附件走路径增加 file（只带路径，不带内容）。 */
const PART_SHAPE = {
	kind: "union",
	of: [
		{
			kind: "object",
			fields: {
				text: { kind: "string" },
				type: { kind: "literal", value: "text" },
			},
		},
		{
			kind: "object",
			fields: {
				data: { kind: "string" },
				mimeType: { kind: "string" },
				type: { kind: "literal", value: "image" },
			},
		},
		{
			kind: "object",
			fields: {
				bytes: { kind: "optional", of: { kind: "number" } },
				mimeType: { kind: "optional", of: { kind: "string" } },
				name: { kind: "string" },
				path: { kind: "string" },
				type: { kind: "literal", value: "file" },
			},
		},
	],
};

/** content 的 union：老客户端纯字符串 / 新客户端分段数组。 */
const CONTENT_SHAPE = {
	kind: "union",
	of: [{ kind: "string" }, { kind: "array", of: PART_SHAPE }],
};

/** 回读消息形状被 TranscriptMessage / ChatTranscript.messages 两处引用。 */
const MESSAGE_SHAPE = {
	kind: "object",
	fields: {
		at: { kind: "number" },
		// 2026-11-08 4a：可寻址 messageId（uuid 形状，不是内部条目 id）+ 用户消息图片
		id: { kind: "optional", of: { kind: "string" } },
		images: {
			kind: "optional",
			of: {
				kind: "array",
				of: {
					kind: "object",
					fields: { data: { kind: "string" }, mimeType: { kind: "string" } },
				},
			},
		},
		// 2026-11-13 附件走路径：用户消息带的文件（只有路径，没有内容）
		files: {
			kind: "optional",
			of: {
				kind: "array",
				of: {
					kind: "object",
					fields: {
						bytes: { kind: "optional", of: { kind: "number" } },
						mimeType: { kind: "optional", of: { kind: "string" } },
						name: { kind: "string" },
						path: { kind: "string" },
					},
				},
			},
		},
		role: { kind: "enum", values: ["user", "assistant"] },
		steps: { kind: "optional", of: { kind: "array", of: STEP_SHAPE } },
		text: { kind: "string" },
		// 2026-11-15 作者标记：非主人来源的 user 消息带作者（结构与正文分离）
		author: {
			kind: "optional",
			of: {
				kind: "object",
				fields: {
					kind: { kind: "enum", values: ["partner"] },
					id: { kind: "string" },
					name: { kind: "string" },
					domain: { kind: "optional", of: { kind: "string" } },
					hop: { kind: "optional", of: { kind: "number" } },
				},
			},
		},
		workMs: { kind: "optional", of: { kind: "number" } },
		// 2026-11-17 消息时刻：assistant 的收尾时间（at 是请求开始）
		endedAt: { kind: "optional", of: { kind: "number" } },
	},
};

/** 内联快照：形状改动在 diff 里一目了然，不另起 .snap 文件。 */
const EXPECTED: Record<string, unknown> = {
	TranscriptStepSchema: STEP_SHAPE,
	RoleSchema: { kind: "enum", values: ["system", "user", "assistant"] },
	FinishReasonSchema: { kind: "enum", values: ["stop", "length", "aborted", "error"] },
	ChatMessageSchema: {
		kind: "object",
		fields: {
			content: CONTENT_SHAPE,
			role: { kind: "enum", values: ["system", "user", "assistant"] },
		},
	},
	TranscriptMessageSchema: MESSAGE_SHAPE,
	ChatTranscriptSchema: {
		kind: "object",
		fields: {
			conversationId: { kind: "string" },
			messages: { kind: "array", of: MESSAGE_SHAPE },
			// 2026-11-13 历史分页（可选，只有分页请求才带）
			hasMore: { kind: "optional", of: { kind: "boolean" } },
			nextBefore: { kind: "optional", of: { kind: "string" } },
		},
	},
	ChatRequestSchema: {
		kind: "object",
		fields: {
			// 2026-11-06 侧栏调整 B2：新会话种类（续话带不匹配值 → 400）
			chatKind: { kind: "optional", of: { kind: "enum", values: ["chief", "worker"] } },
			conversationId: { kind: "optional", of: { kind: "string" } },
			// 2026-11-17 新建 worker 会话直接指定工作目录（纯增量）
			dirPath: { kind: "optional", of: { kind: "string" } },
			messages: {
				kind: "array",
				of: {
					kind: "object",
					fields: {
						content: CONTENT_SHAPE,
						role: { kind: "enum", values: ["system", "user", "assistant"] },
					},
				},
			},
			requestId: { kind: "optional", of: { kind: "string" } },
			// 2026-11-07 消息即引导：忙时投递方式（steer 插进当前轮 / followUp 排队）
			whenBusy: { kind: "optional", of: { kind: "enum", values: ["steer", "followUp"] } },
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
	"notice",
	// 2026-11-19 批2：worker 决策上报（跑动中 escalate，答复走插话回投）
	"escalation",
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
	{ type: "notice", text: "「阅读助手」当前不可用，跳过" },
	{
		type: "escalation",
		ticketId: "t1",
		domain: "d",
		escalationId: "e1",
		question: "目录结构要 A 还是 B？",
		context: "两种都可行，工时相同",
		options: ["A", "B"],
		urgency: "normal",
	},
];

test("ChatEvent 全部成员都有代表性样例，编码回读后 type 都在清单里", () => {
	const known = new Set<string>(ALL_EVENT_TYPES);
	for (const sample of SAMPLES) {
		const encoded = encodeSseEvent(sample);
		const parsed = JSON.parse(encoded.slice("data: ".length).trim()) as { type: string };
		assert.equal(parsed.type, sample.type);
		assert.ok(known.has(parsed.type), `未知事件类型 ${parsed.type}`);
	}
	assert.equal(SAMPLES.length, ALL_EVENT_TYPES.length, "样例数要跟成员清单对齐");
});
