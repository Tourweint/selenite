/**
 * 自主轮高危工具表（2026-11-05 批次C C2，cindy taskActionRisk 的本仓映射）。
 *
 * cindy 六类里**结构上可达**的三类在本仓的映射：
 *   - 调度命令 / 授予常驻指令 → `set_reminder`（定时唤醒是常驻载体的现成形态）；
 *   - 新建完全访问任务 / 建停常驻角色 → `delegate` / `propose_project` / `partner_manage` / `group_manage`；
 *   - 写文件 / 跑命令 → `write` / `edit` / `bash` / `powershell` / `partner_skill_write`
 *     （现行 ask 面在自主轮收紧为必问）。
 *
 * **结构上不可达的三类**（工具不存在，模型够不着）："删除自动化"、"恢复暂停执行"、
 * routine 管理——将来给模型开 routine 工具时必须**先**加进这张表（D14 备忘）。
 * 批次D D3 的 `partner_manage`（建 / 停执事）上架前已先登记在此，D14 备忘随之兑现。
 * "代主人回答权限请求"的等效实现更严：自主轮的审批一律转全局待办、禁"记住"。
 */

export type AutonomyRiskCategory = "schedule" | "new_task" | "write";

export const AUTONOMY_RISK_TOOLS: Record<string, AutonomyRiskCategory> = {
	set_reminder: "schedule",
	delegate: "new_task",
	propose_project: "new_task",
	partner_manage: "new_task",
	group_manage: "new_task",
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
