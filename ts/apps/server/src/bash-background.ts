/**
 * bash 超时转后台（2026-11-09 任务书 T3 §3）。
 *
 * 现状：`AGENT_BASH_TIMEOUT_S` 注入的缺省超时一到，内核直接抛
 * `Command timed out after N seconds`，工具算失败——可命令本身可能只是慢，
 * 不是错。本模块把"超时"从失败改判为"转到后台继续跑"。
 *
 * **不改内核**：只在现成的 `afterTool` 里认这个错误（形状由内核 bash.js 固定：
 * `- `result.isError === true`
 * `- `output` / `diagnostics` 里带 `Command timed out after <N> seconds`
 * ），然后由服务端自己 `spawn` 同一条命令。
 *
 * 安全口径（与前台同权限边界，不做任何放宽）：
 * - 命令摘要 ≤120 字进 `index.json`；**完整命令不落 json**，只进 `.log`（与今天的 bash 输出同待遇）。
 * - 日志内容只回会话，不进服务端日志；服务端日志只记条数与耗时。
 * - 开关 `AGENT_BASH_BG_TIMEOUT`，**缺省 false**（先观望，开了才转）。
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const DEFAULT_DIR = ".data/bg-jobs";
const SUMMARY_LIMIT = 120;
const LOG_TAIL_CHARS = 2000;
const TIMEOUT_RE = /Command timed out after ([0-9.]+) seconds/;
/** index.json 的条数上限（超过时启动裁掉最旧的已结束任务，只删索引，不删日志）。 */
export const BG_INDEX_LIMIT = 200;
/** 日志查看端点最多回多少行。 */
export const BG_LOG_TAIL_LINES = 200;
/** 任务 id 形状就是本模块自己生成的：只认这个形状，避免 `../` 之类拼进文件路径。 */
const JOB_ID_RE = /^bg-[a-z0-9]+-[a-z0-9]+$/;

export interface BgJobRecord {
	id: string;
	/** 命令摘要（空白压平、≤120 字）；完整命令只在 .log 里 */
	commandSummary: string;
	startedAt: string;
	endedAt?: string;
	exitCode?: number | null;
	status: "running" | "done" | "failed";
}

/** 开关：只有明确写 1 / true / on 才开（这是行为变化，默认必须不变）。 */
export function bashBackgroundEnabled(env: Record<string, string | undefined> = process.env): boolean {
	const raw = env.AGENT_BASH_BG_TIMEOUT?.trim().toLowerCase();
	return raw === "1" || raw === "true" || raw === "on";
}

/**
 * 落点目录。缺省 `.data/bg-jobs`；`AGENT_BG_JOBS_DIR` 只给探针/测试隔离用
 * （照 `.data/approvals.json` 等既有 `*_PATH` 的做法），不是给部署换落点的开关。
 */
export function bashJobsDir(env: Record<string, string | undefined> = process.env): string {
	return env.AGENT_BG_JOBS_DIR?.trim() || DEFAULT_DIR;
}

function indexPathOf(dir: string): string {
	return join(dir, "index.json");
}

function logPathOf(dir: string, id: string): string {
	return join(dir, `${id}.log`);
}

function textOf(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value
		.map((item) =>
			item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string"
				? ((item as { text: string }).text ?? "")
				: "",
		)
		.filter(Boolean)
		.join("\n");
}

/**
 * 从工具结果里认出"内核超时"。认出返回超时秒数，否则 null。
 *
 * 只用内核固定文案（不是宽泛匹配 "timeout"）：别的工具失败也可能带这词，
 * 误判会把真正的错误转成后台再跑一遍。
 */
export function timeoutSecondsFromResult(result: {
	readonly isError?: boolean;
	readonly output?: unknown;
	readonly diagnostics?: readonly { readonly message?: string }[];
}): number | null {
	const haystack = [
		textOf(result.output),
		...(result.diagnostics ?? []).map((diagnostic) => diagnostic.message ?? ""),
	].join("\n");
	const matched = TIMEOUT_RE.exec(haystack);
	if (!matched) return null;
	const seconds = Number(matched[1]);
	return Number.isFinite(seconds) ? seconds : null;
}

export function summarizeCommand(command: string): string {
	const flat = command.replace(/\s+/g, " ").trim();
	return flat.length > SUMMARY_LIMIT ? `${flat.slice(0, SUMMARY_LIMIT)}…` : flat;
}

function readIndex(path: string): BgJobRecord[] {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		return Array.isArray(parsed) ? (parsed as BgJobRecord[]) : [];
	} catch {
		return [];
	}
}

/** 原子写（与 `.data/` 既有习惯一致：同目录临时文件 + rename）。 */
function writeIndex(path: string, records: BgJobRecord[]): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(records, null, 2), "utf8");
	renameSync(tmp, path);
}

function upsertRecord(path: string, record: BgJobRecord): void {
	const records = readIndex(path);
	const index = records.findIndex((entry) => entry.id === record.id);
	if (index >= 0) records[index] = record;
	else records.push(record);
	writeIndex(path, records);
}

function tailOf(logPath: string): string {
	try {
		const text = readFileSync(logPath, "utf8");
		return text.length > LOG_TAIL_CHARS ? text.slice(-LOG_TAIL_CHARS) : text;
	} catch {
		return "";
	}
}

// ── 管理面（2026-11-10 批 21 §二）────────────────────────────
//
// 只做三件事：列任务 / 看日志尾部 / 杀本进程起的任务。
// **进程归属只看本进程的内存表**：重启后 index.json 里的 running 记录一律当"查不到活进程"，
// 绝不按 pid 去杀 —— pid 会被复用，杀错人比杀不掉更糟。

const liveJobs = new Map<string, ChildProcess>();

export interface BgJobView {
	id: string;
	commandSummary: string;
	startedAt: string;
	endedAt: string | null;
	exitCode: number | null;
	status: BgJobRecord["status"];
}

/** 列出索引里的任务（index 顺序 = 创建顺序）。坏文件/不存在都回空数组。 */
export function listBgJobs(dir: string = bashJobsDir()): BgJobView[] {
	return readIndex(indexPathOf(dir)).map((record) => ({
		id: record.id,
		commandSummary: record.commandSummary,
		startedAt: record.startedAt,
		endedAt: record.endedAt ?? null,
		exitCode: typeof record.exitCode === "number" ? record.exitCode : null,
		// 上一进程留下的 running 原样透出：本模块不替重启结算改账，
		// 也绝不把"索引说在跑"当成"活进程还在"（kill 的归属另看内存表）。
		status: record.status,
	}));
}

export interface BgJobLog {
	found: boolean;
	/** 尾部文本（最多 `BG_LOG_TAIL_LINES` 行） */
	log: string;
	/** 整份日志的行数（给调用方判断是否截断） */
	totalLines: number;
}

/** 日志尾部（最多 200 行）。未知 id / 非法 id / 日志不存在都回 found:false。 */
export function readBgJobLog(
	id: string,
	dir: string = bashJobsDir(),
	limit = BG_LOG_TAIL_LINES,
): BgJobLog {
	if (!JOB_ID_RE.test(id)) return { found: false, log: "", totalLines: 0 };
	if (!readIndex(indexPathOf(dir)).some((record) => record.id === id)) {
		return { found: false, log: "", totalLines: 0 };
	}
	let text: string;
	try {
		text = readFileSync(logPathOf(dir, id), "utf8");
	} catch {
		// 索引里有、日志被删了：仍然算"这个任务存在"，只是没有内容。
		return { found: true, log: "", totalLines: 0 };
	}
	const lines = text.split(/\r?\n/);
	// 末尾换行会切出一个空串，先去掉再数，否则"1 行"永远显示成 2 行。
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	const tail = lines.slice(-Math.max(1, limit)).join("\n");
	return { found: true, log: tail, totalLines: lines.length };
}

export type BgKillResult = "killed" | "unknown" | "not_running" | "not_owned";

/**
 * 杀一个本进程起的、仍在跑的任务。
 *
 * 用进程组（POSIX 上 spawn 时 `detached: true` 让它成为组长）或 `taskkill /T`
 * （Windows）连子进程一起收，否则 shell 活着、真正的命令还在跑。
 */
export function killBgJob(id: string, dir: string = bashJobsDir()): BgKillResult {
	if (!JOB_ID_RE.test(id)) return "unknown";
	const record = readIndex(indexPathOf(dir)).find((entry) => entry.id === id);
	if (!record) return "unknown";
	const child = liveJobs.get(id);
	if (!child || child.exitCode !== null || child.killed) return "not_owned";
	if (record.status !== "running") return "not_running";

	const pid = child.pid;
	if (pid === undefined) return "not_running";
	try {
		if (process.platform === "win32") {
			spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
		} else {
			// 负号 = 整个进程组；子进程是 detached 起的，组号就是它的 pid。
			process.kill(-pid, "SIGTERM");
		}
		return "killed";
	} catch (error) {
		console.warn(
			`[bg-job ${id}] kill 失败: ${error instanceof Error ? error.message : String(error)}`,
		);
		return "not_running";
	}
}

/**
 * 索引裁剪（启动时调一次）：超过 `limit` 条时，从最旧的**已结束**任务开始删索引条目；
 * 在跑的不删，日志文件一个都不删（按 id 还能找回原始输出）。
 * 返回被裁掉的条数。
 */
export function pruneBgIndex(
	dir: string = bashJobsDir(),
	limit = BG_INDEX_LIMIT,
): number {
	const path = indexPathOf(dir);
	const records = readIndex(path);
	if (records.length <= limit) return 0;
	const ended = records
		.filter((record) => record.status !== "running")
		.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
	const drop = new Set<string>();
	let remaining = records.length;
	for (const record of ended) {
		if (remaining <= limit) break;
		drop.add(record.id);
		remaining -= 1;
	}
	if (drop.size === 0) return 0;
	writeIndex(path, records.filter((record) => !drop.has(record.id)));
	return drop.size;
}

export interface MoveToBackgroundInput {
	command: string;
	cwd: string;
	/** 触发这次转后台的超时秒数（只用于文案） */
	timeoutSeconds: number;
	/** 任务结束时的回调：拿到终态记录 + 日志尾部（由装配层回灌会话） */
	onFinished?: (record: BgJobRecord, logTail: string) => void;
	/** 测试注入；缺省 `.data/bg-jobs` */
	dir?: string;
	env?: Record<string, string | undefined>;
}

export interface MovedJob {
	id: string;
	logPath: string;
	record: BgJobRecord;
	/** 立刻回给模型的那句话 */
	message: string;
}

/**
 * 起一个 detached 子进程继续跑同一条命令。**同步返回** id，兑现由 `onFinished` 收。
 * 进程随父进程退出不受影响（detached + unref）：后台就是后台。
 */
export function moveToBackground(input: MoveToBackgroundInput): MovedJob {
	const dir = input.dir ?? bashJobsDir();
	mkdirSync(dir, { recursive: true });

	const id = `bg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	const logPath = join(dir, `${id}.log`);
	const index = join(dir, "index.json");
	const record: BgJobRecord = {
		id,
		commandSummary: summarizeCommand(input.command),
		startedAt: new Date().toISOString(),
		status: "running",
	};
	upsertRecord(index, record);

	const fd = openSync(logPath, "a");
	const child = spawn(input.command, {
		shell: true,
		cwd: input.cwd,
		// 后台与前台同权限边界：继承同一个进程环境（测试可叠加几个无害变量）。
		env: { ...process.env, ...(input.env ?? {}) },
		detached: true,
		stdio: ["ignore", fd, fd],
		windowsHide: true,
	});
	closeSync(fd);
	// 管理面只认本进程起的活进程（kill 端点据此判断归属）。
	if (child.pid !== undefined) liveJobs.set(id, child);

	const finish = (exitCode: number | null, status: BgJobRecord["status"]): void => {
		liveJobs.delete(id);
		const done: BgJobRecord = { ...record, endedAt: new Date().toISOString(), exitCode, status };
		try {
			upsertRecord(index, done);
		} catch (error) {
			console.warn(
				`[bg-job ${id}] 写 index 失败: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		try {
			input.onFinished?.(done, tailOf(logPath));
		} catch (error) {
			console.warn(
				`[bg-job ${id}] 完成回调失败: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};

	child.once("error", () => finish(null, "failed"));
	child.once("close", (code, signal) => {
		finish(signal === null ? code : null, code === 0 ? "done" : "failed");
	});
	child.unref();

	return {
		id,
		logPath,
		record,
		message:
			`命令超过 ${input.timeoutSeconds} 秒仍在跑，已转到后台（任务 ${id}），完成后会告诉你结果。` +
			"别再重复执行同一条命令。",
	};
}

/** 工具结果替换（`afterTool` 用）：形状对齐 bash / powershell 的 structuredOutputSchema。 */
export interface ReplacementResult {
	readonly output: { type: "text"; text: string }[];
	readonly structuredOutput: { readonly output: string; readonly truncated: boolean; readonly exitCode: number };
	readonly isError: false;
}

export function replacedResult(message: string): ReplacementResult {
	return {
		output: [{ type: "text", text: message }],
		// exitCode = -1 是"尚未结束"的占位（真实退出码在完成消息与 index.json 里），
		// 不用 0 是因为 0 在程序语义里明确等于"成功"。
		structuredOutput: { output: message, truncated: false, exitCode: -1 },
		isError: false,
	};
}
