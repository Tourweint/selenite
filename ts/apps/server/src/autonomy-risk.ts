/**
 * 自主轮高危工具表（2026-11-05 批次C C2，cindy taskActionRisk 的本仓映射）。
 *
 * cindy 六类里**结构上可达**的三类在本仓的映射：
 *   - 调度命令 / 授予常驻指令 → `set_reminder`（定时唤醒是常驻载体的现成形态）；
 *   - 新建完全访问任务 / 建停常驻角色 → `delegate` / `propose_project` / `partner_manage` / `group_manage`；
 *   - 写文件 / 跑命令 → `write` / `edit` / `bash` / `powershell` / `partner_skill_write`
 *     （现行 ask 面在自主轮收紧为必问）。
 *
 * **结构上不可达的两类**（工具不存在，模型够不着）："删除自动化"、"恢复暂停执行"。
 * "routine 管理"于 2026-11-08 刀二 E4 落地为 `routine_manage`（执事自建巡逻）：
 * **上架前已先登记在此**（D14 备忘兑现），自主轮里一律强制 ask、禁"记住"绕过——
 * 让模型在后台自主跑轮的事，第一次必须人点头。
 * 批次D D3 的 `partner_manage`（建 / 停执事）同理。
 * "代主人回答权限请求"的等效实现更严：自主轮的审批一律转全局待办、禁"记住"。
 */

export type AutonomyRiskCategory = "schedule" | "new_task" | "write";

export const AUTONOMY_RISK_TOOLS: Record<string, AutonomyRiskCategory> = {
	set_reminder: "schedule",
	delegate: "new_task",
	propose_project: "new_task",
	partner_manage: "new_task",
	group_manage: "new_task",
	// 执事自建巡逻（刀二 E4）：新建常驻自主轮，与 partner_manage 同档。
	routine_manage: "new_task",
	write: "write",
	edit: "write",
	bash: "write",
	powershell: "write",
	partner_skill_write: "write",
};

export interface AutonomyRiskVerdict {
	/** true = 自主轮里这个工具必须弹卡（强制 ask，禁"记住"） */
	forceAsk: boolean;
	category?: AutonomyRiskCategory;
}

export function autonomyRiskVerdict(tool: string, autonomous: boolean): AutonomyRiskVerdict {
	if (!autonomous) return { forceAsk: false };
	const category = AUTONOMY_RISK_TOOLS[tool];
	return category ? { forceAsk: true, category } : { forceAsk: false };
}

// ── 自动化永不扩权（2026-11-09 T2 §4，红线口径）────────────────
//
// 口径：例行任务 / 自建巡逻 / 自主轮**永远不能超过发起者本人的权限**。
// C2 的"高危工具强制 ask"只是"要人点头"；这里补的是**结构性拒绝**：
// 模型在后台跑的时候，不能给自己新建常驻自动化、不能给别的执事发指令、不能遥控设备。
// 不是 ask，是 block——ask 还能被点批准，block 连门都没有。

/** 自主轮里结构性拒绝的工具（自己给自己扩权的四种形态）。 */
export const AUTONOMY_NO_ESCALATION_TOOLS = new Set([
	"routine_manage",
	"partner_manage",
	"group_manage",
	"send_to_agent",
]);

/** 回滚开关：`AUTONOMY_NO_ESCALATION=false`（或 0/off）→ 回滚到本批前行为。默认开。 */
export function autonomyNoEscalationEnabled(): boolean {
	const raw = process.env.AUTONOMY_NO_ESCALATION?.trim().toLowerCase();
	if (!raw) return true;
	return raw !== "false" && raw !== "0" && raw !== "off";
}

/**
 * 自主轮结构性拒绝的理由；undefined = 放行。
 * 非自主轮**完全不看这张表**（普通轮行为逐字节不变）。
 */
export function autonomyEscalationBlockReason(
	tool: string,
	args: unknown,
	autonomous: boolean,
	enabled: boolean = autonomyNoEscalationEnabled(),
): string | undefined {
	if (!autonomous || !enabled) return undefined;
	if (AUTONOMY_NO_ESCALATION_TOOLS.has(tool)) {
		return `自动化不能给自己扩权：自主轮里不能调用 ${tool}（建/停常驻任务、给别的执事递话都算扩权）`;
	}
	if (tool === "delegate") {
		const input = (args ?? {}) as { targetDevice?: unknown; project?: unknown; resume?: unknown };
		if (typeof input.targetDevice === "string" && input.targetDevice.trim()) {
			return "自动化不能给自己扩权：自主轮里不能遥控别的设备（去掉 targetDevice 再派）";
		}
		// 续跑沿用原单项目，可以不带；新派必须带 project。
		if (input.resume !== true) {
			const project = typeof input.project === "string" ? input.project.trim() : "";
			if (!project) {
				return "自动化不能给自己扩权：自主轮里派新活必须带 project（续跑可沿用原单项目）";
			}
		}
	}
	return undefined;
}
