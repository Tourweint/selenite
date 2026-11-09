/**
 * 例行轮安静契约（2026-11-09 主动性与例行 T2 §2）。
 *
 * 例行任务"没话说"时不该硬写一条"一切正常"。判定必须是**确定性**的
 * （不调模型、不用关键词判状态——lossless-claw 的 401 误伤就是关键词判出来的）：
 *   去空白后长度 < 阈值，且不含数字 / 链接 / 日期 → quiet。
 * 模型侧另给一个显式出口 `[[no-update]]`（提示词尾部有说明），收到就按 quiet 处理，
 * 并把标记从产出里剔除（标记本身不写进下游文本）。
 *
 * 单独成文件：纯函数可单测，不 import agent/durable（与 cron.ts 同一纪律）。
 */

export const NO_UPDATE_MARKER = "[[no-update]]";
/** 例行轮提示词尾部的一行（固定字节，不含动态内容）。 */
export const ROUTINE_QUIET_INSTRUCTION =
	"如果这一轮确实没有值得报告的内容，回复 [[no-update]] 且不要做任何别的动作。";
const DEFAULT_MIN_CHARS = 40;

/** 回滚开关：`ROUTINE_QUIET=false`（或 0/off）→ 回到"总是按有内容处理"。默认开。 */
export function routineQuietEnabled(): boolean {
	const raw = process.env.ROUTINE_QUIET?.trim().toLowerCase();
	if (!raw) return true;
	return raw !== "false" && raw !== "0" && raw !== "off";
}

/** 安静阈值（字符数，去空白后）；非法值回落 40。 */
export function routineQuietMinChars(): number {
	const raw = Number(process.env.ROUTINE_QUIET_MIN_CHARS);
	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MIN_CHARS;
}

export interface RoutineOutputVerdict {
	quiet: boolean;
	/** 剔掉 `[[no-update]]` 之后的产出（trim 过） */
	text: string;
}

/**
 * 判定一轮例行产出是否"没有实质内容"。**只做确定性规则**：
 *   - 带 `[[no-update]]` → 一定 quiet（模型显式说了没更新）；
 *   - 去空白后长度 ≥ 阈值 → 有内容；
 *   - 短文本含数字 / 链接 / 日期 → 有内容（"3 条新消息""2026-11-09 有发布"）。
 * 不按"无事发生""一切正常"这类词判状态：换个说法就漏，误伤一个就全错。
 */
export function assessRoutineOutput(raw: string): RoutineOutputVerdict {
	const hasMarker = raw.includes(NO_UPDATE_MARKER);
	const text = raw.split(NO_UPDATE_MARKER).join("").trim();
	if (hasMarker) return { quiet: true, text };
	const compact = text.replace(/\s+/g, "");
	if (compact.length === 0) return { quiet: true, text: "" };
	if (compact.length >= routineQuietMinChars()) return { quiet: false, text };
	const hasSignal =
		/[0-9０-９]/.test(text) ||
		/(https?:\/\/|www\.)/i.test(text) ||
		/\d{4}\s*[-/.年]\s*\d{1,2}/.test(text) ||
		/\d{1,2}\s*月\s*\d{1,2}\s*日/.test(text);
	return { quiet: !hasSignal, text };
}

/**
 * 带工具错误语境的安静判定（2026-11-10 批 21 §三，七 #40 的"读失败不当无新"）。
 *
 * 本轮有任何工具报错时，"看起来没内容"不能当安静吞掉——读源失败 ≠ 没有更新，
 * 宁可多报一次，不把读失败说成"无新"（OpenMausBot 游标纪律的运行层对应物；
 * 触发层的游标已由三门"触发时才写基线"管住，这里管产出层）。
 * 工具报错只压 quiet，不反向制造 quiet；非 quiet 判定原样返回。
 */
export function assessRoutineOutputGuarded(
	raw: string,
	toolErrorCount: number,
): RoutineOutputVerdict {
	const verdict = assessRoutineOutput(raw);
	if (verdict.quiet && toolErrorCount > 0) return { quiet: false, text: verdict.text };
	return verdict;
}
