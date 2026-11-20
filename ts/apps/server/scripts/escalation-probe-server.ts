/**
 * 决策上报链探针的**服务入口替身**（2026-11-19 批2）。
 *
 * 为什么需要替身：faux 模式下 chancellor 的拆单没有真实内部模型（internal-model.ts
 * 在 faux 下明确失败），探针里整条派单链就止步于"拆单失败"。本文件在真服务
 * （src/index.ts）启动前注入一个**确定性内部模型**：
 * - 拆单：第一次给一个单任务计划（writes 为空，只读任务），此后一律失败
 *   （上限防连环派单：上报唤醒的代答轮会再派一单，计划失败即断链）；
 * - 验收 / 目标核对：**2026-11-19 已整体删除**（宿主只做执行结果判定），
 *   下面的替身分支仅保留兼容，不会被执行。
 * 其余全部走真链路：真 durable、真 native worker 子进程、真 HTTP、真上报路由。
 *
 * 只给探针用：不注册任何对外路由，正常启动入口仍是 src/index.ts。
 */
import type { QoderCall } from "../../../packages/chancellor/src/dispatch.ts";
import type { QoderResult } from "../../../packages/chancellor/src/types.ts";
import { setInternalAsk } from "../../../packages/chancellor/src/index.ts";

let planCalls = 0;

function result(text: string): QoderResult {
	return { ok: true, result: text, sessionId: null, isError: false, permissionDenials: 0, exitCode: 0, timedOut: false, aborted: false, stderrTail: "", error: null };
}

/** 探针替身：拆单只放行第一单（其余失败断链），验收 pass、目标核对达成。 */
async function stubAsk(call: QoderCall): Promise<QoderResult> {
	if (call.label === "plan") {
		planCalls += 1;
		if (planCalls > 1) {
			// 上报唤醒的代答轮会再次派单：计划失败 = 这单走 needs_you、不派 worker、
			// 也就不会 escalation——探针链到此断开，不无限循环。
			return result("拆单失败（探针节流：只放行第一单）");
		}
		return result(
			"```json\n" +
				JSON.stringify({
					tasks: [
						{
							slug: "escalate-probe",
							title: "上报探针任务",
							instruction:
								"读 TASK.md，按它做。遇到要拍板的事调 escalate 上报，等答复后继续，最后把 REPORT.md 写成终态。",
							done_when: "REPORT.md 里给出终态结论",
							dependsOn: [],
							writes: [],
						},
					],
				}) +
				"\n```",
		);
	}
	if (call.label.startsWith("review-")) {
		return result('```json\n{"verdict":"pass","reason":"探针内部验收：通过"}\n```');
	}
	if (call.label === "goal") {
		return result('```json\n{"satisfied":true,"reason":"探针目标核对：达成"}\n```');
	}
	return result('```json\n{"verdict":"pass","reason":"探针内部模型：缺省通过"}\n```');
}

// 真服务入口（副作用导入：起 HTTP、装配 harness）。
await import("../src/index.ts");
// **必须在真入口之后注入**：index.ts 启动段会调 installInternalAsk() 覆盖缝，
// 先注入会被它盖掉（探针首跑踩过：拆单失败 faux 模式没有内部模型）。
setInternalAsk(stubAsk);
