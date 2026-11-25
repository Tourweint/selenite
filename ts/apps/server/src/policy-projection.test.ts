import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * /agent/policy 的两个总闸投影（2026-11-25 B1a）：
 * `flagCascade`（FLAG_CASCADE_ENABLE）与 `pluginSurfaces`（PLUGIN_SURFACE_HIDE）缺省为 true，
 * env 写 false / 0 / off 时投影 false；两个门都与 `AGENT_FLAGS_UI` 合取（UI 整组关掉时也回 false）。
 *
 * 这两个字段在 `src/index.ts` 的 `policyProjection()` 里，模块一被 import 就会 `serve()`
 * 起进程；所以这里照 `scripts/flags-cascade-probe.ts` 的做法**真起服务 + 真 HTTP**，只验这一条投影。
 *
 * 隔离口径（2026-11-25 三审 P0 修；别再退回 `cwd: SERVER_ROOT` + 继承宿主全部 env）：
 *   - 子进程 `cwd` = 临时根，不是 `SERVER_ROOT`。`index.ts` 首行 `loadEnvFile()` 读的是
 *     **临时根下的 `.env`（不存在）**，所以读不到项目真实的 `ts/apps/server/.env`（那里的
 *     `RELAY_ENABLED` / `RELAY_URL` / `RELAY_TOKEN` 不会串进来）。
 *   - env 只给 OS 必需变量（`osEnv()`）+ 本用例的 `baseEnv()`，**不继承宿主 env**。
 *   - relay / 例程 / 唤醒 / 自主 / 日记 / 记忆 / 伙伴家目录 /  chancellor 工作根等落点**全部指向
 *     临时目录**；`.data/*` 这类相对默认值也因 cwd 在临时根而落在临时根（不会写真实 `.data`、
 *     不会抢真实 `relay-identity.pid`、不会连真实中继）。
 */

const SERVER_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SERVER_ENTRY = fileURLToPath(new URL("./index.ts", import.meta.url));
/** 只用来解析 tsx 的绝对路径；子进程的 cwd 是临时根，不是它。 */
const TSX_CLI = resolve(SERVER_ROOT, "../../node_modules/tsx/dist/cli.mjs");

/** 只挑 OS 必需的变量：宿主机的密钥 / 代理 / 中继配置一概不传（照抄 flags-cascade-probe）。 */
function osEnv(): Record<string, string> {
	const keys = [
		"SYSTEMROOT",
		"SystemDrive",
		"windir",
		"COMSPEC",
		"ComSpec",
		"TEMP",
		"TMP",
		"TMPDIR",
		"HOME",
		"USERPROFILE",
		"HOMEDRIVE",
		"HOMEPATH",
		"APPDATA",
		"LOCALAPPDATA",
		"ProgramData",
		"ProgramFiles",
		"ProgramFiles(x86)",
		"CommonProgramFiles",
		"CommonProgramFiles(x86)",
		"ALLUSERSPROFILE",
		"NUMBER_OF_PROCESSORS",
		"PROCESSOR_ARCHITECTURE",
		"PROCESSOR_IDENTIFIER",
		"OS",
		"LANG",
		"LC_ALL",
	];
	const picked: Record<string, string> = {};
	for (const key of keys) {
		const value = process.env[key];
		if (typeof value === "string" && value !== "") picked[key] = value;
	}
	return picked;
}

/**
 * 每个服务一份：所有落盘路径都在自己的 ROOT 下，关掉自动后台调度与外部连接。
 * 与 `scripts/flags-cascade-probe.ts` 同源；`CHANCELLOR_ENABLED` 刻意不置 false——投影只读 env，
 * 置不置都不影响本用例断言，保留默认态更接近真实部署。
 */
function baseEnv(root: string, port: number): Record<string, string> {
	return {
		PORT: String(port),
		// loopback 免鉴权：本用例只读投影，不引入令牌
		AGENT_TOKEN: "",
		AGENT_WORKDIR: root,
		AGENT_DB_PATH: join(root, "agent.sqlite"),
		MEMORY_DB_PATH: join(root, "memory.db"),
		PROJECTS_DB_PATH: join(root, "projects.sqlite"),
		PROVIDERS_PATH: join(root, "providers.json"),
		PROVIDERS_CONFIG: "false",
		PROVIDER_KEYS_PATH: join(root, "provider-keys.json"),
		MODEL_RUNTIME_PATH: join(root, "runtime.json"),
		DELEGATIONS_DB_PATH: join(root, "delegations.sqlite"),
		AGENT_SSE_SEQ_DB_PATH: join(root, "chat-events.sqlite"),
		AGENT_APPROVALS_PATH: join(root, "approvals.json"),
		AGENT_POLICY_PATH: join(root, "policy.json"),
		AGENT_CHAT_META_PATH: join(root, "chat-meta.json"),
		AGENT_LOCAL_SECRET_PATH: join(root, "local-secret"),
		AGENT_FLAGS_PATH: join(root, "agent-flags.json"),
		AGENT_SKILLS_STATE_PATH: join(root, "skill-state.json"),
		AGENT_GATE_AUDIT_PATH: join(root, "gate-blocks.jsonl"),
		AGENT_TOOL_USAGE_PATH: join(root, "tool-usage.json"),
		AGENT_TURN_TIMELINE_PATH: join(root, "turn-timeline.jsonl"),
		ATTACHMENTS_DIR: join(root, "attachments"),
		USER_PROFILE_PATH: join(root, "user-profile.md"),
		PARTNERS_DB_PATH: join(root, "partners.sqlite"),
		PARTNER_HOMES_ROOT: join(root, "partner-homes"),
		ROUTINES_STATE_PATH: join(root, "routines.json"),
		AGENT_WAKE_PENDING_PATH: join(root, "wake-pending.json"),
		AUTONOMY_STATE_PATH: join(root, "autonomy-state.json"),
		DIARY_DB_PATH: join(root, "diary.sqlite"),
		PAIRING_STORE_PATH: join(root, "pairing.json"),
		COMPANION_HOMES_PATH: join(root, "companion-homes.json"),
		REMOTE_DELEGATIONS_PATH: join(root, "remote-delegations.json"),
		CHANCELLOR_WORK_ROOT: join(root, "runs"),
		RELAY_LINK_PATH: join(root, "relay-link.json"),
		// 关掉一切自动后台调度与外部连接：本用例只验投影
		AUTONOMY_ENABLED: "false",
		MODEL_PROBE_LEVELS: "false",
		DELEGATION_RECOVER_REPORT: "false",
		COMPANIONS_ENABLED: "false",
		RELAY_ENABLED: "false",
		RELAY_URL: "",
		RELAY_TOKEN: "",
		DEVICE_MATRIX_ENABLED: "false",
		COMPANION_HOME_ENABLED: "false",
		// 假模型：不读真 key、不发真实上游请求
		LLM_PROVIDER: "faux",
		LLM_API_KEY: "",
	};
}

function freePort(): Promise<number> {
	return new Promise((resolvePort, reject) => {
		const probe = createServer();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			const port = typeof address === "object" && address ? address.port : 0;
			probe.close(() => resolvePort(port));
		});
	});
}

interface Booted {
	child: ChildProcess;
	base: string;
	stderr: () => string;
}

async function boot(env: NodeJS.ProcessEnv, root: string): Promise<Booted> {
	const port = await freePort();
	let stderrText = "";
	const child = spawn(process.execPath, [TSX_CLI, SERVER_ENTRY], {
		// cwd=临时根：loadEnvFile() 读不到项目 .env，相对 `.data/*` 也落临时根
		cwd: root,
		env: { ...osEnv(), ...baseEnv(root, port), ...env },
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	child.stdout?.on("data", () => {});
	child.stderr?.on("data", (chunk: Buffer) => {
		stderrText += chunk.toString();
	});

	const base = `http://127.0.0.1:${port}`;
	for (let attempt = 0; attempt < 80; attempt += 1) {
		try {
			const response = await fetch(`${base}/healthz`);
			if (response.ok) return { child, base, stderr: () => stderrText };
		} catch {
			/* 还没起来 */
		}
		if (child.exitCode !== null) break;
		await new Promise((done) => setTimeout(done, 250));
	}
	child.kill();
	throw new Error(`服务没能启动（exit=${child.exitCode}）：\n${stderrText.slice(-800)}`);
}

async function stop(booted: Booted): Promise<void> {
	if (booted.child.exitCode === null) {
		booted.child.kill();
		await new Promise<void>((done) => {
			const timer = setTimeout(done, 3000);
			booted.child.once("exit", () => {
				clearTimeout(timer);
				done();
			});
		});
	}
}

async function policyOf(booted: Booted): Promise<{ flagCascade?: unknown; pluginSurfaces?: unknown }> {
	const response = await fetch(`${booted.base}/api/v1/agent/policy`);
	assert.equal(response.status, 200, "GET /api/v1/agent/policy 应 200");
	return (await response.json()) as { flagCascade?: unknown; pluginSurfaces?: unknown };
}

test("policy 投影：两个总闸缺省 true，env 写关值时 false", async () => {
	const root = mkdtempSync(join(tmpdir(), "lifediary-policy-"));
	try {
		const on = await boot({}, root);
		try {
			const policy = await policyOf(on);
			assert.equal(policy.flagCascade, true, "缺省：flagCascade=true");
			assert.equal(policy.pluginSurfaces, true, "缺省：pluginSurfaces=true");
		} finally {
			await stop(on);
		}

		// false / 0 / off 三种写法算同一档；一次起停各验一个，别起四次服务。
		const off = await boot({ FLAG_CASCADE_ENABLE: "0", PLUGIN_SURFACE_HIDE: "off" }, root);
		try {
			const policy = await policyOf(off);
			assert.equal(policy.flagCascade, false, "FLAG_CASCADE_ENABLE=0：flagCascade=false");
			assert.equal(policy.pluginSurfaces, false, "PLUGIN_SURFACE_HIDE=off：pluginSurfaces=false");
		} finally {
			await stop(off);
		}

		// AGENT_FLAGS_UI=false（P1-2）：插件页整组不挂，这两个门也不该报 true。
		const uiOff = await boot({ AGENT_FLAGS_UI: "false" }, root);
		try {
			const policy = await policyOf(uiOff);
			assert.equal(policy.flagCascade, false, "AGENT_FLAGS_UI=false：flagCascade=false（门与 UI 合取）");
			assert.equal(
				policy.pluginSurfaces,
				false,
				"AGENT_FLAGS_UI=false：pluginSurfaces=false（门与 UI 合取）",
			);
		} finally {
			await stop(uiOff);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
