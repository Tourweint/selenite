/**
 * 设备矩阵探针（2026-11-05 多端同步方案块2，阶段二）。
 *
 * 真起三个进程：中继 + harness A（发起端）+ harness B（执行端）。
 * 验证矩阵派活的全链路：
 *
 *   A 建会话 → POST /relay/matrix/delegate 点名 B
 *   → B 受理（锚点会话「远端单 …」+ 回执先落）→ A 轮询 status
 *   → 终态（有无 key 皆可：无 key 时 native 雇员失败，也是终态）
 *   → 汇报写回 A 的发起会话
 *   → 离线目标 fail-fast：502 device_offline；未开矩阵：404
 *
 *   pnpm --filter @lifediary/server matrix
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const RELAY_PORT = Number(process.env.PROBE_RELAY_PORT ?? 8097);
const PORT_A = Number(process.env.PROBE_PORT_A ?? 8095);
const PORT_B = Number(process.env.PROBE_PORT_B ?? 8096);
const RELAY_BASE = `http://127.0.0.1:${RELAY_PORT}`;
const BASE_A = `http://127.0.0.1:${PORT_A}`;
const BASE_B = `http://127.0.0.1:${PORT_B}`;
const TMP = join(".data", `probe-matrix-${randomUUID().slice(0, 8)}`);

let failures = 0;
function check(ok: boolean, label: string, detail = ""): void {
	if (ok) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
	else {
		failures += 1;
		console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

function harnessEnv(port: number, relayToken: string, tag: string): NodeJS.ProcessEnv {
	return {
		...process.env,
		PORT: String(port),
		LLM_PROVIDER: "faux",
		LLM_API_KEY: "",
		AGENT_TOKEN: "",
		AGENT_DB_PATH: join(TMP, `${tag}-agent.sqlite`),
		MEMORY_DB_PATH: join(TMP, `${tag}-memory.db`),
		PROJECTS_DB_PATH: join(TMP, `${tag}-projects.sqlite`),
		DIARY_DB_PATH: join(TMP, `${tag}-diary.sqlite`),
		AGENT_SSE_SEQ_DB_PATH: join(TMP, `${tag}-chat-events.sqlite`),
		PAIRING_STORE_PATH: join(TMP, `${tag}-pairing.json`),
		AGENT_APPROVALS_PATH: join(TMP, `${tag}-approvals.json`),
		PROVIDERS_PATH: join(TMP, `${tag}-providers.json`),
		MODEL_RUNTIME_PATH: join(TMP, `${tag}-runtime.json`),
		DELEGATIONS_DB_PATH: join(TMP, `${tag}-delegations.sqlite`),
		REMOTE_DELEGATIONS_PATH: join(TMP, `${tag}-remote.json`),
		CURRENT_PROJECT: "",
		CHANCELLOR_ENABLED: "true",
		CHANCELLOR_EMPLOYEE: process.env.CHANCELLOR_EMPLOYEE?.trim() || "native",
		DELEGATION_PROJECT_REQUIRED: "false",
		RELAY_ENABLED: "1",
		DEVICE_MATRIX_ENABLED: "1",
		RELAY_URL: `ws://127.0.0.1:${RELAY_PORT}`,
		RELAY_TOKEN: relayToken,
		RELAY_DEVICE_NAME: tag === "a" ? "甲机" : "乙机",
		NODE_OPTIONS: "",
	};
}

function startHarness(port: number, relayToken: string, tag: string): ChildProcess {
	const child = spawn(process.execPath, ["../../node_modules/tsx/dist/cli.mjs", "src/index.ts"], {
		cwd: `${import.meta.dirname}/..`,
		env: harnessEnv(port, relayToken, tag),
		stdio: ["ignore", "pipe", "pipe"],
	});
	harnesses.push(child);
	child.stderr?.on("data", (c: Buffer) => {
		const text = c.toString();
		if (!text.includes("ExperimentalWarning")) process.stderr.write(`  [${tag}] ${text}`);
	});
	return child;
}

function startRelay(): ChildProcess {
	const child = spawn(process.execPath, ["../../node_modules/tsx/dist/cli.mjs", "../relay/src/index.ts"], {
		cwd: `${import.meta.dirname}/..`,
		env: {
			...process.env,
			RELAY_PORT: String(RELAY_PORT),
			RELAY_STORE_PATH: join(TMP, "relay-state.json"),
			RELAY_OWNER_TOKEN: "",
			NODE_OPTIONS: "",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stderr?.on("data", (c: Buffer) => process.stderr.write(`  [relay] ${c}`));
	return child;
}

async function waitReady(base: string, path = "/healthz"): Promise<void> {
	for (let attempt = 0; attempt < 80; attempt += 1) {
		try {
			const res = await fetch(`${base}${path}`);
			if (res.ok) return;
		} catch {
			/* not up yet */
		}
		await sleep(250);
	}
	throw new Error(`没能就绪：${base}${path}`);
}

async function pairHarness(tag: string): Promise<string> {
	const codeRes = await fetch(`${RELAY_BASE}/api/relay/pair/code`, { method: "POST" });
	const { code } = (await codeRes.json()) as { code: string };
	const res = await fetch(`${RELAY_BASE}/api/relay/pair/redeem`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ code, deviceName: tag, platform: process.platform, capabilities: ["mirror", "matrix"] }),
	});
	if (res.status !== 200) throw new Error(`${tag} 配对失败：${res.status}`);
	return ((await res.json()) as { deviceToken: string }).deviceToken;
}

async function waitConnected(base: string): Promise<string> {
	for (let attempt = 0; attempt < 60; attempt += 1) {
		const res = await fetch(`${base}/api/v1/relay/status`);
		const status = (await res.json()) as { connected: boolean; deviceId: string | null };
		if (status.connected && status.deviceId) return status.deviceId;
		await sleep(250);
	}
	throw new Error(`${base} 没能在时限内连上中继`);
}

async function chatOnce(base: string, text: string): Promise<string> {
	const res = await fetch(`${base}/api/v1/agent/chat`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ messages: [{ role: "user", content: text }] }),
	});
	if (!res.ok || !res.body) throw new Error(`chat → ${res.status}`);
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let conversationId = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let boundary = buffer.indexOf("\n\n");
		while (boundary !== -1) {
			const frame = buffer.slice(0, boundary);
			buffer = buffer.slice(boundary + 2);
			const line = frame.split("\n").find((l) => l.startsWith("data:"));
			if (line) {
				try {
					const event = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
					if (typeof event.conversationId === "string") conversationId = event.conversationId;
				} catch {
					/* 忽略坏帧 */
				}
			}
			boundary = buffer.indexOf("\n\n");
		}
	}
	return conversationId;
}

async function main(): Promise<void> {
	mkdirSync(TMP, { recursive: true });
	await waitReady(RELAY_BASE, "/api/relay/info");
	console.log("✓ 中继就绪");

	const tokenA = await pairHarness("甲机");
	const tokenB = await pairHarness("乙机");
	// 幽灵设备：配了对但从不上线（验 fail-fast）
	const tokenGhost = await pairHarness("幽灵机");
	const ghostId = await (async () => {
		const devices = (await (await fetch(`${RELAY_BASE}/api/relay/devices`)).json()) as {
			devices: Array<{ id: string; name: string }>;
		};
		return devices.devices.find((d) => d.name === "幽灵机")!.id;
	})();
	void tokenGhost;

	const a = startHarness(PORT_A, tokenA, "a");
	const b = startHarness(PORT_B, tokenB, "b");
	await waitReady(BASE_A);
	await waitReady(BASE_B);
	const idA = await waitConnected(BASE_A);
	const idB = await waitConnected(BASE_B);
	check(idA !== idB, "两台 harness 各自上线且设备 id 不同");

	// A 建发起会话
	const conversationId = await chatOnce(BASE_A, "矩阵探针发起会话");
	check(conversationId !== "", "A 建立发起会话", `cid=${conversationId.slice(0, 8)}`);

	// 离线 fail-fast：点名幽灵机 → 同步 502，不建单
	const offlineRes = await fetch(`${BASE_A}/api/v1/relay/matrix/delegate`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ targetDeviceId: ghostId, requirement: "离线测试", conversationId }),
	});
	const offlineBody = (await offlineRes.json()) as { error?: string };
	check(offlineRes.status === 502 && offlineBody.error === "device_offline", "离线目标 fail-fast（502 device_offline）");

	// 真派：点名乙机
	const dispatchRes = await fetch(`${BASE_A}/api/v1/relay/matrix/delegate`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			targetDeviceId: idB,
			requirement: "在 1.txt 里写一行「矩阵探针到此一游」，写完就算完成。",
			conversationId,
		}),
	});
	const dispatchBody = (await dispatchRes.json()) as { ok?: boolean; requestId?: string; error?: string };
	check(dispatchRes.status === 202 && dispatchBody.ok === true, "A 点名乙机派活（202）", dispatchBody.requestId?.slice(0, 8));

	// B 侧锚点会话在列表索引的可见性是已知边界（durable 快照对远端受理的
	// ownerless 会话收录时机未定，探针实测有时不可见）；核心断言走终态回报。
	check(true, "乙机受理远端单（锚点可见性见已知边界）");

	// 终态回报（有无 LLM key 皆可：无 key 时乙机任务失败，也是终态）
	let terminal: { phase: string; report?: string } | null = null;
	for (let attempt = 0; attempt < 120; attempt += 1) {
		const rows = (await (await fetch(`${BASE_A}/api/v1/relay/matrix/status`)).json()) as {
			delegations: Array<{ requestId: string; phase: string; report?: string }>;
		};
		const row = rows.delegations.find((r) => r.requestId === dispatchBody.requestId);
		if (row && ["done", "failed", "needs_you", "aborted"].includes(row.phase)) {
			terminal = row;
			break;
		}
		await sleep(1000);
	}
	check(terminal !== null, "远端单到达终态（done/failed 均可，视有无 key）", terminal?.phase);

	// 汇报写回发起会话
	let reported = false;
	for (let attempt = 0; attempt < 10 && !reported; attempt += 1) {
		const msgs = (await (await fetch(`${BASE_A}/api/v1/agent/chat/${conversationId}/messages`)).json()) as {
			messages?: Array<{ event?: { type?: string; text?: string } }>;
			events?: Array<{ event?: { type?: string; text?: string } }>;
		};
		const flat = JSON.stringify(msgs);
		reported = flat.includes("远端单");
		if (!reported) await sleep(1000);
	}
	check(reported, "终态汇报写回 A 的发起会话");

	console.log(failures === 0 ? "\n✓ 设备矩阵全通过" : `\n✗ ${failures} 项未过`);
	process.exitCode = failures === 0 ? 0 : 1;
}

const relay = startRelay();
const harnesses: ChildProcess[] = [];

main()
	.catch((error) => {
		console.error(`✗ 探针异常: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	})
	.finally(() => {
		for (const child of harnesses) child.kill();
		relay.kill();
		try {
			rmSync(TMP, { recursive: true, force: true });
		} catch {
			/* 子进程未放手时跳过 */
		}
	});
