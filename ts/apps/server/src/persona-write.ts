import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { flagEnabled } from "./flags.ts";

/**
 * persona-metric 记忆库写入（2026-11-17 persona_write 批，方案见
 * docs/设计方案/2026-11-17-写记忆库工具（persona_write）.md）。
 *
 * 用户口径：**自动提取的记忆不送大记忆库**（现状本来就不送）；只有主人**明确让写**时才写——
 * 典型场景 = 库里记错了，主人纠正一句，把原话记进 `user_statement` 表
 * （persona-metric 的最高优先事实源，旧的错记录不删只降权）。
 *
 * 契约（跨仓，只有一份，落点=设计方案文档）：
 *   `python <repair.py> statement <body> [--about <时间>] [--tag <标签>] --why <原因>`
 *   - repair.py 按 sha1(body) 幂等（同原话重跑 REPLACE 同一行）；
 *   - stdout 一行 `已记：<body[:50]>`，退出码 0 = 成功；
 *   - 每刀强制 `--why` 进 change_log（persona-metric 侧的留痕纪律）。
 *
 * 纪律（与 persona-ask 同壳）：
 *   - 子进程 argv 数组传参，不用 shell——模型只能影响三条文本字段，没有注入面；
 *   - 失败一律降级 `ok:false`，不抛异常打断对话轮；
 *   - 日志只记字数 / 耗时 / ok，**不记 body 原文**。
 *   - 审批面在 tools.ts 之外由 capability 承担：`needsApproval:"critical"` = 每写必弹审批，
 *     「明确让写了才写」的技术 enforcement。
 */

/** 超时预算：repair.py 是单条 insert + change_log，15s 上限（与 ask 同口径）。 */
export const PERSONA_WRITE_TIMEOUT_MS = 15_000;
/** stderr 只留够取第一行的量（可能含本机路径，绝不整段落日志）。 */
const STDERR_KEEP = 4_096;
/** body / why 的长度上限（一条口述纠正不该是长文；超了直接拒绝，不静默截断）。 */
export const PERSONA_WRITE_BODY_MAX = 500;
export const PERSONA_WRITE_WHY_MAX = 200;

export interface PersonaWriteResult {
	ok: boolean;
	/** repair.py 的确认行（成功时），或失败原因（不含 stderr 全文）。 */
	line?: string;
	/** 写进 change_log 的 id（us-xxx），方便主人日后在 repair.py log 里对账。 */
	statementId?: string;
	error?: string;
}

export interface PersonaWriteInput {
	/** 主人原话，不改写不总结。 */
	body: string;
	/** 为什么写这条（进 change_log 的 reason）。 */
	why: string;
	/** 这件事发生在什么时候（YYYY-MM / YYYY-MM-DD），不知道就不给。 */
	about?: string;
	/** 小标签（如「时间修正」「错认主体」）。 */
	tag?: string;
}

/** 测试注入口：假 spawn / 假 env / 缩短超时；生产不传。 */
export interface PersonaWriteDeps {
	env?: NodeJS.ProcessEnv;
	spawnFn?: typeof spawn;
	timeoutMs?: number;
	/**
	 * 通用写入口命令（2026-11-23 多语言入口）：`["python", "<abs>/repair.py"]` /
	 * `["node", "<abs>/repair.js"]` / `["<abs>/repair"]`。传了就不再依赖
	 * `PERSONA_REPAIR` / `PERSONA_PYTHON`（外接库槽位走这里）。
	 */
	command?: string[];
	/** 写入口命令的工作目录（多语言入口的相对 import 用）。 */
	cwd?: string;
}

/**
 * 显式开关（`PERSONA_WRITE_ENABLED`，**默认关**——这是往主人一生库里落字的工具）。
 * 与路径闸的关系：路径可用 = 可启用；ENABLED=false = 显式关。双闸都过才注册工具。
 */
export function personaWriteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return flagEnabled("PERSONA_WRITE_ENABLED", env);
}

/**
 * repair.py 路径解析：`PERSONA_REPAIR` 显式配置优先；否则从 `PERSONA_MEMORY_ASK`
 * （ask.py）同目录推导 `repair.py`——零新增 env 配置。都不存在 = 不可用。
 */
export function repairScriptPath(env: NodeJS.ProcessEnv = process.env): string {
	const explicit = env.PERSONA_REPAIR?.trim();
	if (explicit) return explicit;
	const ask = env.PERSONA_MEMORY_ASK?.trim();
	return ask ? join(dirname(ask), "repair.py") : "";
}

/** repair.py 路径与 Python 命令都非空才算可用（默认态未配置 → 工具不上架）。 */
export function writePersonaAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
	const script = repairScriptPath(env);
	const python = (env.PERSONA_PYTHON?.trim() || "python").trim();
	return Boolean(script) && Boolean(python);
}

/** 文本字段长度校验：超限拒绝（错误信息回给模型，让它拆短或问主人）。 */
export function validatePersonaWriteInput(input: PersonaWriteInput): string | null {
	const body = input.body?.trim() ?? "";
	if (!body) return "body 不能为空：要存的是主人的原话，请让主人说清楚要记什么。";
	if ([...body].length > PERSONA_WRITE_BODY_MAX) {
		return `body 超过 ${PERSONA_WRITE_BODY_MAX} 字：一条口述纠正不该是长文，请主人拆成几条或缩成一句。`;
	}
	const why = input.why?.trim() ?? "";
	if (!why) return "why 不能为空：每一刀都要留痕（写进 change_log），说明为什么要记这条。";
	if ([...why].length > PERSONA_WRITE_WHY_MAX) {
		return `why 超过 ${PERSONA_WRITE_WHY_MAX} 字，请压缩成一句理由。`;
	}
	return null;
}

/**
 * 经 repair.py 写一条用户口述事实。
 *
 * 未配置 / 显式关闭 / 超时 / 启动失败 / 非零退出 —— 一律返回 `ok:false`，**绝不抛异常**。
 */
export function personaWrite(
	input: PersonaWriteInput,
	deps: PersonaWriteDeps = {},
): Promise<PersonaWriteResult> {
	const env = deps.env ?? process.env;
	const command = deps.command && deps.command.length > 0 ? deps.command : null;
	if (!personaWriteEnabled(env) || (!command && !writePersonaAvailable(env))) {
		return Promise.resolve({
			ok: false,
			error: "persona 记忆库写入未启用（PERSONA_WRITE_ENABLED=false 或 repair.py 路径不可用）",
		});
	}

	const problem = validatePersonaWriteInput(input);
	if (problem) return Promise.resolve({ ok: false, error: problem });

	const script = command ? "" : repairScriptPath(env);
	const python = command ? "" : env.PERSONA_PYTHON?.trim() || "python";
	const commandPrefix = command ?? [python, script];
	const timeoutMs = deps.timeoutMs ?? PERSONA_WRITE_TIMEOUT_MS;
	const spawnFn = deps.spawnFn ?? spawn;
	const startedAt = Date.now();

	// argv 拼死：运行器 + 固定脚本 + statement 子命令，模型自由度只有三条文本字段。
	const argv = ["statement", input.body.trim()];
	if (input.about?.trim()) argv.push("--about", input.about.trim());
	if (input.tag?.trim()) argv.push("--tag", input.tag.trim());
	argv.push("--why", input.why.trim());

	return new Promise<PersonaWriteResult>((resolve) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let child: ChildProcess | undefined;

		const finish = (result: PersonaWriteResult): void => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			// 只记字数 / 耗时 / 状态，不记 body 原文（硬约束）。
			console.log(`[persona-write] body=${[...input.body.trim()].length}字 ok=${result.ok} ${Date.now() - startedAt}ms`);
			resolve(result);
		};

		try {
			child = spawnFn(commandPrefix[0], [...commandPrefix.slice(1), ...argv], {
				...(deps.cwd ? { cwd: deps.cwd } : {}),
				windowsHide: true,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			finish({
				ok: false,
				error: `persona 写入启动失败：${(error instanceof Error ? error.message : String(error)).slice(0, 120)}`,
			});
			return;
		}

		timer = setTimeout(() => {
			try {
				child?.kill();
			} catch {
				// 进程可能已退出；超时结果照常返回
			}
			finish({ ok: false, error: "persona 写入超时（15s）" });
		}, timeoutMs);

		const stdout: Buffer[] = [];
		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer | string) => {
			stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		});
		child.stderr?.on("data", (chunk: Buffer | string) => {
			if (stderr.length < STDERR_KEEP) stderr += chunk.toString();
		});
		child.once("error", (error: Error) => {
			finish({ ok: false, error: `persona 写入启动失败：${error.message.slice(0, 120)}` });
		});
		child.once("close", (code: number | null) => {
			if (settled) return;
			if (code !== 0) {
				// stderr 可能含本机路径：只取第一行、截 120 字，绝不整段落日志。
				const firstLine = stderr
					.split(/\r?\n/)
					.map((line) => line.trim())
					.find(Boolean)
					?.slice(0, 120);
				finish({
					ok: false,
					error: `persona 写入失败（退出码 ${code ?? "unknown"}）${firstLine ? `：${firstLine}` : ""}`,
				});
				return;
			}
			const line = Buffer.concat(stdout)
				.toString("utf8")
				.split(/\r?\n/)
				.map((l) => l.trim())
				.find(Boolean);
			// repair.py 的 stmt_id = "us-" + sha1(body)[:10]（确定性）；本地同式计算，免得再起进程查。
			const statementId = `us-${createHash("sha1").update(input.body.trim()).digest("hex").slice(0, 10)}`;
			finish({ ok: true, statementId, ...(line ? { line } : {}) });
		});
	});
}
