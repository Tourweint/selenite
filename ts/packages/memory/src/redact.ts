/**
 * 记忆落盘前的凭据打码（2026-11-09 T4 §2）。
 *
 * 记忆是"写一次、到处被想起"的东西：一句 `我的 key 是 sk-…` 一旦入库，
 * 以后每一轮相关对话都可能把它的片段带进 prompt。写入时打掉一次，
 * 比在召回、导出、日志三处各防一次可靠。
 *
 * 口径（任务书 §2.1）：
 *   - 打码对象：API key / token / 密码 / 长随机串（base64 / hex）。
 *   - **故意放行**：手机号、生日、地址、人名——这些是日记该记住的事实，
 *     不是敏感物。反例只在"明显无害"的形态上放行（任务书铁律 3）。
 *   - 纯函数、零依赖：不读时钟、不读 env、不抛错。开关由调用方（store）传。
 *
 * 为什么保留标签（`password=«redacted»`）而不是整段替换成 «redacted»：
 * 读记忆的人仍需要知道"这里原来记的是一个密码字段"，只是不该看到值。
 */

/** 打码后的占位符。刻意用书名号：中文正文里几乎不可能自然出现。 */
export const REDACTED = "«redacted»";

/** `MEMORY_REDACT` 开关：默认开；只有明确写 false / 0 才关（回滚一行）。 */
export function memoryRedactEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env.MEMORY_REDACT?.trim().toLowerCase();
	if (!raw) return true;
	return raw !== "false" && raw !== "0";
}

/**
 * 带字段名的形态：`api_key=…` / `token: …` / `密码：…`。
 *
 * 保留前半截（字段名与分隔符），只把值换成占位符。值里排掉中文标点，
 * 避免把「密码：abc123。」的句号一起吃进占位符。
 */
const KEYED_RULES: RegExp[] = [
	// 英文标签：api_key / api-key / apikey / access_token / token / secret / password / passwd / pwd
	/((?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd)\s*[:=]\s*)([^\s，。；、！？,;]+)/gi,
	// 中文标签：密码 / 口令 / 令牌 / 密钥
	/((?:密码|口令|令牌|密钥)\s*[:=：]\s*)([^\s，。；、！？,;]+)/g,
];

/**
 * 裸露的凭据形态：没有字段名，靠自身的形状识别。
 * 顺序在 KEYED_RULES 之后：先保标签，再吃剩下的。
 */
const BARE_RULES: Array<{ pattern: RegExp; replacement: string }> = [
	// Bearer 头：保留 "Bearer " 前缀，客户端仍能看出认证方式
	{ pattern: /(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, replacement: `$1${REDACTED}` },
	// 常见厂商前缀 key：sk- / pk- / rk- / ghp_ / github_pat_ / xoxb- 等
	{ pattern: /\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{8,}/g, replacement: REDACTED },
	{ pattern: /\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{8,}/g, replacement: REDACTED },
	{ pattern: /\bxox[baprs]-[A-Za-z0-9-]{8,}/g, replacement: REDACTED },
	// JWT：三段点分，整体打掉（拆开打会留下可拼接的片段）
	{ pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replacement: REDACTED },
	// 长随机串：base64 / hex（≥32 连续字符）。手机号 11 位、日期、普通英文单词都不够长。
	{
		pattern: /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{32,}={0,2}(?![A-Za-z0-9+/=])/g,
		replacement: REDACTED,
	},
];

/**
 * 把一段正文里的凭据替换成 `«redacted»`。幂等：已经打码的占位符不会再被命中。
 * 没有命中时原样返回（不做 trim / 不做空白归一 —— 那是巩固层的活）。
 */
export function redactSecrets(text: string): string {
	if (typeof text !== "string" || !text) return text;

	let output = text;
	for (const pattern of KEYED_RULES) {
		output = output.replace(pattern, (_match, prefix: string) => `${prefix}${REDACTED}`);
	}
	for (const rule of BARE_RULES) {
		output = output.replace(rule.pattern, rule.replacement);
	}
	return output;
}
