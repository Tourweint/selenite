import { exec } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { MemoryEngine } from "@lifediary/memory";

/**
 * 工具集。
 *
 * 为什么不是直接搬 pi 的 `coding-agent/core/tools/`：那套实现和 TUI 深度耦合
 * （read.ts 里 import 了主题、按键提示、代码高亮），搬过来要连 pi-tui 一起搬。
 * 但接口是干净的 —— 照 `AgentTool` 写，行为和 pi 的对齐。
 *
 * 危险工具（写文件、执行命令）在这里**没有闸门**，和 pi 的默认行为一致：
 * 以当前用户权限运行。pi 本身也不带权限系统，只有 `beforeToolCall` 钩子留给扩展。
 */

const execAsync = promisify(exec);

/** 单次读取上限，避免一个日志文件把上下文吃光 */
const MAX_READ_BYTES = 100_000;
const MAX_READ_LINES = 2_000;
/** 命令输出上限 */
const MAX_OUTPUT_CHARS = 8_000;
const COMMAND_TIMEOUT_MS = 30_000;

export interface ToolOptions {
	/** 工具解析相对路径的基准 */
	cwd: string;
	/** 记忆引擎；为 null 时 remember/recall 不可用 */
	memory: MemoryEngine | null;
}

function text(value: string) {
	return { content: [{ type: "text" as const, text: value }], details: {} };
}

function resolvePath(cwd: string, path: string): string {
	return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

function truncate(value: string, max: number): string {
	if (value.length <= max) return value;
	return `${value.slice(0, max)}\n\n…（已截断，原长 ${value.length} 字符）`;
}

export function createTools(options: ToolOptions): AgentTool[] {
	const { cwd, memory } = options;

	const readFileTool: AgentTool = {
		name: "read_file",
		label: "读取文件",
		description:
			"读取一个文本文件的内容。路径可以是相对路径（相对工作目录）或绝对路径。" +
			"大文件会被截断，可以用 offset/limit 分页读。",
		parameters: Type.Object({
			path: Type.String({ description: "文件路径" }),
			offset: Type.Optional(Type.Number({ description: "从第几行开始（1 起）" })),
			limit: Type.Optional(Type.Number({ description: "最多读多少行" })),
		}),
		execute: async (_toolCallId, params: any) => {
			const target = resolvePath(cwd, params.path);
			const info = await stat(target);
			if (!info.isFile()) throw new Error(`不是一个文件: ${params.path}`);
			if (info.size > MAX_READ_BYTES) {
				throw new Error(
					`文件太大（${Math.round(info.size / 1024)}KB，上限 ${MAX_READ_BYTES / 1000}KB）。请用 offset/limit 分段读。`,
				);
			}

			const raw = await readFile(target, "utf8");
			const lines = raw.split("\n");
			const offset = Math.max(1, params.offset ?? 1);
			const limit = Math.min(params.limit ?? MAX_READ_LINES, MAX_READ_LINES);
			const slice = lines.slice(offset - 1, offset - 1 + limit);
			const header = `# ${params.path}（第 ${offset}-${offset + slice.length - 1} 行，共 ${lines.length} 行）\n`;
			return text(header + slice.join("\n"));
		},
	};

	const listDirTool: AgentTool = {
		name: "list_dir",
		label: "列目录",
		description: "列出目录下的文件和子目录。不传路径时列出工作目录。",
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "目录路径，默认工作目录" })),
		}),
		execute: async (_toolCallId, params: any) => {
			const target = params.path ? resolvePath(cwd, params.path) : cwd;
			const entries = await readdir(target, { withFileTypes: true });
			const lines = entries
				.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()))
				.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
			return text(`${relative(cwd, target) || "."}：\n${lines.join("\n")}`);
		},
	};

	const writeFileTool: AgentTool = {
		name: "write_file",
		label: "写文件",
		description:
			"把内容写入文件，会覆盖原内容。父目录不存在会自动创建。" +
			"⚠️ 这个操作不可撤销。",
		parameters: Type.Object({
			path: Type.String({ description: "文件路径" }),
			content: Type.String({ description: "完整文件内容" }),
		}),
		execute: async (_toolCallId, params: any) => {
			const target = resolvePath(cwd, params.path);
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, params.content, "utf8");
			return text(`已写入 ${params.path}（${params.content.length} 字符）`);
		},
	};

	const runCommandTool: AgentTool = {
		name: "run_command",
		label: "执行命令",
		description:
			"在当前机器上执行一条 shell 命令并返回输出。有 30 秒超时。" +
			"⚠️ 以当前用户权限运行，没有沙箱。",
		parameters: Type.Object({
			command: Type.String({ description: "要执行的命令" }),
			cwd: Type.Optional(Type.String({ description: "工作目录，默认项目根" })),
		}),
		execute: async (_toolCallId, params: any) => {
			const workdir = params.cwd ? resolvePath(cwd, params.cwd) : cwd;
			try {
				const { stdout, stderr } = await execAsync(params.command, {
					cwd: workdir,
					timeout: COMMAND_TIMEOUT_MS,
					maxBuffer: 4 * 1024 * 1024,
					windowsHide: true,
				});
				return text(truncate(stdout + (stderr ? `\n[stderr]\n${stderr}` : ""), MAX_OUTPUT_CHARS));
			} catch (error) {
				// 命令失败也是一种结果，交给模型判断，不要抛出去中断整轮
				const err = error as { stdout?: string; stderr?: string; message?: string };
				return text(
					truncate(
						`命令失败：${err.message ?? "未知错误"}\n${err.stdout ?? ""}${err.stderr ?? ""}`,
						MAX_OUTPUT_CHARS,
					),
				);
			}
		},
	};

	const rememberTool: AgentTool = {
		name: "remember",
		label: "记住",
		description:
			"把一条值得长期记住的信息写进记忆库（用户是谁、偏好、长期目标、重要事实）。" +
			"日常琐事不必写，交给系统自动抽取。",
		parameters: Type.Object({
			content: Type.String({ description: "要记住的内容，一句话说清" }),
			kind: Type.Optional(
				Type.String({ description: "fact / preference / entity，默认 fact" }),
			),
			importance: Type.Optional(Type.Number({ description: "0-1，默认 0.8" })),
		}),
		execute: async (_toolCallId, params: any) => {
			if (!memory) throw new Error("记忆引擎未启用");
			const kind =
				params.kind === "preference" || params.kind === "entity" ? params.kind : "fact";
			const record = memory.remember({
				kind,
				scope: { type: "global" },
				content: params.content,
				importance: Math.min(1, Math.max(0, params.importance ?? 0.8)),
				source: "tool:remember",
			});
			return text(`已记住（${record.kind}）：${record.content}`);
		},
	};

	const recallTool: AgentTool = {
		name: "recall",
		label: "回忆",
		description: "从记忆库里检索和某个话题相关的旧记忆。看看以前记过什么。",
		parameters: Type.Object({
			query: Type.String({ description: "要回忆的话题或关键词" }),
			limit: Type.Optional(Type.Number({ description: "返回条数，默认 5" })),
		}),
		execute: async (_toolCallId, params: any) => {
			if (!memory) throw new Error("记忆引擎未启用");
			const limit = Math.min(20, Math.max(1, params.limit ?? 5));
			const hits = memory.recall({
				text: params.query,
				scopes: ["global"],
				limit,
			});
			if (hits.length === 0) return text("没有找到相关记忆。");
			return text(
				hits
					.map((hit) => `- [${hit.record.kind}] ${hit.record.content}`)
					.join("\n"),
			);
		},
	};

	return [readFileTool, listDirTool, writeFileTool, runCommandTool, rememberTool, recallTool];
}
