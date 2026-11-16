/**
 * 执行器模型检测（2026-11-16；同日二改：清单尽量拉全）
 *
 * 设置 → 派活 的「检测」按钮 / 清单下拉：
 * - 先尽量列出该 CLI 能给的模型清单（OpenCode `models` 全量、CodeBuddy `--help` 的 supported 列表、
 *   Qoder `--list-models`、Codex 从 `~/.codex/config.toml` 挖 model 行（顶层 / profiles /
 *   迁移登记）、Claude 的官方别名——它没有 models 子命令，全名靠用户填 + 检测验证）；
 * - 用户填了模型时，真跑一次极小请求（“只回 OK”，不挂工具）确认可用；
 * - 失败只回脱敏后的分类（未安装 / 未登录 / 模型不可用 / 超时），原始错误只进服务端日志。
 *
 * 真调是一次显式的人工动作，会消耗一次很小的模型调用；拉清单只是本地命令，不耗额度。
 *
 * 清单缓存（2026-11-17 用户口径：模型目录一天变不了两次）：`.data/executor-model-cache.json`，
 * 24 小时内直接回缓存（秒开、不 spawn CLI、不占节流），过期后首次点击才真拉一次并落盘；
 * 补刀文件不进缓存，改了立即生效。`EXECUTOR_MODEL_CACHE=false/0/off` 退回每次真拉。
 */

import { spawn } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
	type Dirent,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import {
	CLAUDE_BIN,
	CODEBUDDY_BIN,
	CODEBUDDY_MODEL,
	CODEX_BIN,
	MODEL,
	OPENCODE_BIN,
	QODER_BIN,
	QODER_CN_BIN,
	QODER_CN_MODEL,
} from "../../../../../chancellor/src/config.ts";
import { resolveCliLauncher } from "../../../../../chancellor/src/employee/cli.ts";
import {
	type ClaudeCall,
	runClaude,
} from "../../../../../chancellor/src/employee/claude.ts";
import {
	type CodexCall,
	runCodex,
} from "../../../../../chancellor/src/employee/codex.ts";
import {
	type CodeBuddyCall,
	runCodeBuddy,
} from "../../../../../chancellor/src/employee/codebuddy.ts";
import {
	type OpencodeCall,
	runOpencode,
} from "../../../../../chancellor/src/employee/opencode.ts";
import {
	type QoderCall,
	resolveQoderBinary,
	runQoderCn,
	runQoderIntl,
} from "../../../../../chancellor/src/employee/qoder.ts";
import type { ExternalCliResult } from "../../../../../chancellor/src/types.ts";
import type { SelectableExecutorKind } from "./executor-config.ts";

export interface ProbeResult {
	ok: boolean;
	models: string[];
	message: string;
	/** true = 清单来自 24h 缓存（本次没 spawn CLI，也不占 3 秒节流）；真调验证不受缓存影响。 */
	cached?: boolean;
}

const PROBE_PROMPT = "只回复两个字：OK。不要使用任何工具，不要写文件。";
const PROBE_TIMEOUT_MS = 60_000;

/** 清单缓存时效（2026-11-17 用户口径：模型目录一天变不了两次，每天真拉一次就够）。 */
const MODEL_LIST_TTL_MS = 24 * 60 * 60 * 1000;

export async function probeExecutor(
	employee: SelectableExecutorKind,
	model: string,
): Promise<ProbeResult> {
	const selected = model.trim();
	const cached = readFreshCache(employee);
	if (selected === "") {
		if (cached) {
			return withExtras(
				employee,
				{ ok: true, models: cached.models, message: cached.message },
				{ fromCache: true, fetchedAt: cached.fetchedAt },
			);
		}
		const fresh = await listModels(employee);
		maybeCacheList(employee, fresh);
		return withExtras(employee, fresh, { fromCache: false });
	}
	// 检测：清单有缓存就读缓存（不 spawn CLI），验证必须真调。
	const listed: ProbeResult = cached
		? { ok: true, models: cached.models, message: cached.message }
		: await (async () => {
			const fresh = await listModels(employee);
			maybeCacheList(employee, fresh);
			return fresh;
		})();
	const probed = await probeModel(employee, selected);
	return {
		ok: probed.ok,
		models: listed.models,
		message: probed.message,
	};
}

/** 清单 + 现拼补刀文件（补刀改了立即生效，不进缓存）；缓存命中时附新鲜度说明。 */
function withExtras(
	employee: SelectableExecutorKind,
	listed: ProbeResult,
	options: { fromCache: boolean; fetchedAt?: number },
): ProbeResult {
	if (listed.models.length === 0) {
		return options.fromCache ? { ...listed, cached: true } : listed;
	}
	const extras = readExtraModels(employee).filter(
		(name) => !listed.models.includes(name),
	);
	const notes: string[] = [];
	if (extras.length > 0) {
		notes.push(`手动补 ${extras.length} 个`);
	}
	if (options.fromCache && options.fetchedAt !== undefined) {
		notes.push(
			`缓存于 ${freshnessNote(options.fetchedAt)}，每天最多真拉一次`,
		);
	}
	return {
		ok: true,
		cached: options.fromCache || undefined,
		models: [...listed.models, ...extras],
		message:
			notes.length > 0 ? `${listed.message}（${notes.join("；")}）` : listed.message,
	};
}

function freshnessNote(fetchedAt: number): string {
	const minutes = Math.max(1, Math.round((Date.now() - fetchedAt) / 60_000));
	if (minutes < 60) return `${minutes} 分钟前`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} 小时前`;
	return `${Math.round(hours / 24)} 天前`;
}

/** 这次调用会不会真的 spawn CLI（清单缓存没命中 / 带模型真调）——mount 据此决定节流。
 *  缓存命中是纯文件读，不该被 3 秒节流拦住。 */
export function probeNeedsThrottle(
	employee: SelectableExecutorKind,
	model: string,
): boolean {
	if (model.trim() !== "") return true;
	return readFreshCache(employee) === null;
}

/** 清单缓存（每天最多真拉一次）：`.data/executor-model-cache.json`，键 = 执行器 kind。
 *  只缓存 ok 且非空的清单（CLI 没装 / 失败不缓存，下次重试）；坏文件当不存在。
 *  `EXECUTOR_MODEL_CACHE=false/0/off` 退回每次真拉。 */
interface ModelCacheEntry {
	fetchedAt: number;
	models: string[];
	message: string;
}

function modelCacheEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env.EXECUTOR_MODEL_CACHE ?? "").trim().toLowerCase();
	return !["false", "0", "off"].includes(raw);
}

function modelCachePath(env: NodeJS.ProcessEnv = process.env): string {
	return join(
		dirname(resolve(env.EXECUTOR_CONFIG_PATH?.trim() || ".data/executor.json")),
		"executor-model-cache.json",
	);
}

function readModelCache(
	kind: SelectableExecutorKind,
	env: NodeJS.ProcessEnv = process.env,
): ModelCacheEntry | null {
	try {
		const raw: unknown = JSON.parse(readFileSync(modelCachePath(env), "utf8"));
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
		const entry = (raw as Record<string, unknown>)[kind];
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
		const e = entry as Record<string, unknown>;
		if (typeof e.fetchedAt !== "number" || typeof e.message !== "string") return null;
		if (!Array.isArray(e.models) || !e.models.every((m) => typeof m === "string")) {
			return null;
		}
		return {
			fetchedAt: e.fetchedAt,
			models: e.models as string[],
			message: e.message,
		};
	} catch {
		return null;
	}
}

function readFreshCache(
	kind: SelectableExecutorKind,
	env: NodeJS.ProcessEnv = process.env,
): ModelCacheEntry | null {
	if (!modelCacheEnabled(env)) return null;
	const entry = readModelCache(kind, env);
	if (!entry) return null;
	if (Date.now() - entry.fetchedAt > MODEL_LIST_TTL_MS) return null;
	return entry;
}

function maybeCacheList(
	kind: SelectableExecutorKind,
	listed: ProbeResult,
	env: NodeJS.ProcessEnv = process.env,
): void {
	if (!modelCacheEnabled(env)) return;
	if (!listed.ok || listed.models.length === 0) return;
	try {
		const path = modelCachePath(env);
		let doc: Record<string, unknown> = {};
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
				doc = parsed as Record<string, unknown>;
			}
		} catch {
			// 首次写 / 坏文件重建
		}
		doc[kind] = { fetchedAt: Date.now(), models: listed.models, message: listed.message };
		mkdirSync(dirname(path), { recursive: true });
		const temp = `${path}.${process.pid}.tmp`;
		writeFileSync(temp, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
		renameSync(temp, path);
	} catch {
		// 缓存写失败不影响功能，下次再试
	}
}

async function listModels(employee: SelectableExecutorKind): Promise<ProbeResult> {
	if (employee === "native") {
		return {
			ok: true,
			models: [],
			message: "本机内核不在这里探测；模型由启动 env（LLM_MODEL）决定。",
		};
	}
	if (employee === "opencode") {
		const captured = await capture(OPENCODE_BIN, ["models"], "OpenCode", 20_000);
		if (!captured.ok) {
			return {
				ok: false,
				models: [],
				message: "取不到 OpenCode 模型清单：CLI 未安装或服务没起来。",
			};
		}
		const models = captured.text
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => /^[a-z0-9_.-]+\/.+$/i.test(line));
		return {
			ok: models.length > 0,
			models: [...new Set(models)].sort((a, b) => a.localeCompare(b)),
			message:
				models.length > 0
					? `已取到 ${models.length} 个 OpenCode 模型；选一个再点检测可验证可用性。`
					: "OpenCode 没有返回模型清单。",
		};
	}
	if (employee === "codebuddy") {
		const captured = await capture(CODEBUDDY_BIN, ["--help"], "CodeBuddy", 15_000);
		if (!captured.ok) {
			return {
				ok: false,
				models: [],
				message: "CodeBuddy CLI 未安装或路径不对。",
			};
		}
		const match = captured.text.match(
			/--model\s+<model>[\s\S]*?Currently supported:\s*\(([^)]+)\)/i,
		);
		const fromHelp = match?.[1]
			? match[1]
					.split(",")
					.map((item) => item.trim())
					.filter(Boolean)
			: [];
		const fromHistory = codebuddyHistoryModels().filter(
			(name) => !fromHelp.includes(name),
		);
		const models = [...new Set([...fromHelp, ...fromHistory])];
		if (models.length === 0) {
			const fallback =
				process.env.CHANCELLOR_CODEBUDDY_MODEL?.trim() || CODEBUDDY_MODEL;
			return {
				ok: true,
				models: [fallback],
				message: `没解析到支持列表；当前缺省模型是 ${fallback}。`,
			};
		}
		return {
			ok: true,
			models,
			message:
				`已取到 ${models.length} 个 CodeBuddy 模型（--help 支持列表 ${fromHelp.length} 个` +
				(fromHistory.length > 0
					? ` + 本机历史用过 ${fromHistory.length} 个（旧名可能已改版）`
					: "") +
				"）；点「检测」可验证可用性。",
		};
	}
	if (employee === "claude-code") {
		return {
			ok: true,
			models: ["fable", "opus", "sonnet", "haiku"],
			message:
				"Claude Code 没有 models 子命令；这些是官方别名（指向各代最新）。完整模型名可直接填，点「检测」验证。",
		};
	}
	if (employee === "codex") {
		const fromConfig = readCodexModels();
		return {
			ok: true,
			models: fromConfig.models,
			message: fromConfig.message,
		};
	}
	if (employee === "qoder-intl" || employee === "qoder-cn") {
		const bin = resolveQoderBinary(employee === "qoder-cn" ? QODER_CN_BIN : QODER_BIN);
		if (!existsSync(bin)) {
			return {
				ok: false,
				models: [],
				message:
					employee === "qoder-intl"
						? "Qoder 国际版未安装（配置里的路径不存在）；内部拆单已不再依赖它，工人要用请重装。"
						: "Qoder 国内版未安装（配置里的路径不存在）。",
			};
		}
		const fallback = employee === "qoder-cn" ? QODER_CN_MODEL : MODEL;
		const captured = await capture(
			bin,
			["--list-models"],
			employee === "qoder-cn" ? "Qoder CN" : "Qoder",
			15_000,
		);
		const listed = captured.ok
			? captured.text
					.split(/\r?\n/)
					.map((line) => line.trim())
					.filter((line) => line && !/^MODEL$/i.test(line))
			: [];
		// qodercli --list-models 就是「当前账号可用的全部」；IDE 里的完整目录是加密缓存
		// 读不出来，内部 modelId（dfmodel 等）CLI 也不收（2026-11-17 实测 exit 42）。
		// 缺的名字走手动补：.data/executor-models.json（在 withExtras 统一合并，不进缓存）。
		const models = [...new Set(listed)];
		return {
			ok: true,
			models: models.length > 0 ? models : [fallback],
			message:
				models.length > 0
					? `已取到 ${models.length} 个 Qoder 模型（qodercli --list-models 报的全部）；选一个再点检测可验证可用性。`
					: `Qoder 没有返回模型清单；当前缺省模型是 ${fallback}。`,
		};
	}
	return { ok: false, models: [], message: "未知执行器。" };
}

/** 手动补刀清单：`.data/executor-models.json`，键 = 执行器 kind，值 = 模型名数组。
 *  CLI 报不全时用户自己登记名字（如 Qoder IDE 里看得到、CLI --list-models 不列的）；
 *  文件不存在 / 坏了就当没有。 */
function readExtraModels(kind: SelectableExecutorKind): string[] {
	try {
		const path = resolve(process.env.EXECUTOR_CONFIG_PATH?.trim() || ".data/executor.json");
		const raw: unknown = JSON.parse(
			readFileSync(join(dirname(path), "executor-models.json"), "utf8"),
		);
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];
		const list = (raw as Record<string, unknown>)[kind];
		if (!Array.isArray(list)) return [];
		return list
			.filter((item): item is string => typeof item === "string")
			.map((item) => item.trim())
			.filter(Boolean)
			.slice(0, 200);
	} catch {
		return [];
	}
}

/** 本机 CodeBuddy 会话里真实用过的模型名（--help 的 supported 列表滞后于后端，
 *  实测漏掉整个 hy4 家族）。projects 目录 229MB/173 件，不能全读：
 *  按 mtime 新到旧、每个文件只读头部 256KB（模型名集中在消息开头），
 *  上限 40 件 / 12MB；进程内扫一次缓存。旧名不保证还能用——「检测」就是干这个的。 */
let codebuddyHistoryCache: string[] | null = null;
function codebuddyHistoryModels(): string[] {
	if (codebuddyHistoryCache) return codebuddyHistoryCache;
	const found = new Set<string>();
	try {
		const root = join(homedir(), ".codebuddy", "projects");
		const files: { path: string; mtimeMs: number }[] = [];
		const visit = (dir: string, depth: number): void => {
			if (depth > 2) return;
			let entries: Dirent[];
			try {
				entries = readdirSync(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				const child = join(dir, entry.name);
				if (entry.isDirectory()) visit(child, depth + 1);
				else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
					try {
						files.push({ path: child, mtimeMs: statSync(child).mtimeMs });
					} catch {
						// 文件可能正被 CLI 写着，读不到就算了
					}
				}
			}
		};
		visit(root, 0);
		files.sort((a, b) => b.mtimeMs - a.mtimeMs);
		const MAX_FILES = 40;
		const PER_FILE = 256 * 1024;
		const MAX_TOTAL = 12 * 1024 * 1024;
		let total = 0;
		for (const file of files.slice(0, MAX_FILES)) {
			if (total >= MAX_TOTAL) break;
			let fd: number;
			try {
				fd = openSync(file.path, "r");
			} catch {
				continue;
			}
			try {
				const buf = Buffer.alloc(PER_FILE);
				const bytes = readSync(fd, buf, 0, PER_FILE, 0);
				total += bytes;
				const text = buf.toString("utf8", 0, bytes);
				for (const m of text.matchAll(/"model":"([A-Za-z0-9][A-Za-z0-9._-]{0,60})"/g)) {
					found.add(m[1]);
				}
			} finally {
				closeSync(fd);
			}
		}
		codebuddyHistoryCache = [...found];
	} catch {
		codebuddyHistoryCache = [];
	}
	return codebuddyHistoryCache;
}

async function probeModel(
	employee: SelectableExecutorKind,
	model: string,
): Promise<{ ok: boolean; message: string }> {
	const dir = mkdtempSync(join(tmpdir(), "executor-probe-"));
	try {
		// Qoder 首次调用可能冷启动约 100 秒（国内版实测），给 120 秒；其余 60 秒。
		const timeoutMs =
			employee === "qoder-intl" || employee === "qoder-cn"
				? 120_000
				: PROBE_TIMEOUT_MS;
		const call = {
			prompt: PROBE_PROMPT,
			cwd: dir,
			model,
			timeoutMs,
			label: "probe",
		};
		let result: ExternalCliResult;
		if (employee === "claude-code") {
			result = await runClaude({
				...call,
				permission: "read",
			} satisfies ClaudeCall);
		} else if (employee === "codex") {
			result = await runCodex({
				...call,
				permission: "read",
			} satisfies CodexCall);
		} else if (employee === "opencode") {
			result = await runOpencode({
				...call,
				permission: "read",
			} satisfies OpencodeCall);
		} else if (employee === "codebuddy") {
			result = await runCodeBuddy({
				...call,
				model,
			} satisfies CodeBuddyCall);
		} else if (employee === "qoder-intl" || employee === "qoder-cn") {
			const qoderCall: QoderCall = {
				...call,
				tools: "none",
				model,
			};
			result =
				employee === "qoder-cn"
					? await runQoderCn(qoderCall)
					: await runQoderIntl(qoderCall);
		} else {
			return { ok: true, message: "本机内核不在这里探测；模型由启动 env（LLM_MODEL）决定。" };
		}
		return classify(employee, result);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function classify(
	employee: SelectableExecutorKind,
	result: ExternalCliResult,
): { ok: boolean; message: string } {
	if (result.ok) {
		const text = result.result.replace(/\s+/g, " ").trim().slice(0, 60);
		return { ok: true, message: `可用${text ? `：${text}` : ""}` };
	}
	// 原始错误只进服务端日志；客户端只看得分类。
	const raw = `${result.error ?? ""} ${result.stderrTail ?? ""}`.toLowerCase();
	console.warn(
		`[executor] probe ${employee} 失败：${(result.error ?? "no error").slice(0, 200)}`,
	);
	if (result.timedOut) {
		return {
			ok: false,
			message:
				employee === "codex"
					? "超时：Codex 未登录时可能挂起；先 `codex login` 再试。"
					: "超时：CLI 在 60 秒内没有回话。",
		};
	}
	if (/enoent|not found|no such file|无法从|未安装|不存在/.test(raw)) {
		return { ok: false, message: "CLI 未安装或路径不对。" };
	}
	if (
		/not logged in|logged in|login|auth|unauthorized|401|403|credential|api key/.test(
			raw,
		)
	) {
		return { ok: false, message: "未登录或登录失效。" };
	}
	if (
		/model.*(not found|unavailable|unknown|no-route|does not exist)|no such model|模型不可用/.test(
			raw,
		)
	) {
		return { ok: false, message: "模型不可用（名字不对或当前账号没有权限）。" };
	}
	return { ok: false, message: "调用失败（详见服务端日志）。" };
}

/**
 * Codex 没有 models 子命令，能从 ~/.codex/config.toml 挖多少挖多少：
 * 顶层 / [profiles.*] 的 model = "..." 行，加上 [notice.model_migrations] 里
 * Codex 自己登记的改名映射（旧名 → 新名，两边都是真模型名）。
 */
function readCodexModels(): { models: string[]; message: string } {
	let text: string;
	try {
		text = readFileSync(join(homedir(), ".codex", "config.toml"), "utf8");
	} catch {
		return {
			models: [],
			message:
				"Codex 没有 models 子命令；也没读到 ~/.codex/config.toml，留空 = 跟随 Codex 默认。",
		};
	}
	const found = new Set<string>();
	for (const match of text.matchAll(/^\s*model\s*=\s*"([^"]+)"\s*$/gm)) {
		const value = match[1]?.trim();
		if (value) found.add(value);
	}
	const migrations = text.match(/\[notice\.model_migrations\]\s*\n([\s\S]*?)(?=\n\[|\s*$)/);
	if (migrations?.[1]) {
		for (const match of migrations[1].matchAll(/"([^"]+)"\s*=\s*"([^"]+)"/g)) {
			if (match[1]?.trim()) found.add(match[1].trim());
			if (match[2]?.trim()) found.add(match[2].trim());
		}
	}
	const models = [...found];
	if (models.length === 0) {
		return {
			models: [],
			message:
				"Codex 没有 models 子命令；config.toml 里也没读到 model，留空 = 跟随 Codex 默认。",
		};
	}
	return {
		models,
		message: `Codex 没有 models 子命令；从 ~/.codex/config.toml 读到 ${models.length} 个模型。完整模型名也可直接填，点「检测」验证。`,
	};
}

/** 跑一个只读清单命令；失败只回退出码 / 超时，不把 stderr 拼给客户端。 */
function capture(
	command: string,
	args: string[],
	label: string,
	timeoutMs: number,
): Promise<{ ok: boolean; text: string }> {
	return new Promise((resolve) => {
		let launcher: { command: string; prefixArgs: string[] };
		try {
			launcher = resolveCliLauncher(command, process.env, label);
		} catch {
			resolve({ ok: false, text: "" });
			return;
		}
		const cwd = tmpdir();
		let child;
		try {
			child = spawn(launcher.command, [...launcher.prefixArgs, ...args], {
				cwd,
				env: { ...process.env, PWD: cwd },
				windowsHide: true,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch {
			resolve({ ok: false, text: "" });
			return;
		}
		let text = "";
		let settled = false;
		const finish = (ok: boolean): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ ok, text });
		};
		const timer = setTimeout(() => {
			child.kill();
			finish(false);
		}, timeoutMs);
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			text += chunk;
		});
		// stderr 只丢弃：清单命令的报错可能带上游地址。
		child.on("error", () => finish(false));
		child.on("close", (code) => finish(code === 0));
	});
}
