/**
 * 文件浏览入口探针（2026-11-06）：真起服务进程，走 HTTP 验三个端点与安全边界。
 *
 *   pnpm --filter @lifediary/server files
 *
 * 安全口径（方案验证表点名）：越权路径被拒、根层 .data 被屏蔽；
 * EXPLORER_OPEN 探针里**保持关闭**（不往用户桌面弹资源管理器），开启路径由单测注入 opener 覆盖。
 * 跑完把临时目录删掉。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = Number(process.env.PROBE_PORT ?? 8099);
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(ok: boolean, label: string, detail = ""): void {
	if (ok) {
		console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
	} else {
		failures += 1;
		console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

const FIXTURE = mkdtempSync(join(tmpdir(), "lifediary-files-probe-"));
const WORKSPACE = join(FIXTURE, "ws");
const PROJECTS_DB = join(FIXTURE, "projects.sqlite");

function startServer(extraEnv: NodeJS.ProcessEnv = {}): ChildProcess {
	const child = spawn(process.execPath, ["../../node_modules/tsx/dist/cli.mjs", "src/index.ts"], {
		cwd: import.meta.dirname ? `${import.meta.dirname}/..` : ".",
		env: {
			...process.env,
			PORT: String(PORT),
			LLM_PROVIDER: "faux",
			LLM_API_KEY: "",
			AGENT_TOKEN: "",
			AGENT_DB_PATH: join(FIXTURE, "agent.sqlite"),
			MEMORY_DB_PATH: join(FIXTURE, "memory.db"),
			PROJECTS_DB_PATH: PROJECTS_DB,
			PROVIDERS_PATH: join(FIXTURE, "providers.json"),
			AGENT_LOCAL_SECRET_PATH: join(FIXTURE, "local-secret"),
			// 探针绝不往用户桌面弹资源管理器：默认关，只验 400 形态；开启路径单测覆盖
			EXPLORER_OPEN: "false",
			NODE_OPTIONS: "",
			...extraEnv,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		const text = chunk.toString();
		if (!text.includes("ExperimentalWarning")) process.stderr.write(`  [server] ${text}`);
	});
	return child;
}

async function waitForReady(): Promise<void> {
	for (let attempt = 0; attempt < 60; attempt += 1) {
		try {
			const response = await fetch(`${BASE}/healthz`);
			if (response.ok) return;
		} catch {
			/* not up yet */
		}
		await sleep(250);
	}
	throw new Error("服务没能启动");
}

async function stopServer(child: ChildProcess): Promise<void> {
	child.kill();
	for (let attempt = 0; attempt < 40; attempt += 1) {
		if (child.exitCode !== null) return;
		await sleep(100);
	}
	child.kill("SIGKILL");
}

async function main(): Promise<void> {
	// 摆测试现场：工作区根 + 一个文件 + 根层 .data + 一个已登记子项目
	mkdirSync(join(WORKSPACE, "notes"), { recursive: true });
	mkdirSync(join(WORKSPACE, ".data"), { recursive: true });
	writeFileSync(join(WORKSPACE, "readme.md"), "probe 内容");
	writeFileSync(join(WORKSPACE, "notes", "a.txt"), "aaa");
	writeFileSync(join(WORKSPACE, ".data", "providers.json"), "{}");

	const child = startServer();
	try {
		await waitForReady();

		// 登记工作区与子项目（走真接口，与界面同一链路）
		let response = await fetch(`${BASE}/api/v1/workspaces`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ rootPath: WORKSPACE }),
		});
		check(response.ok, "登记工作区");
		response = await fetch(`${BASE}/api/v1/projects`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "demo", path: "demo" }),
		});
		const proposal = ((await response.json()) as { proposal?: { id: string } }).proposal;
		check(Boolean(proposal), "提交子项目 proposal");
		response = await fetch(`${BASE}/api/v1/projects/${proposal?.id}/confirm`, { method: "POST" });
		check(response.ok, "确认子项目");
		const projectId = ((await response.json()) as { project?: { id: string } }).project?.id ?? "";

		// ── 列目录 ──
		response = await fetch(`${BASE}/api/v1/files`);
		const list = (await response.json()) as {
			ok?: boolean;
			path?: string;
			entries?: { name: string; type: string }[];
		};
		check(
			response.status === 200 && list.ok === true && list.path === "",
			"GET /files 根目录列表",
		);
		const names = (list.entries ?? []).map((entry) => entry.name);
		check(names.includes("readme.md") && names.includes("notes"), "列表含文件与目录");
		check(!names.includes(".data"), "根层 .data 不出现在列表里（屏蔽）");

		response = await fetch(`${BASE}/api/v1/files?path=notes`);
		const nested = (await response.json()) as { entries?: { name: string }[] };
		check(
			response.status === 200 &&
				(nested.entries ?? []).map((entry) => entry.name).join(",") === "a.txt",
			"GET /files 子目录列表",
		);

		// ── 看文本 ──
		response = await fetch(`${BASE}/api/v1/files/content?path=readme.md`);
		const content = (await response.json()) as { content?: string; truncated?: boolean };
		check(
			response.status === 200 && content.content === "probe 内容" && content.truncated === false,
			"GET /files/content 回文本正文",
		);

		writeFileSync(join(WORKSPACE, "big.txt"), Buffer.alloc(512 * 1024 + 1, 0x61));
		response = await fetch(`${BASE}/api/v1/files/content?path=big.txt`);
		const big = (await response.json()) as { content?: string | null; truncated?: boolean };
		check(
			response.status === 200 && big.content === null && big.truncated === true,
			"超大文件只给元信息（>512KB 不回正文）",
		);

		// ── 安全用例 ──
		response = await fetch(`${BASE}/api/v1/files?path=${encodeURIComponent("../outside")}`);
		check(response.status === 400, "越权路径被拒（..）", `HTTP ${response.status}`);
		response = await fetch(`${BASE}/api/v1/files/content?path=.data/providers.json`);
		check(response.status === 400, "根层 .data 被屏蔽", `HTTP ${response.status}`);
		const outside = mkdtempSync(join(tmpdir(), "lifediary-files-probe-out-"));
		symlinkSync(outside, join(WORKSPACE, "link"), "junction");
		response = await fetch(`${BASE}/api/v1/files?path=link`);
		check(response.status === 400, "符号链接逃逸被拒（realpath 复核）", `HTTP ${response.status}`);
		rmSync(outside, { recursive: true, force: true });
		response = await fetch(`${BASE}/api/v1/files?path=${encodeURIComponent(WORKSPACE)}`);
		check(response.status === 400, "绝对路径被拒", `HTTP ${response.status}`);

		// ── open-explorer：探针里开关关着，验 400 形态（不弹窗口）──
		response = await fetch(`${BASE}/api/v1/workspaces/open-explorer`, { method: "POST" });
		check(
			response.status === 400,
			"EXPLORER_OPEN=false 时 open-explorer 关闭（400）",
			`HTTP ${response.status}`,
		);

		// ── FILE_BROWSE=false：整体下线 ──
		await stopServer(child);
		const off = startServer({ FILE_BROWSE: "false", EXPLORER_OPEN: "false" });
		try {
			await waitForReady();
			response = await fetch(`${BASE}/api/v1/files`);
			check(response.status === 404, "FILE_BROWSE=false 时 /files 下线（404）");
			response = await fetch(`${BASE}/api/v1/files/content?path=readme.md`);
			check(response.status === 404, "FILE_BROWSE=false 时 /files/content 下线（404）");
		} finally {
			await stopServer(off);
		}
	} finally {
		if (child.exitCode === null) await stopServer(child);
		rmSync(FIXTURE, { recursive: true, force: true });
	}

	console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
	if (failures > 0) process.exit(1);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
