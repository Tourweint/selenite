import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * 服务端本地密钥文件（2026-11-05 H2，接口文档 §2.10 `PUT /providers/:id/secret`）。
 *
 * 落点：`.data/provider-keys.json`，结构 `{ "<keyEnv>": "<明文>" }`。
 * 这是"界面直填 API Key"的唯一存储；providers.json 仍只存变量名。
 *
 * 纪律：
 *   - 启动时全量注入 `process.env`，**已有 env 值优先**（.env / 部署环境说了算）；
 *   - 每次 PUT 原子重写；写盘权限尽量 0600（Windows 上 chmod 是尽力而为）；
 *   - 值绝不进任何响应 / 日志；本文件只导出"有 / 没有"和计数。
 */

export const KEY_ENV_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

type KeyMap = Record<string, string>;

function keysPath(): string {
	return process.env.PROVIDER_KEYS_PATH?.trim() || ".data/provider-keys.json";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * 读密钥文件。
 *
 * `strict=true` 给写路径用：文件存在但坏了就抛，**绝不拿空表覆盖**——
 * 一次 PUT 不能顺手把别人的 key 抹掉。
 * 启动注入 / 删除联动用宽松读：坏了当没有，只留一条不含内容的告警。
 */
function readKeyMap(strict: boolean): KeyMap {
	const path = keysPath();
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return {};
		if (strict) throw new Error("密钥文件不可读");
		console.warn(`[secret] 密钥文件不可读，已忽略（${path}）`);
		return {};
	}

	try {
		const parsed = JSON.parse(text) as unknown;
		if (!isPlainObject(parsed)) throw new Error("shape");
		const map: KeyMap = {};
		for (const [name, value] of Object.entries(parsed)) {
			// 只认合法变量名 + 非空字符串；坏条目丢弃而不是让整份文件不可用
			if (KEY_ENV_PATTERN.test(name) && typeof value === "string" && value.trim()) {
				map[name] = value;
			}
		}
		return map;
	} catch {
		if (strict) throw new Error("密钥文件内容不合法");
		// 不打印解析错误详情：新版 V8 的错误信息可能带原文片段
		console.warn(`[secret] 密钥文件内容不合法，已忽略（${path}）`);
		return {};
	}
}

/** 临时文件 + rename；权限先收再写，Windows 上 chmod 失败静默跳过 */
function writeKeyMap(map: KeyMap): void {
	const path = keysPath();
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.tmp-${process.pid}`;
	try {
		writeFileSync(temp, `${JSON.stringify(map, null, 2)}\n`, { mode: 0o600 });
		try {
			chmodSync(temp, 0o600);
		} catch {
			/* Windows 上尽力而为 */
		}
		renameSync(temp, path);
		try {
			chmodSync(path, 0o600);
		} catch {
			/* Windows 上尽力而为 */
		}
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

/**
 * 启动注入：文件里的变量写进 process.env，**已有值不覆盖**。
 * 返回值只用于日志计数，不含任何键名 / 值。
 */
export function injectProviderKeys(): { injected: number; skipped: number } {
	const map = readKeyMap(false);
	let injected = 0;
	let skipped = 0;
	for (const [name, value] of Object.entries(map)) {
		if (process.env[name]?.trim()) {
			skipped += 1;
			continue;
		}
		process.env[name] = value;
		injected += 1;
	}
	const total = injected + skipped;
	if (total > 0) {
		console.log(
			`[secret] 密钥文件载入 ${injected} 个变量（env 已有值优先，跳过 ${skipped} 个）`,
		);
	}
	return { injected, skipped };
}

/** 写一个条目（严格读：文件坏了就拒绝覆盖）。跑完即可热注入 env。 */
export function writeProviderKey(keyEnv: string, apiKey: string): void {
	if (!KEY_ENV_PATTERN.test(keyEnv)) throw new Error("keyEnv 不合法");
	const map = readKeyMap(true);
	map[keyEnv] = apiKey;
	writeKeyMap(map);
}

/** 删除若干条目（删除供应商联动）；返回实际删掉的条数。坏文件不覆盖。 */
export function removeProviderKeys(names: string[]): number {
	const map = readKeyMap(false);
	let removed = 0;
	for (const name of names) {
		if (!(name in map)) continue;
		delete map[name];
		removed += 1;
	}
	if (removed > 0) writeKeyMap(map);
	return removed;
}
