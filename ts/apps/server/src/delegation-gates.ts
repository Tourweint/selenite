/**
 * 闸门与开关（取消 / 群发 / 打手插话）
 *
 * 2026-11-13 从 delegation-api.ts 的 L1–L130 整段切出；正文原文搬运，未改一行实现。
 */

export function delegationCancelEnabled(): boolean {
	const raw = (process.env.DELEGATION_CANCEL?.trim() || "true").toLowerCase();
	return raw !== "false" && raw !== "0";
}

export function fanoutGroupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env.DELEGATION_FANOUT_GROUP ?? "").trim().toLowerCase();
	if (!raw) return true;
	return raw !== "false" && raw !== "0" && raw !== "off";
}

/**
 * worker 插话通道（2026-11-19 插话统一 批1）。缺省开；
 * `WORKER_STEER_ENABLED=false` / `0` / `off` → 通道下架：
 * `POST /agent/delegations/:ticketId/message` 一律 400、`send_to_agent` 不注入
 * mode 参数与单号目标（工具保持改动前的形态），本机池照常起跑。
 */
export function workerSteerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env.WORKER_STEER_ENABLED ?? "").trim().toLowerCase();
	if (!raw) return true;
	return raw !== "false" && raw !== "0" && raw !== "off";
}

