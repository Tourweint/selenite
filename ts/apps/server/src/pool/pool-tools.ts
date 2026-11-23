import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
	createRegistry,
	defineExtension,
	defineTool,
	hook,
	ToolTask,
	type ToolHookCall,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { LOOP_GUARD_BLOCK_MESSAGE } from "../agent/turn-gate.ts";
import { loopGuardEnabled, loopGuardFor } from "../loop-guard.ts";
import { POOL_MAX_TURNS } from "./pool-settings.ts";
import { POOL_TOOL_NAMES } from "./task-profile.ts";

/**
 * 池进程的工具面与写入边界（设计文档 §5.6 / §5.7，P2 骨架）。
 *
 * 两件东西：
 * 1. `buildPoolRegistry`：内核 `CodingTools`（read/write/edit/bash）+ 池自己的 `escalate`
 *    + 一条 `beforeTool` 钩子。钩子按固定顺序做三件事，顺序本身是口径：
 *    (a) 工具白名单 → (b) 路径边界 → (c) bash 默认超时注入。
 *    先拦不该用的工具，再拦不该碰的路径，最后才改参数：被拦下的调用不该拿到补过的参数。
 * 2. `pathBlockReason`：纯函数，(b) 的判据。单测只测它和白名单常量本身——
 *    起 registry 要真 Harness 和真模型，那不属于单测（任务书：单测不许起真进程）。
 *
 * 与 chancellor 的 `worker-main.ts` 的关系：判据**照抄**，不另发明一套。
 * 两边各写一份"看起来差不多"的路径守卫，等于两个执行器有两种边界语义，
 * 出问题时没法用"宿主也是这么判的"互相印证。要改判据就连 chancellor 一起改。
 *
 * `defineExtension` 刻意**不带 `sections`**：系统提示词由装配层（pool-main）经
 * 会话 profile 传（`buildTaskProfile` 的产物），不是 registry 闭包里的固定文本——
 * 一个池进程串行跑多票，每票的人设与任务都不同，registry 是进程级单例，塞不进去。
 * 同一个理由适用于目录边界：`PoolToolDeps.currentDirs` 每票现取，不烘焙进 registry，
 * 否则第二票会继续用第一票的 `taskDir` / `workDir`。
 */

/** 一次上报的载荷。`escalationId` 与长度裁剪由宿主负责（它才有 uuid 与持久化）。 */
export interface EscalationInput {
	question: string;
	context: string;
	urgency?: "low" | "normal" | "high";
	options?: string[];
}

export interface PoolToolDeps {
	/**
	 * 当前票的两个边界目录（`[taskDir, workDir]`）。
	 *
	 * 必须是**每票现取**的函数，不能传快照：池进程跨票串行复用、registry 只建一次
	 * （设计文档 §4.3），闭包进快照 = 第二票继续用第一票的目录边界 = 第二票能写第一票的 worktree。
	 * 空闲（没有当前票）时返回空数组——`pathBlockReason` 对空目录列表一律 block，正是想要的。
	 */
	currentDirs: () => readonly string[];
	/** bash 默认超时秒数（`pool-settings.ts` 的 `bashTimeoutSeconds`）；<=0 = 不注入 */
	bashTimeoutSeconds: number;
	/**
	 * 上报出口：由装配层接 SSE / 队列，把问题送回宿主。
	 * 池进程**不**学 chancellor 往 stderr 写结构行——那套行协议是给"父进程 pipe 子进程"
	 * 设计的，池进程与宿主之间已经有 HTTP + SSE，另开一条 stderr 协议就是第二条通道。
	 */
	submitEscalation: (input: EscalationInput) => { ok: true } | { ok: false; message: string };
	/**
	 * 单轮工具调用上限（宿主 `AGENT_MAX_TURNS` 同口径，默认 `POOL_MAX_TURNS`）。
	 * 池内一票 = 一次提交 = 一轮，所以"每会话累计"就等于"每轮"。
	 * `<=0` = 不限。
	 */
	maxTurns?: number;
}

/**
 * 工具硬白名单。与 `task-profile.ts` 的 `POOL_TOOL_NAMES`（喂 profile 的那份）同源，
 * 不是抄的第二张表：定义层给五件、执行层拦到五件，两边必须永远是同一个列表。
 */
export const POOL_ALLOWED_TOOLS: ReadonlySet<string> = new Set<string>(POOL_TOOL_NAMES);

/** 只有这三件带 `path` 参数需要落到磁盘上，才需要边界判定。 */
const PATH_TOOLS: ReadonlySet<string> = new Set(["read", "write", "edit"]);

/**
 * 路径边界判定（纯函数）：`path` 解析后必须落在 `dirs` 之一内部。
 * 返回原因串 = 拦；返回 undefined = 放行。
 *
 * 三种"放行"各有理由，都不是漏判：
 * - 非 read/write/edit（bash、escalate）：没有 `path` 参数可判。bash 的越界在命令文本里，
 *   这一层不假装能拦住它（口径与 chancellor 一致：命令侧的约束属于闸门 / 只读策略，P3）。
 * - 缺 `path` 或 `path` 不是字符串：本工具没有可判的目标，交给内核按 schema 校验拒掉。
 *   在这里再补一句"路径必须是字符串"是重复校验，且会把 schema 错误伪装成边界错误。
 * - 目录参数为空串：`path.relative("", x)` 按 cwd 算，等价于"cwd 之内都算边界内"。
 *   装配层永远传两个绝对目录，这一条只是行为如实记录，不做额外兜底（不发明判据）。
 */
export function pathBlockReason(
	toolName: string,
	args: unknown,
	dirs: readonly string[],
): string | undefined {
	if (!PATH_TOOLS.has(toolName)) return undefined;
	const raw = (args as Record<string, unknown> | null | undefined)?.path;
	if (typeof raw !== "string") return undefined;
	if (dirs.some((dir) => isInside(dir, raw))) return undefined;
	return `路径不在任务目录或工作目录内：${raw}`;
}

/** 与 chancellor `worker-main.ts` 的 `isInside` 同判据：`path.resolve` + `path.relative` 的**分段**比较。
 *  不许"优化"成 `candidate.startsWith(dir)`——那样 `A-sibling/` 会以 `A` 为前缀被误判成界内。 */
function isInside(parent: string, child: string): boolean {
	const resolved = path.resolve(parent, child);
	const rel = path.relative(parent, resolved);
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * 决策上报工具。签名与 chancellor 的同名工具一致（question / context / urgency / options），
 * 差别只在出口：这里调 `deps.submitEscalation`，不走 stderr。
 * 立即返回、不退场：模型本轮收尾，答复由装配层以下一条 input 送回同一会话。
 */
function buildEscalateTool(submitEscalation: PoolToolDeps["submitEscalation"]) {
	return defineTool({
		name: "escalate",
		description:
			"把一个需要人拍板 / 需要人回答的问题上报，然后本轮收尾等答复。" +
			"只在**真有分叉**时用：两条都合理的路线要人选、缺一个只有人知道的事实、" +
			"要不要做一件不可逆 / 花钱的事。能从文件、任务书、项目记忆里查到的先自己查，别上报。" +
			"**一次只报一件事**；发出后不要自己猜答案、不要另找路子——答复会作为下一条消息回到本会话。",
		parameters: Type.Object({
			question: Type.String({
				description: "要拍板 / 要问的那一句话，具体到对方能直接回答（例：「目录结构选 A 还是 B」）",
			}),
			context: Type.String({
				description: "背景：为什么问、已经试过什么、各自的代价，让答的人不用猜",
			}),
			urgency: Type.Optional(
				Type.Union([Type.Literal("low"), Type.Literal("normal"), Type.Literal("high")], {
					description: "紧急度：high=卡着整单、normal=影响这一步、low=可以慢慢答；缺省 normal",
				}),
			),
			options: Type.Optional(
				Type.Array(Type.String(), {
					description: "候选答案，让人直接选；没有明确选项就不给",
				}),
			),
		}),
		async execute(args) {
			const result = submitEscalation({
				question: args.question,
				context: args.context,
				...(args.urgency ? { urgency: args.urgency } : {}),
				...(args.options ? { options: args.options } : {}),
			});
			const text = result.ok
				? "上报已受理，正在等答复：本轮先收尾，不要自己猜答案、不要重试别的路、也不要再上报第二件事。" +
					"答复会作为下一条消息回到本会话，收到后按它继续。"
				: `上报没有发出：${result.message}`;
			return {
				output: [{ type: "text" as const, text }],
				...(result.ok ? {} : { isError: true }),
			};
		},
	});
}

/** 装配层的形状：`Harness.open(..., { registry: buildPoolRegistry(deps), ... }, CTX)`。 */
export function buildPoolRegistry(deps: PoolToolDeps): ReturnType<typeof createRegistry> {
	const registry = createRegistry();
	// 每会话已用工具回合数。池内一票 = 一个新会话 = 一轮，所以不需要按轮重置；
	// 条目随会话数增长，但池进程每 N 票回收一次，天然有界。
	const turnCalls = new Map<number, number>();
	registry.install(CodingTools);
	registry.install(
		defineExtension({
			name: "lifediary-worker-pool",
			tools: [buildEscalateTool(deps.submitEscalation)],
			hooks: [
				hook(ToolTask, {
					beforeTool: (call: ToolHookCall, api) => {
						// (a) 白名单：内核给的面比五件大（CodingTools 之外还可能有别的扩展），
						//     不在名单里的一律不解释参数，连路径都不必看。
						if (!POOL_ALLOWED_TOOLS.has(call.name)) {
							return { block: `工具 ${call.name} 未获授权` };
						}
						// (b) 单轮工具调用上限：宿主 `MAX_TURNS` 的同口径（内核 1.4.0 没有 maxTurns，
						//     宿主也是自己数的）。只数顶层调用，嵌套不喂。
						//     `api` 在单测里可能是空的（只测路径判定），缺会话号时跳过计数。
						const conversationId = (api as { conversationId?: number } | undefined)?.conversationId;
						const budget = deps.maxTurns ?? POOL_MAX_TURNS;
						if (budget > 0 && call.parent === undefined && conversationId !== undefined) {
							const used = turnCalls.get(conversationId) ?? 0;
							if (used >= budget) {
								return { block: `工具调用已达上限（${budget} 次），请用已有信息收尾并写 REPORT` };
							}
							turnCalls.set(conversationId, used + 1);
						}
						// (c) 写入边界：只读工具同样受限——读到别人的配置也是越界。
						//     目录每票现取（deps.currentDirs()），不闭包：registry 是进程级单例，
						//     闭包快照会让下一票继续用上一票的边界。
						const block = pathBlockReason(call.name, call.arguments, deps.currentDirs());
						if (block) return { block };
						// (d) 防打转：与宿主同一套守卫（同指纹/read 窗口/乒乓/轮转四档）。
						//     无人值守更需要它——模型陷在"读同一个文件"的循环里时回合数还没到上限。
						if (loopGuardEnabled() && call.parent === undefined && conversationId !== undefined) {
							const hit = loopGuardFor(conversationId).before(call.name, call.arguments);
							if (hit !== "ok") return { block: LOOP_GUARD_BLOCK_MESSAGE };
						}
						// (e) bash 默认超时：只补模型没传的 timeout。
						//     `timeout=0` 绝不能注入——内核 validateTimeout 对 <=0 直接抛错，
						//     所以 deps.bashTimeoutSeconds<=0（"不设默认超时"）时整段跳过。
						//     这是唯一改参数的一步，放在最后：被拦的调用不该拿到补过的参数。
						if (call.name === "bash" && deps.bashTimeoutSeconds > 0) {
							const args = call.arguments as { timeout?: number };
							if (args.timeout === undefined) {
								return { arguments: { ...call.arguments, timeout: deps.bashTimeoutSeconds } };
							}
						}
						return undefined;
					},
					// 防打转的记账在 afterTool：`LoopGuard.before` 只读 streak，streak 由 after 推进。
					// 只挂在 beforeTool 上等于装了个永远不 tick 的计数器（2026-11-22 探针实测踩到：
					// 同一 bash 连发 40 次全执行，一次都没拦）。
					afterTool: (call: ToolHookCall, result, api) => {
						if (!loopGuardEnabled() || call.parent !== undefined) return undefined;
						const conversationId = (api as { conversationId?: number } | undefined)?.conversationId;
						if (conversationId === undefined) return undefined;
						const warned = loopGuardFor(conversationId).after(call.name, call.arguments, {
							isError: result.isError,
							output: result.output,
						});
						if (warned !== "ok") {
							console.warn(
								`[pool][loop-guard] conversation=${conversationId} pattern=${warned.pattern} count=${warned.count} tool=${call.name}`,
							);
						}
						return undefined;
					},
				}),
			],
		}),
	);
	return registry;
}

/**
 * 只读工具目录（2026-11-22 注入页预览）：五件与真实池会话同源。
 *
 * 不注册、不执行；escalate 的 submitEscalation 用永不成功的桩，只为了让
 * 设置页能看到与池进程一致的描述与参数。名字/顺序跟 `POOL_TOOL_NAMES` 一致。
 */
export function poolToolCatalog(): ToolRegistration[] {
	const coding = new Map((CodingTools.tools ?? []).map((tool) => [tool.name, tool]));
	const escalate = buildEscalateTool(() => ({ ok: false, message: "preview only" }));
	const byName = new Map<string, ToolRegistration>();
	for (const name of POOL_TOOL_NAMES) {
		const tool = name === "escalate" ? escalate : coding.get(name);
		if (tool) byName.set(name, tool);
	}
	return [...byName.values()];
}
