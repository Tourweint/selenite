import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { WRITE_TOOLS } from "../approval-policy.ts";
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
	 * 写类工具执行前是否要人确认（2026-11-04 批次二，独立轴）。
	 * 默认关 = 与改动前完全一致；`AGENT_CONFIRM_WRITES=1` 打开。
	 */
	confirmWrites: boolean;
}

const POLICY_PATH = process.env.AGENT_POLICY_PATH?.trim() || ".data/policy.json";

const ACCESS_LABEL: Record<ToolAccess, string> = {
	full: "完全访问",
	"read-only": "只读",
	"no-shell": "不跑命令",
};

function initialPolicy(): PolicyState {
	const access = (process.env.AGENT_TOOL_POLICY?.trim() || "full").toLowerCase();
	const confirm = (process.env.AGENT_CONFIRM_WRITES?.trim() || "").toLowerCase();
	return {
		access: access === "read-only" || access === "no-shell" ? access : "full",
		blocked: (process.env.AGENT_BLOCKED_TOOLS ?? "")
			.split(",")
			.map((name) => name.trim())
			.filter(Boolean),
		confirmWrites: confirm === "1" || confirm === "true",
	};
}

function loadPolicy(): PolicyState {
	const base = initialPolicy();
	try {
		const parsed = JSON.parse(readFileSync(POLICY_PATH, "utf8")) as Partial<PolicyState>;
		const access =
			parsed.access === "read-only" || parsed.access === "no-shell" || parsed.access === "full"
				? parsed.access
				: base.access;
		return {
			access,
			blocked: Array.isArray(parsed.blocked) ? parsed.blocked : base.blocked,
			// 老安装的 policy.json 里没有这个字段：回落 env 初值，别写死 false
			confirmWrites:
				typeof parsed.confirmWrites === "boolean" ? parsed.confirmWrites : base.confirmWrites,
		};
	} catch {
		return base;
	}
}

export let policy: PolicyState = loadPolicy();

export function getPolicy(): PolicyState & { label: string } {
	return { ...policy, label: ACCESS_LABEL[policy.access] };
}

export function setPolicy(next: {
	access?: ToolAccess;
	blocked?: string[];
	confirmWrites?: boolean;
}): PolicyState {
	if (next.access) policy.access = next.access;
	if (Array.isArray(next.blocked)) policy.blocked = next.blocked.filter(Boolean);
	if (typeof next.confirmWrites === "boolean") policy.confirmWrites = next.confirmWrites;
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
 */
export function readOnlyBlockReason(name: string): string | undefined {
	if (policy.blocked.includes(name)) return `工具 ${name} 已被禁用`;
	if (policy.access === "read-only" && WRITE_TOOLS.has(name)) {
		return `当前是「${ACCESS_LABEL["read-only"]}」模式，这个工具被拦下了。需要的话在设置里换档。`;
	}
	if (policy.access === "no-shell" && SHELL_TOOLS.has(name)) {
		return `当前是「${ACCESS_LABEL["no-shell"]}」模式，不能执行命令。需要的话在设置里换档。`;
	}
	return undefined;
}
