/**
 * token 估算（2026-11-16，设置 → 上下文）
 *
 * 口径：CJK 字符 ≈ 1 token / 字，其它（拉丁 / 数字 / JSON 标点 / 空白）≈ 1 token / 4 字符。
 * 为什么不用内核 `estimateTextTokens`（chars / 3.5）：中文会低报约 2/3，页面会误导；
 * 为什么不接真 tokenizer：接入的模型来自多家，词表只对其中一家准，页面只需要看占比。
 * 2026-11-16 对 cl100k 校准：中文段 -14%、紧凑工具 JSON -5%、英文技能索引 +8%，合计 -5%。
 */

const CJK_CHAR =
	/[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/;

const ASCII_CHARS_PER_TOKEN = 4;

/** 估算一段文本的 token 数；空串为 0。 */
export function estimateTokens(text: string): number {
	if (!text) return 0;
	let cjk = 0;
	let other = 0;
	for (const char of text) {
		if (CJK_CHAR.test(char)) cjk += 1;
		else other += 1;
	}
	return Math.ceil(cjk + other / ASCII_CHARS_PER_TOKEN);
}
