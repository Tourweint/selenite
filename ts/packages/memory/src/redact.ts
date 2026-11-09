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

// ── 校验位敏感号（2026-11-10 批 21 §四，七 #31 差半）──────────────
//
// 光看形状会把普通长数字（快递单 / 订单号）误杀，所以只打"校验位也通过"的：
// 银行卡走 Luhn，身份证走 GB 11643 的 MOD 11-2。误伤率从"所有 13-19 位数字"
// 降到"碰巧通过校验位的那一小撮"，而真卡号/真证号必过。15 位老身份证没有
// 校验位可验，刻意不收（形状打码会误伤 15 位普通数字）。

/** Luhn 算法（ISO/IEC 7812-1）：从右往左隔位翻倍求和，模 10 为 0 通过。 */
export function luhnValid(digits: string): boolean {
	if (!/^\d{2,}$/.test(digits)) return false;
	let sum = 0;
	let double = false;
	for (let i = digits.length - 1; i >= 0; i -= 1) {
		let value = digits.charCodeAt(i) - 48;
		if (double) {
			value *= 2;
			if (value > 9) value -= 9;
		}
		sum += value;
		double = !double;
	}
	return sum % 10 === 0;
}

/** 18 位身份证校验（GB 11643-1999 MOD 11-2）：末位可为 X。 */
export function idCardValid(id: string): boolean {
	if (!/^\d{17}[\dXx]$/.test(id)) return false;
	const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
	const checks = ["1", "0", "X", "9", "8", "7", "6", "5", "4", "3", "2"];
	let sum = 0;
	for (let i = 0; i < 17; i += 1) {
		sum += (id.charCodeAt(i) - 48) * weights[i]!;
	}
	return checks[sum % 11] === id.charAt(17).toUpperCase();
}

/** 13-19 位、前后不再连着数字（手机号 11 位、日期、普通编号都够不着）。 */
const SENSITIVE_NUMBER_PATTERNS = {
	idCard: /(?<![0-9Xx])[0-9]{17}[0-9Xx](?![0-9Xx])/g,
	cardLike: /(?<![0-9])[0-9]{13,19}(?![0-9])/g,
};

/** 校验位敏感号打码：身份证（含 X）先走，剩下的长数字里只打 Luhn 通过的。 */
function redactSensitiveNumbers(text: string): string {
	let output = text.replace(SENSITIVE_NUMBER_PATTERNS.idCard, (match) =>
		idCardValid(match) ? REDACTED : match,
	);
	output = output.replace(SENSITIVE_NUMBER_PATTERNS.cardLike, (match) =>
		luhnValid(match) ? REDACTED : match,
	);
	return output;
}

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
	output = redactSensitiveNumbers(output);
	for (const rule of BARE_RULES) {
		output = output.replace(rule.pattern, rule.replacement);
	}
	return output;
}
