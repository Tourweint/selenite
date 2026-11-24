import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { WRITE_TOOLS, type ApprovalLevel } from "../approval-policy.ts";
import { isViewOnlyShellCommand, viewCommandsInReadTiers } from "../read-allowlist.ts";
import { bashTimeoutSeconds } from "../reliability.ts";

/** full = 全部放行；read-only = 只允许读（写文件/跑命令一律拦住） */
/**
 * 访问档位（2026-11-03 改成运行时可切）。
 *
 * 以前只认环境变量，改一次要重启服务——那不是"权限管理"，是"部署配置"。
 * 现在 env 只是初值，界面上的选择会写到 `.data/policy.json`，下次启动沿用。
 */
export type ToolAccess = "full" | "read-only" | "no-shell";

interface PolicyState {
	access: ToolAccess;
	blocked: string[];
	/**
	 * 审批档（2026-11-08 扫尾批 10-C，独立轴，取代旧的布尔 `confirmWrites`）。
	 * 三档：`ask-all` 全问 / `ask-critical` 只问高危 / `none` 全不问。
	 * 默认 `none` = 与改动前完全一致；`AGENT_CONFIRM_WRITES=1` 仍是初值来源（映射 ask-all）。
	 */
	approvalLevel: ApprovalLevel;
}

/** 兼容老 policy.json：旧字段 `confirmWrites` 只在读档时认 */
type StoredPolicy = Partial<PolicyState> & { confirmWrites?: unknown };

const POLICY_PATH = process.env.AGENT_POLICY_PATH?.trim() || ".data/policy.json";

const ACCESS_LABEL: Record<ToolAccess, string> = {
	full: "完全访问",
	"read-only": "只读",
	// 2026-11-14：对外改叫「在工作区内修改」——这一档真正允许的就是「在工作区/项目里改文件」，
	// 命令仍然一律拦下（命令文本不做扫描，放开就说不清它到底在哪儿动手）。
	"no-shell": "在工作区内修改",
};

function isApprovalLevel(value: unknown): value is ApprovalLevel {
	return value === "ask-all" || value === "ask-critical" || value === "none";
}

function initialPolicy(): PolicyState {
	const access = (process.env.AGENT_TOOL_POLICY?.trim() || "full").toLowerCase();
	const confirm = (process.env.AGENT_CONFIRM_WRITES?.trim() || "").toLowerCase();
	return {
		access: access === "read-only" || access === "no-shell" ? access : "full",
		blocked: (process.env.AGENT_BLOCKED_TOOLS ?? "")
			.split(",")
			.map((name) => name.trim())
			.filter(Boolean),
		// 旧 env 语义原样保留：1/true = 全问，其余 = 全不问
		approvalLevel: confirm === "1" || confirm === "true" ? "ask-all" : "none",
	};
}

function loadPolicy(): PolicyState {
	const base = initialPolicy();
	try {
		const parsed = JSON.parse(readFileSync(POLICY_PATH, "utf8")) as StoredPolicy;
		const access =
			parsed.access === "read-only" || parsed.access === "no-shell" || parsed.access === "full"
				? parsed.access
				: base.access;
		// 新字段优先；老安装的 policy.json 只有 `confirmWrites` 布尔，按旧语义映射；
		// 两个都没有才回落 env 初值（别写死 none，否则设了 env 的老安装也不生效）
		const approvalLevel = isApprovalLevel(parsed.approvalLevel)
			? parsed.approvalLevel
			: typeof parsed.confirmWrites === "boolean"
				? parsed.confirmWrites
					? "ask-all"
					: "none"
				: base.approvalLevel;
		return {
			access,
			blocked: Array.isArray(parsed.blocked) ? parsed.blocked : base.blocked,
			approvalLevel,
		};
	} catch {
		return base;
	}
}

/** 审批形态：`async`（缺省，等待态落库、答复触发续跑）/ `blocking`（旧 120s 阻塞，回滚用） */
export type ApprovalMode = "async" | "blocking";

/**
 * 当前审批形态（2026-11-08 扫尾批 8c）。
 *
 * 只认 env、**不落 policy.json**：这是部署形态，不是用户在界面上的档位。
 * 缺省 async = 新形态；`AGENT_APPROVAL_MODE=blocking` 一行回滚到旧的 120s 阻塞等待
 * （旧代码路径整段保留，见 `agent/lifecycle.ts` 的 beforeTool）。
 */
export function approvalMode(): ApprovalMode {
	return (process.env.AGENT_APPROVAL_MODE ?? "").trim().toLowerCase() === "blocking"
		? "blocking"
		: "async";
}

export let policy: PolicyState = loadPolicy();

/**
 * 对外投影。
 *
 * `confirmWrites` 是**派生字段**（2026-11-08 扫尾批 10-C）：旧客户端只认布尔，
 * `none` → false，其余（ask-all / ask-critical）→ true。新客户端读 `approvalLevel`。
 */
export function getPolicy(): PolicyState & {
	label: string;
	approvalMode: ApprovalMode;
	confirmWrites: boolean;
} {
	return {
		...policy,
		label: ACCESS_LABEL[policy.access],
		approvalMode: approvalMode(),
		confirmWrites: policy.approvalLevel !== "none",
	};
}

export function setPolicy(next: {
	access?: ToolAccess;
	blocked?: string[];
	approvalLevel?: ApprovalLevel;
	/** 旧字段兼容：true → ask-all，false → none（显式 approvalLevel 优先） */
	confirmWrites?: boolean;
}): PolicyState {
	if (next.access) policy.access = next.access;
	if (Array.isArray(next.blocked)) policy.blocked = next.blocked.filter(Boolean);
	if (isApprovalLevel(next.approvalLevel)) policy.approvalLevel = next.approvalLevel;
	else if (typeof next.confirmWrites === "boolean") {
		policy.approvalLevel = next.confirmWrites ? "ask-all" : "none";
	}
	try {
		mkdirSync(dirname(POLICY_PATH), { recursive: true });
		writeFileSync(POLICY_PATH, JSON.stringify(policy, null, 2));
	} catch (error) {
		console.warn(
			`[policy] 写 ${POLICY_PATH} 失败（本次仍然生效）: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return policy;
}

// `WRITE_TOOLS` 在 approval-policy.ts —— 审批判定与只读闸门必须用同一份清单
const SHELL_TOOLS = new Set(["bash", "powershell"]);

/**
 * bash 工具默认超时（秒，2026-11-04 批次一 A4）。
 *
 * 模型没传 `timeout` 时由 beforeTool 注入；`AGENT_BASH_TIMEOUT_S=0`（或非法值）
 * = 不注入，回到内核的"no default timeout"。
 */
export const BASH_TIMEOUT_S = bashTimeoutSeconds(process.env);

/**
 * 只读模式下该不该拦这个工具。
 *
 * 提成独立函数是为了**能测**：安全规则埋在 hook 里只能靠起服务、驱动一次工具调用才能验，
 * 而 faux 给的工具参数是空对象，`delegate` 这种带必填参数的工具根本走不到执行那一步
 * （`provider.ts` 里只给 `recall` / `bash` 特判了参数）。提取出来之后 `delegate-gate-probe.ts`
 * 可以直接断言，不用绕。
 *
 * 注意 `delegate` 在 `WRITE_TOOLS` 里：它本身不写文件，但它会起 worker 去写。
 * 不拦它，`AGENT_TOOL_POLICY=read-only` 就是个谎。
 *
 * 2026-11-14：`bash` / `powershell` 也在 `WRITE_TOOLS` 里，所以旧版只读档连 `ls` 都跑不了——
 * 那不是"只读"，是"什么都干不了"。现在两档都先试一次「查看命令」判定
 * （`isViewOnlyShellCommand`，词表窄 + 看旗标 + 路径限根），命中才放行，其余照旧拦。
 * 档位仍然单调：只读 ⊂ 在工作区内修改 ⊂ 完全访问。回滚：`AGENT_READ_VIEW_COMMANDS=0`。
 *
 * `context` 缺省时**不看查看命令**（保守照旧拦）：老调用点拿不到命令文本与根集合，
 * 那就没有"它是只读的"这回事。
 */
export interface ViewCommandContext {
	readonly args?: unknown;
	readonly workspaceRoots?: readonly string[];
	readonly cwd?: string;
}

/**
 * 档位本身的判据（**不含黑名单**，黑名单在 `readOnlyBlockReason` 里先判）。
 *
 * 提成纯函数是为了能直接断言三档：`policy.access` 是进程级状态，测试里靠 env + 动态 import
 * 去造，一和其他测试文件同进程跑就会读到本机 `.data/policy.json`（档位串味）。
 */
export function accessBlockReason(
	access: ToolAccess,
	name: string,
	context?: ViewCommandContext,
): string | undefined {
	const isView =
		context !== undefined &&
		viewCommandsInReadTiers() &&
		isViewOnlyShellCommand(name, context.args, context.workspaceRoots ?? [], context.cwd ?? "");
	if (access === "read-only" && WRITE_TOOLS.has(name)) {
		if (isView) return undefined;
		return `当前是「${ACCESS_LABEL["read-only"]}」模式：这个工具被拦下了（只放行 ls / cat / grep 这类查看命令）。需要的话在设置里换档。`;
	}
	if (access === "no-shell" && SHELL_TOOLS.has(name)) {
		if (isView) return undefined;
		return `当前是「${ACCESS_LABEL["no-shell"]}」档：文件只能改工作区和已登记项目里的，命令只放行查看（ls / cat / grep 这类）。需要的话在设置 → 权限里换档。`;
	}
	return undefined;
}

export function readOnlyBlockReason(name: string, context?: ViewCommandContext): string | undefined {
	if (policy.blocked.includes(name)) return `工具 ${name} 已被禁用`;
	return accessBlockReason(policy.access, name, context);
}

/**
 * 外部记忆库模式下 `remember` 的只读档拦截（2026-11-23 外部记忆库接入）。
 *
 * 内置 remember 只写小库，是 READ 类、只读档放行；外部模式它变成「起进程写外部库」，
 * 必须按写工具对待（2026-11-24 退役 persona_write 后，它自己是唯一的写入口）。
 * 文案要告诉人怎么回退：换档。
 *
 * 纯函数（档位判据与 `accessBlockReason` 同口径：只读档拦、其余放行），
 * 闸门测试直接断言，不用起 harness。
 */
export function externalRememberBlockReason(
	access: ToolAccess,
	context?: ViewCommandContext,
): string | undefined {
	// 与写工具同档（persona_write 已退役，这里直接按 read-only 判；no-shell / full 放行）。
	void context;
	if (access !== "read-only") return undefined;
	return "当前是「只读」模式：外部记忆库的 remember 会起进程写外部库，已被拦下。要写就换档（设置 → 权限）。";
}

/**
 * 外部记忆库模式下 `remember` 的能力面（2026-11-24 旧形态退役后）。
 *
 * `remember` 平时是只读内部状态；外部槽位下它起进程写外部库，无人值守判定必须按
 * 「destructive + critical」处理。它**不是**一个独立工具，刻意不登记进
 * `TOOL_CAPABILITIES`（否则双向等值断言会把它当成真实的写工具）。
 */
export const EXTERNAL_REMEMBER_CAPABILITY = {
	name: "remember",
	readOnly: false,
	destructive: true,
	sideEffectScope: "external",
	riskLevel: "high",
	needsApproval: "critical",
	concurrentSafe: true,
	notes: "外部记忆库槽位下的 remember：起子进程写外部库，按写工具 / 每写必弹对待。",
} as const;
