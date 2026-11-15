/**
 * 工具层结果契约化（2026-11-13 工具层结果契约化与自纠偏方案 §2 批次一 / §5 外挂式挂载）。
 *
 * 包装内核 bash / powershell 的**结果投影**，三小块：
 * 1. 语义退出码白名单：grep/rg（无匹配）、diff（有差异）、test/[（条件为假）的非零退出
 *    不标 isError，输出尾追加语义行——解析不准就当普通失败，宁可保守；
 * 2. 中断稳定标记：timeout / abort 的 error 文本统一追加
 *    `<error>Command was aborted before completion</error>`；
 * 3. 失败大输出 hint：内核已把全量输出落盘（fullOutputPath），这里在 isError 结果里补一行
 *    "完整输出已落盘：<path>，用 read 工具续看"——零风险拿到头尾保留九成效果。
 *
 * 外挂式挂载（§5 定稿）：注册表层只装一份（lifecycle-harness 换包装版，单一代码路径），
 * 包装器在 execute 入口先问 `projectionEnabledFor()`——开走投影，关**逐字节透传原结果**。
 * 工具 schema、描述、注册顺序一律不动（保 prompt cache 前缀稳定）。
 *
 * 判定与 path-guard 同风格：纯函数入参、单测直接断言；store / ChatKinds 等环境依赖经
 * `setProjectionDeps()` 注入（同 setChatKindsSource 惯例），不在这里读全局状态以外的环境。
 */

import type {
	ToolDiagnostic,
	ToolExecutionApi,
	ToolExecutionResult,
	ToolRegistration,
} from "@earendil-works/pi-durable";

/** 内核 bash / powershell 的 structuredOutput 形状（@earendil-works/pi-durable tools/bash）。 */
interface ShellStructuredOutput {
	output: string;
	truncated: boolean;
	fullOutputPath?: string;
	exitCode: number;
}

/** pi-ai 工具结果给模型看的文本条目（ToolResultMessage["content"] 的 text 项）。 */
interface TextItem {
	type: "text";
	text: string;
}

const ABORT_MARKER = "<error>Command was aborted before completion</error>";

// ── 语义退出码白名单 ────────────────────────────────────────────────

/** 语义型非零退出：命令首词 → 该退出码在语义上意味着什么。只认 exit 1。 */
const SEMANTIC_EXIT_ONE: Record<string, string> = {
	grep: "无匹配",
	rg: "无匹配",
	diff: "有差异",
	test: "条件为假",
	"[": "条件为假",
};

/**
 * 命令首词（含 `command -v` / `builtin` 后的首词；`-v` 这类 flag 跳过）。
 * 解析不准（空、管道、env 前缀等复杂形态）就返回空串 → 当普通失败，保守。
 */
export function firstCommandWord(command: string): string {
	const tokens = command.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return "";
	let rest = tokens;
	// env 前缀（FOO=1 grep …）：跳过赋值项再找首词，否则会把 FOO=1 当命令，语义豁免失效。
	while (rest.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0])) rest = rest.slice(1);
	if (rest.length === 0) return "";
	if (rest[0] === "command" || rest[0] === "builtin") {
		return rest.slice(1).find((token) => !token.startsWith("-")) ?? "";
	}
	return rest[0];
}

/**
 * exit 1 且首词在白名单里 → 语义型退出，返回语义说明（"无匹配" 等）；否则 null。
 * diff exit 2（真出错）、其他非零退出都不豁免。
 */
export function semanticExitReason(command: string, exitCode: number | undefined): string | null {
	if (exitCode !== 1) return null;
	const word = firstCommandWord(command);
	return SEMANTIC_EXIT_ONE[word] ?? null;
}

// ── 结果投影（纯函数） ──────────────────────────────────────────────

/** 把文本追加到给模型的 output 尾部；output 原本缺省时用 structuredOutput 的 retained 文本兜底。 */
function appendToOutput(
	output: ToolExecutionResult["output"],
	fallback: string,
	extra: string,
): ToolExecutionResult["output"] {
	const line = `${fallback}\n${extra}`;
	if (output === undefined) return [{ type: "text", text: line }] satisfies TextItem[] as never;
	const items = output as unknown as TextItem[];
	const last = items[items.length - 1];
	if (last && last.type === "text") {
		return [...items.slice(0, -1), { type: "text", text: `${last.text}\n${extra}` }] as never;
	}
	return [...items, { type: "text", text: extra }] as never;
}

/** 去掉内核写的 exit_code error 诊断（语义豁免后它不该再吓人），其余原样保留。 */
function filterExitCodeError(diagnostics: readonly ToolDiagnostic[] | undefined): ToolDiagnostic[] {
	return (diagnostics ?? []).filter((d) => !(d.severity === "error" && d.code === "exit_code"));
}

/**
 * 对内核 bash / powershell 的结果做投影。只动 isError 的失败结果：
 * - 语义型退出 → isError 摘掉、输出尾追加语义行、exit_code error 诊断换成 info；
 * - 其余失败且落了盘 → 输出尾追加 hint（完整输出在 <path>）；
 * - 成功结果与没得投影的失败结果**原引用返回**，一字节不动。
 */
export function projectShellResult(
	result: ToolExecutionResult,
	command: string,
): ToolExecutionResult {
	if (!result.isError) return result;
	const so = result.structuredOutput as ShellStructuredOutput | undefined;
	if (!so) return result;

	const reason = semanticExitReason(command, so.exitCode);
	if (reason !== null) {
		const line = `exit ${so.exitCode}（语义型退出：${reason}，不是错误）`;
		return {
			...result,
			isError: false,
			output: appendToOutput(result.output, so.output, line),
			structuredOutput: { ...so, output: `${so.output}\n${line}` },
			diagnostics: [
				...filterExitCodeError(result.diagnostics),
				{ severity: "info", code: "semantic_exit", message: line },
			],
		};
	}

	if (so.fullOutputPath !== undefined) {
		const hint = `完整输出已落盘：${so.fullOutputPath}，用 read 工具续看。`;
		return {
			...result,
			output: appendToOutput(result.output, so.output, hint),
			structuredOutput: { ...so, output: `${so.output}\n${hint}` },
		};
	}
	return result;
}

/**
 * timeout / abort 抛出的错误 → 文本追加中断稳定标记后重新抛出（包装器里 rethrow）。
 * 只动消息含 timed out / abort 或 error.code 是 aborted/timeout 的；其他错误原样透传。
 */
export function projectShellError(error: unknown): unknown {
	if (!(error instanceof Error)) return error;
	const code = (error as { code?: unknown }).code;
	const interrupted =
		code === "aborted" || code === "timeout" || /timed out|abort/i.test(error.message);
	if (interrupted && !error.message.includes(ABORT_MARKER)) {
		return new Error(`${error.message}\n${ABORT_MARKER}`);
	}
	return error;
}

// ── 挂载开关判定（§5） ──────────────────────────────────────────────

/** 执事行的判定所需切片（PartnerRow 的子集，避免把整个类型拖进来）。 */
export interface ProjectionPartnerSlice {
	domain: string | null;
	/** 三态：null = 跟随默认；1 = 强制开；0 = 强制关。 */
	toolProjection: 1 | 0 | null;
}

/** 挂载判定的环境依赖，全部由 lifecycle-harness 注入（同 setChatKindsSource 惯例）。 */
export interface ProjectionDeps {
	partnerIdOfSession(sessionId: number): string | null;
	getPartner(id: string): ProjectionPartnerSlice | null;
	chatKindOf(sessionId: number): Promise<"chief" | "worker" | null>;
}

/** 回滚开关 `TOOL_PROJECTION=false`：判定恒 false，全部会话透传原结果（能力整体下线）。 */
export function toolProjectionEnvEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return (env.TOOL_PROJECTION?.trim() || "true").toLowerCase() !== "false";
}

/**
 * 打手默认开关 `TOOL_PROJECTION_WORKER`（2026-11-16）：只管**本机内核打手**
 * （`chatKind === "worker"`：子任务 / 派单执行者）的默认是否整理工具结果。
 *
 * 外接 CLI 打手（CodeBuddy / Qoder / Claude Code / Codex / OpenCode）跑自己的工具、
 * 不经过本层包装器，因此**不受此开关影响**——这不是遗漏，是设计口径。
 *
 * 缺省 / 空串 = 开；只有明确 `false` 才关（与 `TOOL_PROJECTION` 同口径）。
 */
export function toolProjectionWorkerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return (env.TOOL_PROJECTION_WORKER?.trim() || "true").toLowerCase() !== "false";
}

/**
 * 纯判定（§5.2 / §5.3；2026-11-16 收窄为「只管打手」）：
 * 1. env 总开关关 → false；
 * 2. 执事三态（1 开 / 0 关）压过一切默认；
 * 3. worker / 子单 / 验收子会话走 `workerDefault`（`TOOL_PROJECTION_WORKER`，默认开）；
 * 4. 其余默认一律 false：主人会话、执事会话（**带不带 domain 都一样**，执事基本不写代码）、
 *    聊天型伙伴都不整理；执事要用就在个人页把三态设成 1。
 */
export function projectionDecision(input: {
	envEnabled: boolean;
	partnerId: string | null;
	partner: ProjectionPartnerSlice | null;
	chatKind: "chief" | "worker" | null;
	/** 打手会话的默认值（`toolProjectionWorkerEnabled()`）；仅 `chatKind === "worker"` 时生效。 */
	workerDefault: boolean;
}): boolean {
	if (!input.envEnabled) return false;
	const partner = input.partner;
	if (partner?.toolProjection === 1) return true;
	if (partner?.toolProjection === 0) return false;
	if (input.chatKind === "worker") return input.workerDefault;
	// 2026-11-16：原「带 domain 的执事会话默认开」已删——执事与总管基本不写代码，
	// 默认只管打手；执事需要时用三态 1 显式打开。
	return false;
}

let deps: ProjectionDeps | null = null;

/** lifecycle-harness 装配时注入真实依赖；不注入（如单测直接测纯函数）= 判定恒 false，全透传。 */
export function setProjectionDeps(next: ProjectionDeps): void {
	deps = next;
}

/** 包装器 execute 入口问的挂载判定：env + 执事三态 + 会话 kind，逐条走纯函数。 */
export async function projectionEnabledFor(api: ToolExecutionApi): Promise<boolean> {
	if (!deps) return false;
	const conversationId = Number(api.conversationId);
	const partnerId = deps.partnerIdOfSession(conversationId);
	return projectionDecision({
		envEnabled: toolProjectionEnvEnabled(),
		partnerId,
		partner: partnerId ? (deps.getPartner(partnerId) ?? null) : null,
		chatKind: await deps.chatKindOf(conversationId),
		workerDefault: toolProjectionWorkerEnabled(),
	});
}

// ── 包装器 ──────────────────────────────────────────────────────────

/**
 * 包装内核 bash / powershell：关 → 直接透传内核原结果（原引用，逐字节不变）；
 * 开 → 结果走 projectShellResult、抛错走 projectShellError。
 * name / description / parameters / structuredOutputSchema / outputLimits 原样保留。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- CodingTools 的工具是多个具体 schema 的联合，包装层不需要区分
export function wrapShellTool(tool: ToolRegistration<any>): ToolRegistration<any> {
	if (tool.name !== "bash" && tool.name !== "powershell") return tool;
	const inner = tool;
	const wrapped: ToolRegistration<any> = {
		...inner,
		async execute(args, api, context) {
			const enabled = await projectionEnabledFor(api);
			try {
				const result = await inner.execute(args, api, context);
				return enabled ? projectShellResult(result, String((args as { command?: unknown }).command ?? "")) : result;
			} catch (error) {
				throw enabled ? projectShellError(error) : error;
			}
		},
	};
	return wrapped;
}
