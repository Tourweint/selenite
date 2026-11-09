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

import { spawn } from "node:child_process";
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

/** 落点目录（不在 env 里开放：`index.json` 的路径属于部署细节，测试走参数注入）。 */
export function bashJobsDir(): string {
	return DEFAULT_DIR;
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

	const finish = (exitCode: number | null, status: BgJobRecord["status"]): void => {
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
