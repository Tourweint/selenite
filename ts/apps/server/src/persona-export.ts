import { appendFile, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { COMPANIONS_ENABLED, partnersStore, resolvePartnerScope } from "./partners.ts";
import { runtimeModelInfo } from "./provider.ts";
import { TASK_CONVERSATION_PREFIX } from "./agent/shared.ts";

/**
 * 主对话导出（2026-11-09 persona 接入批二）。
 *
 * 每轮真正收尾（`agent/settled.ts` 的 done 分支）后，把**主人主对话**的
 * user 原话 + assistant 最终回复追加写 `.data/persona-export/<yyyy-mm>.jsonl`，
 * 供 voicevault 的 `experiments/import_lifediary.py` 增量拉走。
 *
 * 契约只有一份：`docs/设计方案/2026-11-09-persona记忆库接入（检索工具+对话中转归档）.md`
 * 的「契约：导出文件行格式」一节（批二落地后下沉 `接口文档.md` §3）。
 * 列顺序 / 字段语义改这里必须同步改那份文档与 voicevault 导入脚本。
 *
 * 边界（方案 D-丁 / D-戊 / D-己）：
 *   - 只导主对话：`task-` 专线、群会话、执事会话一律不导（混进主人语料会串人格）；
 *   - 只写自己 `.data` 下的文件，不推 HTTP、不碰 voicevault 进程；
 *   - `PERSONA_EXPORT_ENABLED` 默认关（未配置 / false / 0 都不写），启用要 .env 显式配；
 *   - 写失败只 warn，绝不打断对话；日志只记轮数 / 字数 / 文件名，**不记对话原文**。
 *
 * assistant 文本取的是**本轮最终回复**：`settled.ts` 的 `plain` 是请求时刻的消息快照
 * （客户端通常只带这一句 user），拿不到本轮新生成的回复；因此生产路径由
 * `session.ts` 的 settle 回调给一个懒读取（durable 里本轮最后一条 assistant）。
 * `plain` 里尾随 user 的 assistant（有的调用方会把整段历史带上来）优先采用。
 */

/** 导出文件行格式版本（契约 `v`；非 1 的行由导入方跳过）。 */
export const PERSONA_EXPORT_VERSION = 1;

/** 默认导出目录（相对服务进程 cwd，与 `.data/*` 其它落点同口径）。 */
const DEFAULT_EXPORT_DIR = join(".data", "persona-export");

export interface PersonaExportLine {
	v: typeof PERSONA_EXPORT_VERSION;
	/** 对外会话 uuid（voicevault 用作 turn.sid；复合 session.sid 由导入方拼） */
	conversationId: string;
	/** durable 内部轮 id（同一轮重导幂等）；拿不到时回落 `conversationId:ts` */
	turnId: string;
	/** ISO 8601 带本地时区偏移，例：`2026-11-09T20:15:03+08:00` */
	ts: string;
	userText: string;
	assistantText: string;
	/** 模型名；拿不到写空串（契约允许空） */
	model: string;
}

export interface PersonaExportChat {
	internalId: number;
	externalId: string;
}

/** 与 `settled.ts` 的 `plain` 同形：已纯文本化的一轮消息数组。 */
export interface PersonaExportMessage {
	role: string;
	content: string;
}

/** 测试 / 装配注入口；生产不传（走 process.env 与 partnersStore）。 */
export interface PersonaExportDeps {
	env?: NodeJS.ProcessEnv;
	/** 导出根目录，默认 `.data/persona-export`（`PERSONA_EXPORT_DIR` 优先） */
	dir?: string;
	now?: () => Date;
	/** durable 轮 id（settled 传 `String(record.id)`） */
	turnId?: string;
	/** 本轮最终 assistant 文本的懒读取（只在 plain 里没有尾随 assistant 时调用） */
	reply?: () => Promise<string>;
	/** 会话过滤替身：单测用，避免真开 partners.sqlite */
	isGroupSession?: (internalId: number) => boolean;
	isPartnerSession?: (internalId: number) => boolean;
}

/**
 * 导出开关（方案 D-己）：**默认关**，只有显式 true/1/on 才导。
 * 未配置、空串、false/0/off、拼错的值一律按关处理——对外送数据默认不动。
 */
export function personaExportEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env.PERSONA_EXPORT_ENABLED?.trim().toLowerCase();
	return raw === "true" || raw === "1" || raw === "on";
}

function defaultIsGroupSession(internalId: number): boolean {
	try {
		return partnersStore().isGroupSession(internalId);
	} catch {
		// 查不到按"是群会话"处理（少导一次优于把群聊写进主人语料）。
		return true;
	}
}

/**
 * 执事会话判定（方案 D-丁）：与 `agent/assist.ts` 的 `partnerScopeOf` 同口径——
 * 链接表里挂着非总管执事的会话返回 partner scope。总管（chief）返回 null，属主对话。
 * 查失败按"是执事"处理（少导），防止把执事对话误当主人语料写进 persona。
 */
function defaultIsPartnerSession(internalId: number): boolean {
	if (!COMPANIONS_ENABLED) return false;
	try {
		return resolvePartnerScope(partnersStore(), internalId) !== null;
	} catch {
		return true;
	}
}

function exportDirOf(env: NodeJS.ProcessEnv, deps: PersonaExportDeps): string {
	return deps.dir ?? (env.PERSONA_EXPORT_DIR?.trim() || DEFAULT_EXPORT_DIR);
}

/** 本地时间 `yyyy-mm`（按月轮转）；月份按**本地**时间，与文件里的 ts 同一时区。 */
function monthKeyOf(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/** ISO 8601 带本地时区偏移（`toISOString()` 是 UTC Z，契约示例是 +08:00 形态）。 */
function isoLocal(date: Date): string {
	const pad = (value: number, width = 2): string =>
		String(Math.trunc(Math.abs(value))).padStart(width, "0");
	const offsetMinutes = -date.getTimezoneOffset();
	const sign = offsetMinutes >= 0 ? "+" : "-";
	return (
		`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
		`T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
		`${sign}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`
	);
}

/** 模型名：拿不到写空串（契约允许）。配置读失败绝不能拦导出。 */
function currentModelName(): string {
	try {
		return runtimeModelInfo().model ?? "";
	} catch {
		return "";
	}
}

/** 从 plain 里取最后一条 user，以及**尾随它**的最后一条 assistant。 */
function extractTexts(plain: PersonaExportMessage[]): {
	userText: string;
	assistantText: string;
} {
	let userText = "";
	let lastUserIndex = -1;
	for (let index = plain.length - 1; index >= 0; index -= 1) {
		if (plain[index]?.role === "user") {
			userText = plain[index]?.content ?? "";
			lastUserIndex = index;
			break;
		}
	}
	let assistantText = "";
	for (let index = plain.length - 1; index > lastUserIndex; index -= 1) {
		if (plain[index]?.role === "assistant") {
			assistantText = plain[index]?.content ?? "";
			break;
		}
	}
	return { userText, assistantText };
}

/** 会话过滤（方案 D-丁）。返回 false = 这一轮不该导出。 */
function exportable(chat: PersonaExportChat, deps: PersonaExportDeps): boolean {
	// 任务专线不进 persona（settled.ts:56 同款判断，2026-11-08 扫尾批 8g）
	if (chat.externalId.startsWith(TASK_CONVERSATION_PREFIX)) return false;
	const isGroup = deps.isGroupSession ?? defaultIsGroupSession;
	if (isGroup(chat.internalId)) return false;
	const isPartner = deps.isPartnerSession ?? defaultIsPartnerSession;
	return !isPartner(chat.internalId);
}

/**
 * 导出本轮（异步核心，返回写入行数 0/1）。单测直接 await 它；
 * 生产走下面的同步门面 `appendPersonaExport`。
 */
export async function appendPersonaExportAsync(
	chat: PersonaExportChat,
	plain: PersonaExportMessage[],
	model?: string,
	deps: PersonaExportDeps = {},
): Promise<number> {
	const env = deps.env ?? process.env;
	if (!personaExportEnabled(env)) return 0;
	if (!exportable(chat, deps)) return 0;

	const { userText, assistantText: inlineAssistant } = extractTexts(plain);
	let assistantText = inlineAssistant;
	if (!assistantText.trim() && deps.reply) {
		try {
			assistantText = await deps.reply();
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			console.warn(`[persona-export] 读取最终回复失败: ${detail}`);
			assistantText = "";
		}
	}
	// 全空的轮不写（契约：至少一个非空）；空串 / 纯空白都算空。
	if (!userText.trim() && !assistantText.trim()) return 0;

	const at = (deps.now ?? (() => new Date()))();
	const ts = isoLocal(at);
	const line: PersonaExportLine = {
		v: PERSONA_EXPORT_VERSION,
		conversationId: chat.externalId,
		turnId: deps.turnId || `${chat.externalId}:${ts}`,
		ts,
		userText,
		assistantText,
		model: model ?? currentModelName(),
	};

	const dir = exportDirOf(env, deps);
	const file = `${monthKeyOf(at)}.jsonl`;
	try {
		await mkdir(dir, { recursive: true });
		await appendFile(join(dir, file), `${JSON.stringify(line)}\n`, "utf8");
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[persona-export] 写入失败: ${detail}`);
		return 0;
	}
	// 只记条数 / 字数 / 文件名，不记对话内容（硬约束）。
	console.log(
		`[persona-export] 1轮 user=${userText.length}字 asst=${assistantText.length}字 → ${basename(dir)}/${file}`,
	);
	return 1;
}

/**
 * 生产入口：同步返回"排队写入行数"（0 = 没写、1 = 已排队），写盘异步、失败只 warn。
 * 不 await —— 导出慢了不该拖住任何东西（与记忆抽取同款"写慢不拖东西"）。
 *
 * 返回 1 不保证最终落盘（`reply` 读回来仍可能全空 / 写盘失败），只表示"过了开关与过滤"；
 * 真写盘的行数由 `appendPersonaExportAsync` 决定，生产调用方不看返回值。
 */
export function appendPersonaExport(
	chat: PersonaExportChat,
	plain: PersonaExportMessage[],
	model?: string,
	deps: PersonaExportDeps = {},
): number {
	const env = deps.env ?? process.env;
	if (!personaExportEnabled(env)) return 0;
	if (!exportable(chat, deps)) return 0;
	// 全空且没有可补的回复来源：确定不写，别排一个空任务。
	const { userText, assistantText } = extractTexts(plain);
	if (!userText.trim() && !assistantText.trim() && !deps.reply) return 0;
	void appendPersonaExportAsync(chat, plain, model, deps).catch((error: unknown) => {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[persona-export] 导出失败: ${detail}`);
	});
	return 1;
}
