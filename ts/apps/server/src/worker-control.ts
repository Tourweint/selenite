/**
 * worker 控制面窄桥（2026-11-22 调度层与执行器池合并方案 §5.3 / M0）。
 *
 * 为什么存在：本机派活统一走 pool 之后，取消 / 插话 / 上报答复都落在 supervisor
 * 的 HTTP 通道。这里按 `ticket.employee` 收成一处窄接口，不把 supervisor 的大类型
 * 传到各调用点；外部 CLI 没有注入口，如实回失败。
 *
 * 2026-11-23：native（子进程 stdin 与进程注册表）退役；历史 ticket 里的
 * `employee:"native"` / 没有 employee 字段的老单，一律按 pool 处理。
 *
 * 依赖方向：server 可以 import chancellor；本文件不 import index.ts（避免环）。
 */

import type { EmployeeKind } from "../../../packages/chancellor/src/types.ts";

/** 池控制面只要这两个方法（supervisor.ts 的 WorkerPoolSupervisor 满足它）。 */
export interface PoolControl {
	abort(ticketId: string): Promise<{ ok: boolean; message?: string }>;
	say(
		ticketId: string,
		text: string,
		mode: "steer" | "followUp",
	): Promise<{ ok: boolean; message?: string }>;
}

export interface WorkerControlResult {
	ok: boolean;
	message?: string;
}

let poolControl: PoolControl | null = null;

/** 宿主启动时接线（index.ts），与 setPoolClient 并排；传 null 摘线（测试用）。 */
export function setPoolControl(next: PoolControl | null): void {
	poolControl = next;
}

/**
 * 每票的 AbortController（M0）。
 *
 * 只由"取消这张单"触发，不跟聊天轮次结束挂钩：取消 → abortTicket → controller.abort()
 * → 经 supervisor.run（池）/ 外部 CLI employee.run 的 callerSignal 停掉执行器。
 */
const ticketAborts = new Map<string, AbortController>();

export function registerTicketAbort(ticketId: string, controller: AbortController): void {
	ticketAborts.set(ticketId, controller);
}

export function unregisterTicketAbort(ticketId: string, controller?: AbortController): void {
	// 续跑 / 重派同一张单会有多个 startDelegation；带 controller 时只摘自己那一个，
	// 免得先结算的旧轮把新轮刚注册的控制器删掉。
	if (controller && ticketAborts.get(ticketId) !== controller) return;
	ticketAborts.delete(ticketId);
}

/** 中止这张单；没有注册的控制器（已结算 / 旧进程）返回 false，由调用方如实记一行。 */
export function abortTicket(ticketId: string): boolean {
	const controller = ticketAborts.get(ticketId);
	if (!controller) return false;
	ticketAborts.delete(ticketId);
	controller.abort();
	return true;
}

/**
 * 没有票级控制器时的池回落（2026-11-22）：manager 子进程内部建的子单，
 * 宿主没有它的 AbortController，但票在宿主 supervisor 的槽位表里——
 * 直接按单号发 `/run/:id/abort`。异步、不挡作废主流程；失败只记枚举式日志。
 */
export function abortPoolTicket(ticketId: string): void {
	if (!poolControl) return;
	void poolControl
		.abort(ticketId)
		.then((result) => {
			if (result.ok) {
				console.log(`[ticket] 池取消已送达 ticket=${ticketId.slice(0, 12)}`);
			} else {
				console.log(
					`[ticket] 池取消未送达 ticket=${ticketId.slice(0, 12)} reason=${
						result.message ? result.message.slice(0, 120) : "unknown"
					}`,
				);
			}
		})
		.catch(() => {
			console.log(`[ticket] 池取消请求异常 ticket=${ticketId.slice(0, 12)}`);
		});
}

/**
 * 按执行器把一句话送进正在跑的 worker（插话 / 上报答复共用）。
 *
 * - pool（含历史 native / 没有 employee 字段的老单）：走宿主注入了 supervisor 的
 *   PoolControl.say；池里没有这张单时如实回失败；
 * - 外部 CLI / MCP / 手机等：没有注入口，如实返回错误，不假装已送达。
 */
export async function sayWorker(
	employee: EmployeeKind | undefined,
	ticketId: string,
	text: string,
	mode: "steer" | "followUp",
): Promise<WorkerControlResult> {
	// 历史 ticket.json 里可能还是 "native"（2026-11-23 退役），类型上不在 EmployeeKind 里；
	// 老 ticket（2026-11-16 多执行器之前）甚至没有 employee 字段——两者都按 pool 处理。
	const kind: string | undefined = employee;
	if (kind === undefined || kind === "native" || kind === "pool") {
		if (!poolControl) {
			return { ok: false, message: "池执行器未接线：宿主没有注入 PoolControl" };
		}
		return poolControl.say(ticketId, text, mode);
	}
	return { ok: false, message: "外部 CLI 打手没有注入口" };
}
