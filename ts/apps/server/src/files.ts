/**
 * 文件浏览入口（2026-11-06，方案：docs/设计方案/2026-11-06-文件浏览入口（桌面资源管理器与手机端）.md）。
 *
 * 三个只读端点，性质不同：
 *   POST /api/v1/workspaces/open-explorer —— 本机便利入口：在用户电脑上弹出系统资源管理器
 *     （默认工作区根；带 projectId 时打开该项目自己的根——侧栏按项目直达，用户诉求是
 *     「多个工作区不知道打开哪个」）。
 *   GET /api/v1/files / GET /api/v1/files/content —— 工作区只读浏览：手机读不到电脑磁盘，
 *     必须由服务端出接口。只收**工作区内相对路径**，没有"看工作区外"的入口。
 *
 * 安全底线（与 path-guard.ts 同口径）：
 *   - 相对路径字形校验（拒绝绝对路径与 `..`）之后，再用 realpath 复核落点在工作区内
 *     （符号链接祖先逃逸拦住）；
 *   - 根层屏蔽 `.data`（密钥与令牌哈希所在，"不下发客户端"的延伸口径）；
 *   - 正文只回 UTF-8 可解码且 ≤512KB 的文本；
 *   - 全部走 /api/v1/* 鉴权，失败 403 空体；业务拒绝 400 带说明。
 *
 * 回滚开关：`EXPLORER_OPEN=false` → open-explorer 返回 400（回到无此端点形态）；
 *           `EXPLORER_FOCUS=false` → Windows 上退回裸 spawn explorer（窗口会被压在底层）；
 *           `FILE_BROWSE=false` → files 两个端点整体下线（404）。
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Context, Hono } from "hono";
import type { FileEntry } from "@lifediary/shared";
import { projectsStore, workspaceRootReal, type ProjectsStore } from "./projects.ts";

/** 正文上限：512KB（方案定稿） */
const MAX_CONTENT_BYTES = 512 * 1024;

export function fileBrowseEnabled(): boolean {
	return (process.env.FILE_BROWSE?.trim() || "true").toLowerCase() !== "false";
}

export function explorerOpenEnabled(): boolean {
	return (process.env.EXPLORER_OPEN?.trim() || "true").toLowerCase() !== "false";
}

/** 焦点式打开（2026-11-11）：`false` = Windows 退回裸 spawn（旧形态）。 */
export function explorerFocusEnabled(): boolean {
	return (process.env.EXPLORER_FOCUS?.trim() || "true").toLowerCase() !== "false";
}

/** 打开目录的命令（按平台）；提成可注入是为了探针/单测不真弹窗口。 */
export type Opener = (dir: string) => void;

/**
 * Windows 焦点式打开（2026-11-11 用户拍板「直接弹到顶层」）：
 * 服务是无窗口的后台进程，裸 spawn explorer 的窗口会被 Windows 前台规则压在最底层
 * （2026-11-11 实测：裸 spawn 与 Shell COM 裸开都不拿前台）。
 *
 * 2026-11-13 提速：以前整条链（PowerShell 启动 → COM 开窗 → 轮询句柄 → 切前台）
 * 串行跑完窗口才出现，点完要等 1~2s。现在拆成两步并行——
 *   ① 直接 spawn explorer：~200ms 窗口就出来（用户感知的"慢"大头是等 PowerShell）；
 *   ② 本脚本并行起 PowerShell，只做「认领 + 切前台」：按 LocationURL 认到
 *      ①开出的窗口 → SwitchToThisWindow。窗口出现到切前台之间有零点几秒可能垫底，
 *      终态仍在顶层——这是提速换来的窗口期，实测可接受（2026-11-13）。
 * SwitchToThisWindow 是 user32 未文档化但长期稳定的 API（explorer 任务栏同款），
 * 配 EXPLORER_FOCUS 回滚开关兜底（false = 退回裸 spawn，窗口可能垫底）。
 * 必须走 -File 传脚本文件：-EncodedCommand 形态下 Shell COM 开不出窗口
 * （2026-11-11 二分定位：-File ±NonInteractive 都正常，-EncodedCommand 必挂）；
 * 路径经 argv 传入，顺带绕开中文路径的文件编码问题（脚本本体保持纯 ASCII）。
 * 焦点脚本的 spawn 不能带 detached：DETACHED_PROCESS 下 PowerShell 没有控制台直接起不来
 * （2026-11-11 二分定位：windowsHide 单独用正常，detached ± windowsHide 都死）；
 * windowsHide 已给子进程独立隐藏控制台，不会被服务端 Ctrl+C 连带杀掉。
 */
const WINDOWS_FOCUS_OPEN_PS1 = `param([string]$Dir)

$sh = New-Object -ComObject Shell.Application
$uri = ([System.Uri]$Dir).AbsoluteUri
$h = 0
for ($i = 0; $i -lt 50; $i++) {
  Start-Sleep -Milliseconds 100
  $w = @($sh.Windows() | Where-Object { $_.LocationURL -eq $uri })[0]
  if ($w) { $h = $w.HWND; break }
}
if ($h -ne 0) {
  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class FgSwitch { [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool altTab); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }'
  # 窗口刚创建的前几百毫秒可能还在开屏动画，切了会被顶回来——切了就复核，没拿住重试
  for ($i = 0; $i -lt 6; $i++) {
    [FgSwitch]::SwitchToThisWindow([IntPtr]$h, $true)
    Start-Sleep -Milliseconds 120
    if ([FgSwitch]::GetForegroundWindow() -eq [IntPtr]$h) { break }
  }
}
`;

function platformOpen(dir: string): void {
	if (process.platform === "win32" && explorerFocusEnabled()) {
		// ① 先开窗：explorer 自己 spawn，不等 PowerShell。
		spawn("explorer", [dir], { detached: true, stdio: "ignore" }).unref();
		// ② 再并行起焦点脚本认领+切前台；脚本落临时目录再 -File 起进程。
		try {
			const scriptPath = join(tmpdir(), "lifediary-open-focus.ps1");
			writeFileSync(scriptPath, WINDOWS_FOCUS_OPEN_PS1, "utf8");
			const focus = spawn(
				"powershell",
				[
					"-NoProfile",
					"-NonInteractive",
					"-ExecutionPolicy",
					"Bypass",
					"-File",
					scriptPath,
					"-Dir",
					dir,
				],
				// 不能加 detached（DETACHED_PROCESS 杀死 PowerShell，见上注）；unref 只是不等它。
				{ stdio: "ignore", windowsHide: true },
			);
			focus.unref();
		} catch {
			// 焦点脚本没跑起来（落盘失败等）→ 窗口已经开了，只是可能垫底（=回滚形态）。
		}
		return;
	}
	const command =
		process.platform === "win32" ? "explorer" : process.platform === "darwin" ? "open" : "xdg-open";
	const child = spawn(command, [dir], { detached: true, stdio: "ignore" });
	child.unref();
}

/* ── 路径解析（与 path-guard.ts 的 realTarget / insideOrEqual 同口径）──────── */

function samePath(a: string, b: string): boolean {
	const left = resolve(a);
	const right = resolve(b);
	return process.platform === "win32"
		? left.toLowerCase() === right.toLowerCase()
		: left === right;
}

/** 根自身也算"在根内"。 */
function insideOrEqual(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * 根目录内相对路径 → 已复核的绝对落点（2026-11-12 起根可以是工作区根或项目根）。
 * 只做字形校验 + realpath 复核；"必须存在"由调用方按 file / dir 分别断言。
 * 根层 `.data` 在这里拦（根层 = 第一段），根内嵌套的 .data 不屏蔽
 * （方案口径：屏蔽的是存配置与令牌哈希的根层 .data）。
 */
export function resolveInsideWorkspace(
	rootDir: string,
	rawPath: string,
): { rel: string; target: string } {
	const raw = rawPath.trim().replace(/\\/g, "/");
	if (isAbsolute(rawPath.trim()) || /^[a-zA-Z]:/.test(raw)) {
		throw new FileBrowseError("bad_path", "只接受目录内的相对路径");
	}
	const segments = raw.split("/").filter((segment) => segment && segment !== ".");
	if (segments.some((segment) => segment === "..")) {
		throw new FileBrowseError("outside_workspace", "路径不能包含 ..");
	}
	if (segments[0] === ".data") {
		throw new FileBrowseError("blocked_path", "这个路径不对外");
	}
	const rel = segments.join("/");
	const target = rel ? resolve(rootDir, rel) : resolve(rootDir);
	if (!existsSync(target)) {
		throw new FileBrowseError("not_found", "路径不存在", 404);
	}
	// realpath 复核：符号链接祖先逃逸在这里拦住。
	const real = realpathSync(target);
	if (!insideOrEqual(rootDir, real)) {
		throw new FileBrowseError("outside_workspace", "路径经 realpath 解析后落在目录外");
	}
	return { rel, target: real };
}

/** 业务拒绝（400 带说明 / 404）；鉴权失败仍然是 403 空体。 */
export class FileBrowseError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status: 400 | 404 = 400,
	) {
		super(message);
	}
}

function listEntries(target: string, isWorkspaceRoot: boolean): FileEntry[] {
	const dirents = readdirSync(target, { withFileTypes: true });
	const entries: FileEntry[] = [];
	for (const dirent of dirents) {
		const full = join(target, dirent.name);
		let size = 0;
		let updatedAt = new Date(0).toISOString();
		try {
			const stat = statSync(full);
			size = dirent.isDirectory() ? 0 : stat.size;
			updatedAt = stat.mtime.toISOString();
		} catch {
			// 读不到元信息（权限/竞态删除）：仍列出，元信息留空。
		}
		entries.push({
			name: dirent.name,
			type: dirent.isDirectory() ? "dir" : "file",
			size,
			updatedAt,
		});
	}
	entries.sort((a, b) => {
		if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
	return entries;
}

export interface FilesDeps {
	readonly store: ProjectsStore;
	readonly open: Opener;
}

function errorResponse(c: Context, error: unknown) {
	if (error instanceof FileBrowseError) {
		return c.json({ error: error.code, message: error.message }, error.status);
	}
	const detail = error instanceof Error ? error.message : String(error);
	// 原始错误只进服务端日志（可能带磁盘路径）；对外只给通用说明。
	console.warn(`[files] ${detail}`);
	return c.json({ error: "internal", message: "文件浏览失败" }, 500);
}

export function mountFiles(app: Hono, deps?: Partial<FilesDeps>): void {
	const storeOf = (): ProjectsStore =>
	deps?.store ?? projectsStore(); // 懒取全局登记表；单测用 deps.store 注入隔离库
	const opener: Opener = deps?.open ?? platformOpen;

	/**
	 * 文件浏览的根（2026-11-12 多根）：带 `projectId` 用该项目自己的根（可以在工作区外），
	 * 缺省仍是工作区根。`path` 始终是**相对这个根**的路径。
	 */
	const rootFor = (c: Context):
		| { ok: true; root: string }
		| { ok: false; error: string; message: string } => {
		const projectId = c.req.query("projectId")?.trim() || "";
		if (projectId) {
			const result = storeOf().resolveForUse(projectId);
			if (!result.ok) return { ok: false, error: "bad_project", message: result.message };
			return { ok: true, root: result.project.rootPath };
		}
		const root = workspaceRootReal(storeOf());
		if (!root) return { ok: false, error: "no_workspace", message: "还没有选定工作区" };
		return { ok: true, root };
	};

	/** 打开资源管理器（桌面端；手机不提供此入口——手机上"打开资源管理器"无意义）。 */
	app.post("/api/v1/workspaces/open-explorer", async (c) => {
		if (!explorerOpenEnabled()) {
			return c.json({ error: "explorer_disabled", message: "资源管理器入口已关闭（EXPLORER_OPEN=false）" }, 400);
		}
		const body = (await c.req.json().catch(() => ({}))) as { projectId?: unknown } | null;
		const projectId = typeof body?.projectId === "string" ? body.projectId.trim() : "";
		const store = storeOf();
		try {
			let dir: string;
			if (projectId) {
				// 按项目直达自己的根：复用派单同一套复核（存在、未移除、realpath）。
				const result = store.resolveForUse(projectId);
				if (!result.ok) {
					return c.json({ error: "bad_project", message: result.message }, 400);
				}
				dir = result.project.rootPath;
			} else {
				const root = workspaceRootReal(store);
				if (!root) {
					return c.json({ error: "no_workspace", message: "还没有选定工作区" }, 400);
				}
				dir = root;
			}
			opener(dir);
			return c.json({ ok: true, path: dir });
		} catch (error) {
			return errorResponse(c, error);
		}
	});

	/** 目录列表（只读；path 缺省 = 根目录；projectId 指定项目根）。 */
	app.get("/api/v1/files", (c) => {
		if (!fileBrowseEnabled()) return c.notFound();
		try {
			const resolved = rootFor(c);
			if (!resolved.ok) {
				return c.json({ error: resolved.error, message: resolved.message }, 400);
			}
			const { rel, target } = resolveInsideWorkspace(resolved.root, c.req.query("path") ?? "");
			if (!statSync(target).isDirectory()) {
				return c.json({ error: "bad_path", message: "路径不是目录" }, 400);
			}
			const entries = listEntries(target, rel === "")
				// 根层的 .data 不列出（不泄密钥配置所在）；其余隐藏文件照常列出。
				.filter((entry) => !(rel === "" && entry.name === ".data"));
			return c.json({ ok: true, path: rel, entries });		} catch (error) {
			return errorResponse(c, error);
		}
	});

	/** 文本内容（只读）。二进制与 >512KB 不回正文，只给元信息。 */
	app.get("/api/v1/files/content", async (c) => {
		if (!fileBrowseEnabled()) return c.notFound();
		try {
			const resolved = rootFor(c);
			if (!resolved.ok) {
				return c.json({ error: resolved.error, message: resolved.message }, 400);
			}
			const { rel, target } = resolveInsideWorkspace(resolved.root, c.req.query("path") ?? "");
			const stat = statSync(target);
			if (!stat.isFile()) {
				return c.json({ error: "bad_path", message: "路径不是文件" }, 400);
			}
			const size = stat.size;
			if (size > MAX_CONTENT_BYTES) {
				// 超大文件：只给元信息。日志只记字节数，不记内容。
				console.log(`[files] content skipped (too large) bytes=${size}`);
				return c.json({ ok: true, path: rel, size, truncated: true, content: null });
			}
			const buffer = await readFile(target);
			const isBinary = buffer.includes(0);
			if (isBinary) {
				console.log(`[files] content skipped (binary) bytes=${size}`);
				return c.json({ ok: true, path: rel, size, truncated: true, content: null });
			}
			console.log(`[files] content bytes=${size}`);
			return c.json({ ok: true, path: rel, size, truncated: false, content: buffer.toString("utf8") });
		} catch (error) {
			return errorResponse(c, error);
		}
	});
}
