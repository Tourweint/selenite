/**
 * 工具能力声明（2026-11-09 任务书 T3 §1）。
 *
 * 本批做的是「**登记，不是接管**」：把每个已注册工具的口径显式写成一份可测的声明，
 * 让「谁写盘、谁起进程、谁要人点头」从散落在 `WRITE_TOOLS` / `DEFAULT_CRITICAL_TOOLS`
 * / 注释里的隐性知识，变成一张表 + 单测断言。
 *
 * **判定逻辑完全没变**：`needsApproval()` 仍读老的 `WRITE_TOOLS` 与高危清单，
 * `readOnlyBlockReason()` 也仍读 `WRITE_TOOLS`。这里的数据不参与任何运行时判断——
 * 只被 `tool-capability.test.ts` 拿来对齐。
 *
 * 下一批才让闸门读声明（先让本表与老清单稳定一致一段时间，再切换事实源）。
 *
 * 字段口径：
 * - `destructive` = 不可撤销（写盘 / 起进程 / 派活）。**与 `WRITE_TOOLS` 逐项等值**，
 *   这是 1.3 一致性守卫的锚点；`remember` 这类只写可清理的内部状态不算。
 * - `needsApproval` = **该工具自身要求的审批下限**：
 *     `critical` = 进 `DEFAULT_CRITICAL_TOOLS`（`ask-critical` 也问）；
 *     `always`   = 任何档位都问（当前无）；
 *     `never`    = 自身不要求（是否问取决于 `ask-all` 的写类集合）。
 *   所以 `write` / `edit` 是 `never`：它们只在 `ask-all` 档被问，属于"档位带出来"的确认，
 *   不是这个工具自己的下限。断言 `{needsApproval !== "never"} === DEFAULT_CRITICAL_TOOLS`。
 * - `readOnly` / `sideEffectScope` / `riskLevel` / `concurrentSafe` 目前只供人读与后续批次使用。
 */

export type SideEffectScope = "none" | "memory" | "workspace" | "process" | "external";
export type ToolRiskLevel = "low" | "medium" | "high";
export type ApprovalFloor = "never" | "critical" | "always";

export interface ToolCapability {
	name: string;
	/** 纯读，无副作用 */
	readOnly: boolean;
	/** 不可撤销（写盘 / 起进程 / 派活）——与 WRITE_TOOLS 逐项等值 */
	destructive: boolean;
	sideEffectScope: SideEffectScope;
	riskLevel: ToolRiskLevel;
	/** 与审批三档对齐的"下限"：critical = 进高危清单；never = 自身不要求 */
	needsApproval: ApprovalFloor;
	/** 同一会话内可否并发 */
	concurrentSafe: boolean;
	/** 一句话说明（中文） */
	notes?: string;
}

export const TOOL_CAPABILITIES: Record<string, ToolCapability> = {
	// ── 内核 CodingTools 五件 ──────────────────────────────
	read: {
		name: "read",
		readOnly: true,
		destructive: false,
		sideEffectScope: "none",
		riskLevel: "low",
		needsApproval: "never",
		concurrentSafe: true,
		notes: "读文件，纯读；工作区边界由 path-guard 之外的既有语义兜。",
	},
	write: {
		name: "write",
		readOnly: false,
		destructive: true,
		sideEffectScope: "workspace",
		riskLevel: "medium",
		needsApproval: "never",
		concurrentSafe: false,
		notes: "写文件；只读档一律拦，只读白名单永远不覆盖它。",
	},
	edit: {
		name: "edit",
		readOnly: false,
		destructive: true,
		sideEffectScope: "workspace",
		riskLevel: "medium",
		needsApproval: "never",
		concurrentSafe: false,
		notes: "改文件（差异化写入）；同一路径不能并发改。",
	},
	bash: {
		name: "bash",
		readOnly: false,
		destructive: true,
		sideEffectScope: "process",
		riskLevel: "high",
		needsApproval: "critical",
		concurrentSafe: false,
		notes: "起子进程；命令文本不预扫，靠审批与 cwd 圈定兜底。",
	},
	powershell: {
		name: "powershell",
		readOnly: false,
		destructive: true,
		sideEffectScope: "process",
		riskLevel: "high",
		needsApproval: "critical",
		concurrentSafe: false,
		notes: "Windows 下的同类；与 bash 同档。",
	},

	// ── 记忆 / 提醒 / 提醒类 ───────────────────────────────
	remember: {
		name: "remember",
		readOnly: false,
		destructive: false,
		sideEffectScope: "memory",
		riskLevel: "low",
		needsApproval: "never",
		concurrentSafe: true,
		notes: "写记忆库；可被整理/清理，不属于不可撤销写盘。",
	},
	recall: {
		name: "recall",
		readOnly: true,
		destructive: false,
		sideEffectScope: "memory",
		riskLevel: "low",
		needsApproval: "never",
		concurrentSafe: true,
		notes: "查记忆；只读（命中会强化权重，仍属读路径）。",
	},
	set_reminder: {
		name: "set_reminder",
		readOnly: false,
		destructive: false,
		sideEffectScope: "memory",
		riskLevel: "low",
		needsApproval: "never",
		concurrentSafe: true,
		notes: "给自己排一个 durable 闹钟；不改工作区、不起外部进程。",
	},

	// ── 派活 / 项目 ────────────────────────────────────────
	delegate: {
		name: "delegate",
		readOnly: false,
		destructive: true,
		sideEffectScope: "process",
		riskLevel: "high",
		needsApproval: "critical",
		concurrentSafe: true,
		notes: "起 worker 去写文件；本身不动手，但会让别人动手。",
	},
	propose_project: {
		name: "propose_project",
		readOnly: false,
		destructive: true,
		sideEffectScope: "workspace",
		riskLevel: "low",
		needsApproval: "never",
		concurrentSafe: true,
		notes: "只提交待确认的项目提议；确认后会建目录，故与派活同进闸门。",
	},

	// ── 技能 ───────────────────────────────────────────────
	skill: {
		name: "skill",
		readOnly: true,
		destructive: false,
		sideEffectScope: "none",
		riskLevel: "low",
		needsApproval: "never",
		concurrentSafe: true,
		notes: "按需取技能手册正文，纯读。",
	},
	partner_skill_write: {
		name: "partner_skill_write",
		readOnly: false,
		destructive: true,
		sideEffectScope: "workspace",
		riskLevel: "medium",
		needsApproval: "never",
		concurrentSafe: false,
		notes: "写执事/总管技能文件（原子写、有大小上限）。",
	},

	// ── 执事 / 群组 / 例行 ─────────────────────────────────
	partner_manage: {
		name: "partner_manage",
		readOnly: false,
		destructive: true,
		sideEffectScope: "workspace",
		riskLevel: "high",
		needsApproval: "critical",
		concurrentSafe: true,
		notes: "建/停执事、改派发权；会动角色目录与 chancellor 领域目录。",
	},
	group_manage: {
		name: "group_manage",
		readOnly: false,
		destructive: true,
		sideEffectScope: "workspace",
		riskLevel: "medium",
		needsApproval: "never",
		concurrentSafe: true,
		notes: "建/停群会话；改的是「谁跟谁在一起」。",
	},
	routine_manage: {
		name: "routine_manage",
		readOnly: false,
		destructive: true,
		sideEffectScope: "workspace",
		riskLevel: "high",
		needsApproval: "critical",
		concurrentSafe: true,
		notes: "自建常驻自主轮；与 partner_manage 同档，第一次要人点头。",
	},

	// ── 课题 / 搜索 / 递话 ─────────────────────────────────
	web_search: {
		name: "web_search",
		readOnly: true,
		destructive: false,
		sideEffectScope: "external",
		riskLevel: "low",
		needsApproval: "never",
		concurrentSafe: true,
		notes: "纯网络读；出网但无本地副作用。",
	},
	propose_topic: {
		name: "propose_topic",
		readOnly: false,
		destructive: false,
		sideEffectScope: "memory",
		riskLevel: "low",
		needsApproval: "never",
		concurrentSafe: true,
		notes: "只写内部课题提议表；语义同 remember，不进闸门。",
	},
	send_to_agent: {
		name: "send_to_agent",
		readOnly: false,
		destructive: false,
		sideEffectScope: "external",
		riskLevel: "medium",
		needsApproval: "critical",
		concurrentSafe: false,
		notes: "给另一个执事递话（会起对方一轮、烧 token）；不写盘不起进程，边界在通道闸。",
	},

	// ── 未来（本批之后的 ask_user，先登记口径）───────────────
	ask_user: {
		name: "ask_user",
		readOnly: false,
		destructive: false,
		sideEffectScope: "none",
		riskLevel: "low",
		needsApproval: "never",
		concurrentSafe: false,
		notes: "向用户提问并等回答；不改任何外部状态，但一轮里只能挂一个提问。",
	},
};

export function capabilityOf(name: string): ToolCapability | undefined {
	return TOOL_CAPABILITIES[name];
}

/** 声明表里的工具名（测试与后续批次用；不参与运行时判定）。 */
export function declaredToolNames(): string[] {
	return Object.keys(TOOL_CAPABILITIES).sort();
}
