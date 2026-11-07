/**
 * 产物冒烟：`pnpm --filter @lifediary/server dist:probe`（2026-11-08 扫尾批 4b）。
 *
 * 验的不是源码，而是 `pnpm build` 出来的 dist：
 *   1. `node dist/index.js` 能在**空目录**里起来（cwd 隔离 → .env / .data 都不碰真实的）；
 *   2. `/healthz` 通、`/` 能出界面（`web/` 按 import.meta.url 相对位找对）；
 *   3. 启动日志里技能条数 > 0（`skills/` 找对）；
 *   4. 真发一轮对话（faux），SSE 有 start 且有文本（bundle 里的 durable / pi-ai 能跑）。
 *
 * `prompts/` 是懒加载资源，探针只断言 dist 里按相对位存在（构建脚本已逐目录校验），
 * 不为了它去构造一条带变量的任务请求。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createSseDecoder, type ChatEvent } from "@lifediary/shared";

/** apps/server（scripts/ 的上一级） */
const ROOT = dirname(import.meta.dirname);
const DIST = join(ROOT, "dist");
const PORT = Number(process.env.PROBE_PORT ?? 8123);
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

function build(): void {
	console.log("· 构建 dist（scripts/build.mjs）");
	const result = spawnSync(process.execPath, [join(ROOT, "scripts", "build.mjs")], {
		cwd: ROOT,
		stdio: "inherit",
	});
	if (result.status !== 0) {
		console.error(`✗ 构建失败（exit ${result.status}）`);
		process.exit(1);
	}
}

async function main(): Promise<void> {
	build();

	check(existsSync(join(DIST, "index.js")), "dist/index.js 存在");
	check(existsSync(join(DIST, "src", "index.js")), "dist/src/index.js（bundle）存在");
	for (const dir of ["web", "skills", "prompts"]) {
		check(existsSync(join(DIST, dir)), `dist/${dir}/ 已按相对位复制`);
	}
	check(
		readdirSync(join(DIST, "prompts")).some((name) => name.endsWith(".md")),
		"dist/prompts/ 有任务模板",
	);

	// cwd 用一个空临时目录：不读真实 .env / .data/provider-keys.json，.data 也落在那里。
	const cwd = mkdtempSync(join(tmpdir(), "lifediary-dist-probe-"));
	const child = spawn(process.execPath, [join(DIST, "index.js")], {
		cwd,
		env: {
			...process.env,
			PORT: String(PORT),
			LLM_PROVIDER: "faux",
			LLM_API_KEY: "",
			AGENT_TOKEN: "",
			LIFEDIARY_TOKEN: "",
			NODE_OPTIONS: "",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});

	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		const text = chunk.toString();
		stderr += text;
		if (!text.includes("ExperimentalWarning")) process.stderr.write(`  [dist] ${text}`);
	});

	try {
		let up = false;
		for (let attempt = 0; attempt < 80; attempt += 1) {
			try {
				const response = await fetch(`${BASE}/healthz`);
				if (response.ok) {
					up = true;
					break;
				}
			} catch {
				/* not up yet */
			}
			if (child.exitCode !== null) break;
			await sleep(250);
		}
		check(up, "node dist/index.js 起来了（/healthz 200）", `端口 ${PORT}`);
		if (!up) {
			console.error("--- dist stdout ---\n" + stdout);
			console.error("--- dist stderr ---\n" + stderr);
			return;
		}

		const home = await fetch(`${BASE}/`);
		const html = await home.text();
		check(
			home.status === 200 && html.includes("<html") && html.includes("lifediary"),
			"web 首页 200",
			`${html.length} bytes`,
		);

		const skills = stdout.match(/\[skills\] 已加载 (\d+) 条技能/);
		check(Boolean(skills) && Number(skills?.[1] ?? 0) > 0, "skills 可列出（启动日志）", skills?.[0] ?? "没看到日志");

		// 真发一轮（faux）：start 帧给 conversationId，delta 累出文本。
		const response = await fetch(`${BASE}/api/v1/agent/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ messages: [{ role: "user", content: "dist 冒烟：回一个字" }] }),
		});
		check(response.ok, "对话请求 202/200", `HTTP ${response.status}`);
		if (response.ok && response.body) {
			const frameDecoder = createSseDecoder();
			const textDecoder = new TextDecoder();
			const events: ChatEvent[] = [];
			let text = "";
			for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
				for (const event of frameDecoder.push(textDecoder.decode(chunk, { stream: true }))) {
					events.push(event);
					if (event.type === "delta") text += event.text;
				}
			}
			const start = events.find((event) => event.type === "start");
			check(Boolean(start), "SSE 有 start 帧", start?.type === "start" ? start.conversationId : "");
			check(text.trim().length > 0, "faux 回了文本", `${text.trim().slice(0, 24)}`);
		}
	} finally {
		child.kill();
		await Promise.race([
			new Promise((resolve) => child.once("exit", resolve)),
			sleep(5000),
		]);
		// Windows 下 sqlite 句柄可能还没放干净；删不掉只是留个临时目录，不该让冒烟失败。
		rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	}
}

await main();
if (failures > 0) {
	console.error(`\n✗ dist 冒烟失败 ${failures} 项`);
	process.exit(1);
}
console.log("\n✓ dist 冒烟通过");
