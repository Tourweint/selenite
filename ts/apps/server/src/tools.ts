import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { scopeKey, type MemoryEngine, type MemoryKind, type MemoryScope } from "@lifediary/memory";
import { ReminderTask } from "./reminder.ts";

/**
 * 我们自己的工具。
 *
 * 读/写/改/跑命令这四个不再自己写 —— durable 的 `CodingTools` 已经有一版
 * 更完整的（走执行环境、输出分页、图片处理、edit 的差异化写入），
 * 而且它的路径语义跟沙箱/远程环境是一致的。自己重写只会更差。
 *
 * 所以这里只剩三件事：**记住**、**回忆**、**提醒**。
 * 这三件事是"个人 Agent"区别于编码 Agent 的地方，必须自己实现。
 */

const MEMORY_KINDS: MemoryKind[] = ["fact", "episode", "preference", "entity"];

export interface ToolDeps {
	/** 记忆引擎；为 null 时 remember / recall 会明确报错而不是静默失败 */
	memory: MemoryEngine | null;
	/** 内部会话 id → 记忆作用域 */
	scopeOf: (conversationId: number) => MemoryScope;
}

function text(value: string) {
	return { output: [{ type: "text" as const, text: value }] };
}

export function createTools(deps: ToolDeps) {
	const { memory, scopeOf } = deps;

	const requireMemory = (): MemoryEngine => {
		if (!memory) throw new Error("记忆库未启用（MEMORY_ENABLED=false 或初始化失败）");
		return memory;
	};

	const remember = defineTool({
		name: "remember",
		description:
			"把一件事写进长期记忆，以后每次对话都可能被想起来。" +
			"适合：对方的偏好、家人朋友宠物、长期目标、重要经历。" +
			"不适合：一次性的琐事、马上就会变的信息。",
		parameters: Type.Object({
			content: Type.String({ description: "要记住的内容，一句话，用第三人称或原话" }),
			kind: Type.Optional(
				Type.Unsafe<MemoryKind>({
					type: "string",
					enum: MEMORY_KINDS,
					description: "fact=事实 / episode=经历过的事 / preference=偏好 / entity=人事物",
				}),
			),
			importance: Type.Optional(
				Type.Number({ description: "重要程度 0..1，默认 0.7", minimum: 0, maximum: 1 }),
			),
		}),
		execute: async (args, api) => {
			const engine = requireMemory();
			const record = engine.remember({
				kind: args.kind ?? "fact",
				scope: scopeOf(api.conversationId),
				content: args.content,
				importance: args.importance,
				// 人自己说的（或当面转述的），可信度最高
				veracity: "stated",
				source: "user",
			});
			return text(`已记住：${record.content}`);
		},
	});

	const recall = defineTool({
		name: "recall",
		description:
			"在长期记忆里检索。和对方有关的事想不起来了，先用它查，不要猜。" +
			"当前对话的上下文里通常已经带了相关记忆，只有在不够用时才调用。",
		parameters: Type.Object({
			query: Type.String({ description: "要查什么，用关键词或一句话" }),
			limit: Type.Optional(Type.Number({ description: "最多返回几条，默认 5" })),
		}),
		execute: async (args, api) => {
			const engine = requireMemory();
			const hits = engine.recall({
				text: args.query,
				scopes: ["global", scopeKey(scopeOf(api.conversationId))],
				limit: Math.max(1, Math.min(20, Math.floor(args.limit ?? 5))),
			});
			if (hits.length === 0) return text("没有找到相关记忆。");
			return text(
				hits
					.map((hit) => `- [${hit.record.kind}] ${hit.record.content}（${hit.record.createdAt.slice(0, 10)}）`)
					.join("\n"),
			);
		},
	});

	const remind = defineTool({
		name: "set_reminder",
		description:
			"定一个到点提醒。时间写 ISO 8601（带时区），例如 2026-10-29T08:00:00+08:00。" +
			"提醒会落库，进程重启也不会丢。",
		parameters: Type.Object({
			text: Type.String({ description: "到点要提醒的内容" }),
			at: Type.String({ description: "触发时间，ISO 8601" }),
		}),
		execute: async (args, api, context) => {
			const at = Date.parse(args.at);
			if (Number.isNaN(at)) throw new Error(`时间格式看不懂：${args.at}`);
			if (at <= api.now()) throw new Error(`这个时间已经过去了：${args.at}`);

			await api.commit(
				(tx) =>
					tx.createTask(
						ReminderTask,
						{ text: args.text, at },
						{ ownership: { kind: "conversation" } },
					),
				context,
			);
			return text(`好，${new Date(at).toLocaleString("zh-CN")} 提醒你：${args.text}`);
		},
	});

	return [remember, recall, remind];
}
