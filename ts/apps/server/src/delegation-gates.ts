/**
 * 闸门与开关（取消 / 票据门 / 群发开关 / 剪辑说明 / 门位投影）
 *
 * 2026-11-13 从 delegation-api.ts 的 L1–L130 整段切出；正文原文搬运，未改一行实现。
 */

export function delegationCancelEnabled(): boolean {
	const raw = (process.env.DELEGATION_CANCEL?.trim() || "true").toLowerCase();
	return raw !== "false" && raw !== "0";
}

export function ticketGatesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env.TICKET_GATES ?? "").trim().toLowerCase();
	if (!raw) return true;
	return raw !== "false" && raw !== "0" && raw !== "off";
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
 * mode 参数与单号目标（工具保持改动前的形态），native 子进程照常起跑。
 */
export function workerSteerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env.WORKER_STEER_ENABLED ?? "").trim().toLowerCase();
	if (!raw) return true;
	return raw !== "false" && raw !== "0" && raw !== "off";
}

export interface TicketGate {
	name: string;
	passed: boolean;
	note?: string;
}

function clipNote(text: string, max = 80): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function buildTicketGates(input: {
	reviews: Array<{ slug?: unknown; verdict?: unknown; reason?: unknown }>;
	judgeCalls?: Array<{ round?: unknown; verdict?: unknown; reason?: unknown }>;
	repairRound?: number;
	judgeOn?: boolean;
}): TicketGate[] {
	const gates: TicketGate[] = [];
	for (const review of input.reviews) {
		const slug = String(review.slug ?? "").trim();
		const verdict = String(review.verdict ?? "").trim();
		const reason = String(review.reason ?? "").trim();
		gates.push({
			name: slug ? `验收：${slug}` : "验收",
			passed: verdict === "pass",
			...(reason ? { note: clipNote(reason) } : {}),
		});
	}
	if (input.judgeOn && input.judgeCalls && input.judgeCalls.length > 0) {
		const last = input.judgeCalls[input.judgeCalls.length - 1]!;
		const verdict = String(last.verdict ?? "").trim();
		const reason = String(last.reason ?? "").trim();
		const round = Number(last.round);
		const note = [Number.isFinite(round) && round > 0 ? `第 ${round} 轮` : "", verdict, reason]
			.filter(Boolean)
			.join(" · ");
		gates.push({
			name: "裁判",
			passed: verdict === "done",
			...(note ? { note: clipNote(note) } : {}),
		});
	}
	const repairRound = Number(input.repairRound);
	if (Number.isInteger(repairRound) && repairRound > 0) {
		gates.push({ name: "返工", passed: true, note: `已返工 ${repairRound} 轮` });
	}
	return gates;
}

export function acceptanceChecksEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env.DELEGATION_ACCEPTANCE_CHECKS ?? "").trim().toLowerCase();
	if (!raw) return true;
	return raw !== "false" && raw !== "0" && raw !== "off";
}

export { clipNote };
