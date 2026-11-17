/**
 * 定时主动轮的到点实现（2026-11-17）。
 *
 * 由 index.ts 装配时注入 scheduled-run-deliverer 的回调槽。单独成文件是为了解环：
 * 这里可以放心 import runPartnerTurn（它在 agent → lifecycle-harness → reminder 下游），
 * 而 reminder.ts 只认无依赖的回调槽，不反过来 import 本文件。
 */

import { PROACTIVE_HIDDEN_MARKER } from "@lifediary/shared";
import { CHIEF_PARTNER_ID } from "./partner-contract.ts";
import { partnersStore } from "./partners.ts";
import { runPartnerTurn } from "./partner-runtime.ts";
import { setScheduledRunHandler, type ScheduledRunInput } from "./scheduled-run-deliverer.ts";

/** 目标执事：显式指定 → 建任务的会话所属执事 → 兜底总管。 */
function resolvePartnerId(input: ScheduledRunInput): string {
	if (input.partnerId) return input.partnerId;
	const fromSession = partnersStore().partnerIdOfSession(input.conversationId);
	return fromSession ?? CHIEF_PARTNER_ID;
}

/** 装配注入：到点让目标执事跑一轮自主模型；可见触发原样保留，隐藏触发加标记。 */
export function installScheduledRunHandler(): void {
	setScheduledRunHandler(async (input) => {
		const partnerId = resolvePartnerId(input);
		// 触发指令：默认加隐藏标记；2026-11-17 定时任务重做后，手动新建可选"可见"，
		// 这时正文就是用户写的那段话。runPartnerTurn 会再拼 autonomous 透明头，
		// 模型靠它知道"自主"；隐藏/可见只影响回读展示，不影响模型上下文。
		const prompt = input.visible ? input.text : `${PROACTIVE_HIDDEN_MARKER}\n${input.text}`;
		const result = await runPartnerTurn(partnerId, prompt, {
			authority: "autonomous",
			sessionMode: "persistent",
			// 到点就是要"主动说一句"，接住任务就是产出——不适用例行轮的安静契约
			// （同派活唤醒口径）；否则执事一句短话会被判 quiet 剔除，界面只剩空回复。
			quiet: false,
		});
		if (!result.ok) {
			console.warn(`[scheduled-run] 会话 ${input.conversationId} 到点跑模型失败: ${result.error ?? "未知原因"}`);
		}
		// 把结果交回 reminder.deliver / run_now 端点记账；错误原文只留在上面的服务端日志。
		return { ok: result.ok, text: result.text, error: result.ok ? undefined : "这一轮没跑完" };
	});
}
