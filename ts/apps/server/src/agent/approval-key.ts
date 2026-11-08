import { createHash } from "node:crypto";

/**
 * 审批参数指纹（2026-11-08 扫尾批 8c）。
 *
 * 用途：一次性放行清单按「工具 + 参数指纹」匹配。模型批准后重发的是**同一个调用**，
 * 但内核给的 callId 是新的 —— 所以不能拿 callId 当匹配键，只能拿"工具 + 参数"。
 * 换个参数重发就不命中，重新走审批（防"批了 A 执行 B"）。
 *
 * 序列化必须**稳定**：同一份参数、键序不同也要得到同一个指纹。工具参数本身从 JSON 来，
 * 这里只处理 JSON 能表达的形状；函数 / Symbol / 循环引用这类"没法指纹"的输入返回空串，
 * 空指纹永远不匹配放行清单 —— 宁可多问一次，也不误放。
 */

/** 递归把值折成"键排好序"的 JSON 形状；undefined 在对象里删键、在数组里变 null（同 JSON.stringify） */
function canonical(value: unknown, seen: Set<object>): unknown {
	if (value === null) return null;
	const type = typeof value;
	if (type === "string" || type === "boolean") return value;
	if (type === "number") return Number.isFinite(value as number) ? value : null;
	if (type === "bigint") return String(value);
	if (type !== "object") return undefined;
	const object = value as object;
	if (seen.has(object)) throw new Error("circular");
	seen.add(object);
	try {
		if (Array.isArray(object)) {
			return object.map((item) => {
				const next = canonical(item, seen);
				return next === undefined ? null : next;
			});
		}
		if (object instanceof Date) return object.toISOString();
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(object as Record<string, unknown>).sort()) {
			const next = canonical((object as Record<string, unknown>)[key], seen);
			if (next !== undefined) out[key] = next;
		}
		return out;
	} finally {
		seen.delete(object);
	}
}

/** 稳定序列化：键排序、递归；无法表示时返回空串（调用方据此判"不能指纹"） */
export function stableStringify(value: unknown): string {
	try {
		const text = JSON.stringify(canonical(value, new Set()));
		return text ?? "";
	} catch {
		return "";
	}
}

/** 参数指纹 = 稳定序列化后 sha256（hex）。空 = 这份参数不能指纹，永不放行 */
export function approvalArgsHash(args: unknown): string {
	const text = stableStringify(args ?? {});
	if (!text) return "";
	return createHash("sha256").update(text).digest("hex");
}
