import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { scopeKey, type MemoryEngine, type MemoryKind, type MemoryScope } from "@lifediary/memory";
// 派活能力（chancellor）。相对路径是刻意的：chancellor 是独立仓库，
// 跑的是 .ts 源码，装进 node_modules 后 node 不会给里面的 .ts 剥类型
// （ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING），所以不能走 file: 依赖。
// 只有这一处引用它，挪仓库时改这一行。
import { runChancellor } from "../../../../../chancellor/src/index.ts";
import { ReminderTask } from "./reminder.ts";
import type { SkillStore } from "./skills.ts";

/**
 * 我们自己的工具。
 *
 * 读/写/改/跑命令这四个不再自己写 —— durable 的 `CodingTools` 已经有一版
 * 更完整的（走执行环境、输出分页、图片处理、edit 的差异化写入），
 * 而且它的路径语义跟沙箱/远程环境是一致的。自己重写只会更差。
 *
 * 所以这里是：**记住**、**回忆**、**提醒**（个人 Agent 区别于编码 Agent 的部分）
 * 加一个 **skill**（2026-10-31 方案 D5：技能正文按需取，不进 system）。
 */

const MEMORY_KINDS: MemoryKind[] = ["fact", "episode", "preference", "entity"];

export interface ToolDeps {
	/** 记忆引擎；为 null 时 remember / recall 会明确报错而不是静默失败 */
	memory: MemoryEngine | null;
	/** 内部会话 id → 记忆作用域 */
	scopeOf: (conversationId: number) => MemoryScope;
	/** 技能库；为 null 时 skill 工具不上（技能目录不存在/为空，索引也不会渲染） */
	skills?: SkillStore | null;
	/**
	 * 派活能力；为 false 时 delegate 工具不上。
	 *
	 * 2026-11-02：默认开。装上 chancellor 之后主 agent 才有"把活派出去"的手。
	 * 关掉它（`CHANCELLOR_ENABLED=false`）时工具清单回到 8 个，行为与改动前完全一致。
	 */
	delegate?: boolean;
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

	// 派活（2026-11-02）：主 agent 的"手"。它自己不动手，把活交给外面的工人，
	// 只拿回一句话。工具的 description 里"不适合"那半句比"适合"更重要——
	// 写宽了，主 agent 会把一次 read 就能答的事也派出去，每次都起 worker，比不用还贵。
	const delegate = defineTool({
		name: "delegate",
		description:
			"把一件需要多步动手的活派给外面的工人去做，你只拿回一句话结论。" +
			"适合：要改多个文件、要跑命令、要查证之后再动手的任务。" +
			"不适合：回答问题、闲聊、一次 read 就能答的事、需要边做边问对方的事。" +
			"派出去之后你看不到过程，中途也不能追问；它干完或卡住，都只回你一句话。",
		parameters: Type.Object({
			requirement: Type.String({
				description: "要做的事，一句话说清，并且带上「怎么算做完了」",
			}),
		}),
		execute: async (args, _api, context) => {
			const result = await runChancellor(
				{ requirement: args.requirement },
				{ signal: context.abortSignal },
			);
			return text(result.line ?? "派出去的活没有返回结论。");
		},
	});

	const tools: ToolRegistration[] = [remember, recall, remind];

	if (deps.skills) {
		const skills = deps.skills;
		tools.push(
			defineTool({
				name: "skill",
				description:
					"取一份技能手册（完整流程）。会话的 skills 索引里列出了可用技能；" +
					"要按某个流程引导对方时，先调它拿到手册，再照着做。",
				parameters: Type.Object({
					name: Type.String({ description: "技能名，必须是索引里列出的名字" }),
				}),
				execute: async (args) => {
					const manual = skills.manual(args.name);
					if (!manual) {
						return text(
							`没有叫「${args.name}」的技能。可用：${skills.names().join("、") || "（无）"}`,
						);
					}
					return text(manual);
				},
			}),
		);
	}

	if (deps.delegate !== false) tools.push(delegate);

	return tools;
}
