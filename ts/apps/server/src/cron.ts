/**
 * 极简 cron（2026-11-05 批次B B3）：5 段（分 时 日 月 周），支持 * , - / 数字。
 * 从 routines.ts 抽成纯文件的原因：单测要无副作用地直接测——routines.ts 连着
 * partner-runtime → agent 的装配链，import 它等于顺手建记忆库（红线：不碰 .data/）。
 * 不追求完整 POSIX 语义：够例行任务的表达，解析不了的字段一律判不匹配（宁可不动）。
 */

export function cronMatches(expr: string, date: Date): boolean {
	const fields = expr.trim().split(/\s+/);
	if (fields.length !== 5) return false;
	const values = [date.getMinutes(), date.getHours(), date.getDate(), date.getMonth() + 1, date.getDay()];
	const ranges: Array<[number, number]> = [
		[0, 59],
		[0, 23],
		[1, 31],
		[1, 12],
		[0, 7],
	];
	for (let i = 0; i < 5; i += 1) {
		if (!fieldMatches(fields[i] as string, values[i] as number, ranges[i] as [number, number])) {
			return false;
		}
	}
	return true;
}

function fieldMatches(field: string, value: number, range: [number, number]): boolean {
	for (const part of field.split(",")) {
		const [body, stepRaw] = part.split("/");
		const step = stepRaw === undefined ? 1 : Number(stepRaw);
		if (!Number.isInteger(step) || step <= 0) return false;
		let lo: number;
		let hi: number;
		if (body === "*" || body === "?") {
			[lo, hi] = range;
		} else if (body.includes("-")) {
			const [a, b] = body.split("-").map(Number);
			if (!Number.isInteger(a) || !Number.isInteger(b)) return false;
			lo = a;
			hi = b;
		} else {
			const n = Number(body);
			if (!Number.isInteger(n)) return false;
			lo = hi = n;
		}
		if (value < lo || value > hi) continue;
		if ((value - lo) % step === 0) return true;
	}
	return false;
}

/** 下一次 cron 命中（从 from 的下一分钟起逐分钟扫，上限 366 天）。表达式非法返回 null。 */
export function nextCronFire(expr: string, from: Date): Date | null {
	if (expr.trim().split(/\s+/).length !== 5) return null;
	const cursor = new Date(from.getTime());
	cursor.setSeconds(0, 0);
	const limit = new Date(from.getTime() + 366 * 24 * 60 * 60_000);
	while (cursor <= limit) {
		cursor.setMinutes(cursor.getMinutes() + 1);
		if (cronMatches(expr, cursor)) return new Date(cursor.getTime());
	}
	return null;
}
