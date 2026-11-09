/**
 * 只读命令白名单（2026-11-09 任务书 T3 §2）。
 *
 * 目的只有一个：**降噪**。"读自己工作区里的文件"不该每次都弹一次审批。
 *
 * 铁律（改动前先读）：
 * 1. **只能把 `ask` 变 `allow`**。判定顺序固定为
 *    `readOnlyBlockReason()`（拦）→ 审批判定 → 本白名单。白名单永远碰不到 `block`。
 * 2. **默认关**（`AGENT_READ_ALLOWLIST`，缺省 false）：这是放宽行为，先观望。
 * 3. 任何"不确定"一律返回 false（= 照常问）。白名单只认最朴素的形态。
 *
 * 只认：`bash` / `powershell`、单条命令、字面量路径、全部落在当前工作区内。
 * 出现管道 / 重定向 / 命令分隔 / 变量 / 通配 / 反引号 / 子 shell / `~` / `%` 一律不放行。
 */

import { isAbsolute, basename, resolve } from "node:path";
import { insideOrEqual, realTargetOf } from "./path-guard.ts";

/** 纯读词表：不含任何写 / 删 / 改 / 网络词。 */
export const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
	"cat",
	"head",
	"tail",
	"grep",
	"rg",
	"ls",
	"dir",
	"type",
	"where",
	"file",
	"stat",
	"wc",
	"sort",
	"uniq",
	"find",
]);

/** 只对这两个工具生效。 */
const SHELL_TOOLS: ReadonlySet<string> = new Set(["bash", "powershell"]);

/**
 * 会改变语义或逃出工作区的字符：
 * 管道 `|`、重定向 `< >`、命令分隔 `; &`、变量 `$ %`、通配 `* ?`、
 * 反引号 / 子 shell `(` `)`、历史展开 `!`、换行。
 *
 * 刻意**不含 `~`**：Windows 的 8.3 短路径（`TOURWE~1`）合法地带这个字符，
 * 家目录展开改在 token 层判（只有"以 `~` 开头"才是展开）。
 */
const FORBIDDEN = /[|<>;&$%*?`()!\r\n]/;

/** 回滚 / 观望开关：默认 false（这是放宽行为，默认必须"行为不变"）。 */
export function readAllowlistEnabled(env: Record<string, string | undefined> = process.env): boolean {
	const raw = env.AGENT_READ_ALLOWLIST?.trim().toLowerCase();
	return raw === "1" || raw === "true" || raw === "on";
}

function commandOf(args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const value = (args as Record<string, unknown>).command;
	return typeof value === "string" && value.trim() ? value : undefined;
}

/** 去掉一层成对的引号（命令里出现引号本身不危险，但解析路径前要去掉）。 */
function unquote(token: string): string {
	if (token.length >= 2) {
		const first = token[0];
		const last = token[token.length - 1];
		if ((first === "'" || first === '"') && last === first) return token.slice(1, -1);
	}
	return token;
}

/**
 * 这条命令是不是"只读且只碰工作区内的路径"。
 *
 * 纯函数：不读全局状态、不碰磁盘以外的环境。入参口径与 `path-guard.ts` 一致
 * （`workspaceRoot` 必须是 realpath；未设工作区传 null → 一律不放行）。
 */
export function isReadOnlyShellCommand(
	toolName: string,
	args: unknown,
	workspaceRoot: string | null,
	cwd: string,
): boolean {
	if (!SHELL_TOOLS.has(toolName)) return false;
	// 没有工作区根就无法证明"在自己文件里"，保守照常问。
	if (!workspaceRoot) return false;

	const raw = commandOf(args);
	if (!raw) return false;
	if (FORBIDDEN.test(raw)) return false;

	const tokens = raw
		.trim()
		.split(/\s+/)
		.map(unquote)
		.filter((token) => token.length > 0);
	if (tokens.length === 0) return false;

	const head = basename(tokens[0].replace(/\\/g, "/")).toLowerCase().replace(/\.exe$/, "");
	if (!READ_ONLY_COMMANDS.has(head)) return false;

	for (const token of tokens.slice(1)) {
		// 家目录展开会逃出工作区；`~` 只在开头才有展开语义（8.3 短路径里的 `~1` 不算）。
		if (token.startsWith("~")) return false;
		// 选项与 `--` 分隔符不是路径；选项的取值（如 `-n 100` 的 100）会被当成
		// 相对路径解析，落在工作区内即放行，越界仍会被下面拦下。
		if (token === "--" || token.startsWith("-")) continue;
		const target = realTargetOf(isAbsolute(token) ? token : resolve(cwd, token));
		if (!insideOrEqual(workspaceRoot, target)) return false;
	}

	return true;
}
