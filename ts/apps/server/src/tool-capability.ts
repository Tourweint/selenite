/**
 * 工具能力声明（2026-11-09 任务书 T3 §1；2026-11-10 批 21 §一 起接管审批判定）。
 *
 * 2026-11-09 那批做的是「**登记，不是接管**」：把每个已注册工具的口径显式写成一份可测的声明，
 * 让「谁写盘、谁起进程、谁要人点头」从散落在 `WRITE_TOOLS` / `DEFAULT_CRITICAL_TOOLS`
 * / 注释里的隐性知识，变成一张表 + 单测断言。
 *
 * 2026-11-10 批 21：**审批判定已读本表**（`approval-policy.ts` 的 `needsApproval()`）：
 *   - `destructive` 承担 `WRITE_TOOLS` 在审批里的角色（`ask-all` 的问法）；
 *   - `needsApproval === "critical"` 承担 `DEFAULT_CRITICAL_TOOLS` 的角色；
 *   - `AGENT_APPROVAL_CRITICAL_TOOLS` / 调用方显式清单仍然整体覆盖（人配的优先）；
 *   - 表里没有的工具按最严处理（destructive + critical）并 warn 一次。
 * **零行为变更**：两个集合与老清单逐项等值，由 `tool-capability.test.ts` 双向断言。
 * `readOnlyBlockReason()`（只读档的能力边界）仍读 `WRITE_TOOLS`——那是与审批正交的另一条轴。
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
		notes: "读文件，纯读；受限两档（只读 / 在工作区内修改）也走 path-guard 限根，完全访问不限（2026-11-20）。",
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
	// 低频工具索引（2026-11-16 C 段）：只改会话工具面，不进 WRITE_TOOLS。
	tool_search: {
		name: "tool_search",
		readOnly: true,
		destructive: false,
		sideEffectScope: "none",
		riskLevel: "low",
		needsApproval: "never",
		concurrentSafe: true,
		notes: "只把已注册的延迟工具加载进本会话工具面；不动工作区、不起进程、不写盘。",
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
	persona_recall: {
		name: "persona_recall",
		readOnly: false,
		destructive: true,
		sideEffectScope: "process",
		riskLevel: "medium",
		needsApproval: "never",
		concurrentSafe: true,
		notes: "经固定 ask.py 起 python 子进程查 persona 记忆库；命令拼死、argv 传参，只读查询但按硬约束进闸门，不进高危清单。",
	},
	persona_write: {
		name: "persona_write",
		readOnly: false,
		destructive: true,
		sideEffectScope: "external",
		riskLevel: "high",
		needsApproval: "critical",
		concurrentSafe: true,
		notes: "经固定 repair.py 起 python 子进程往主人一生库写 user_statement（主人明确让写才用）；每写必弹审批（critical），命令拼死、argv 传参，按硬约束进 WRITE_TOOLS + 高危清单。",
	},

	// ── 搜索 / 递话 ───────────────────────────────────────
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

	// ── 决策上报答复（2026-11-19 批2：worker→总管→用户上报链）──
	respond_escalation: {
		name: "respond_escalation",
		readOnly: false,
		destructive: false,
		sideEffectScope: "none",
		riskLevel: "low",
		needsApproval: "never",
		concurrentSafe: false,
		notes:
			"答复工人上报：经批1 插话通道投一条答复回 worker，或把问题升级成 ask 卡；不写盘、不起进程、不派活。",
	},

	// ── 中途播报（2026-11-10 批 13 §三）──────────────────────
	report_progress: {
		name: "report_progress",
		readOnly: false,
		destructive: false,
		sideEffectScope: "none",
		riskLevel: "low",
		needsApproval: "never",
		concurrentSafe: true,
		notes: "中途对主人说一句（notice 帧，不结束本轮）；不落盘、不写时间线，没开流就收不到。",
	},
	save_skill_advice: {
		name: "save_skill_advice",
		readOnly: false,
		destructive: false,
		sideEffectScope: "workspace",
		riskLevel: "low",
		needsApproval: "never",
		concurrentSafe: false,
		// 批 30 修订：只写建议快照（.data/skills-advice.json），不碰启停位——
		// 采纳是人的动作（设置页 PUT）。原子写，坏不了技能目录。
		notes: "技能分类建议落盘：写建议快照；启停位不动，采纳由人在设置页决定。",
	},
	// 提醒沉淀（2026-11-19 批4）：只写建议快照（.data/reminder-advice.json），不碰记忆库——
	// 偏好写入只发生在人采纳时（记忆页 PUT，D18：只建议、人采纳）。
	save_reminder_advice: {
		name: "save_reminder_advice",
		readOnly: false,
		destructive: false,
		sideEffectScope: "workspace",
		riskLevel: "low",
		needsApproval: "never",
		concurrentSafe: false,
		notes: "提醒沉淀建议落盘：写建议快照；记忆库不动，采纳由人在记忆页决定。",
	},
};

export function capabilityOf(name: string): ToolCapability | undefined {
	return TOOL_CAPABILITIES[name];
}

/** 声明表里的工具名（测试与后续批次用；不参与运行时判定）。 */
export function declaredToolNames(): string[] {
	return Object.keys(TOOL_CAPABILITIES).sort();
}
