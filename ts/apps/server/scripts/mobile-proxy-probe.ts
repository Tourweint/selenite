/**
 * 手机经中继端到端探针（2026-11-11 批H H1/H2，harness 侧）。
 *
 * 真起两个服务 + 一次真 join：中继（随机端口、临时名册、配置 owner 令牌）
 * 与 harness（随机端口、faux 模型、开着中继）。
 *
 *   签发 harness 设备 → harness 上线 → 设任务主机位 → 建一个会话
 *   → harness「添加设备」端点代调中继 join-code（owner 令牌只在服务端）
 *   → 中继 join 换 deviceToken → 手机经 relay 反代 GET /api/v1/agent/chats
 *   → 200 且是 harness 真数据
 *   → 同设备以 RELAY_MOBILE_PROXY_ENABLED=off 重启：同请求 404、join-code 也 404
 *   → 两进程日志里不出现任何令牌 / 加入码
 *
 * 跑法：pnpm --filter @lifediary/server mobile-proxy
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const TMP = join(".data", `probe-mobile-proxy-${randomUUID().slice(0, 8)}`);
const AGENT_TOKEN = randomBytes(24).toString("hex");
const OWNER_TOKEN = randomBytes(24).toString("hex");

let failures = 0;
function check(ok: boolean, label: string, detail = ""): void {
	const line = `${ok ? "✔" : "✖"} ${label}${detail ? ` — ${detail}` : ""}`;
	if (ok) console.log(line);
	else {
		failures += 1;
		console.error(line);
	}
}

/** 取一个空闲端口（绑定 0 再放掉）：探针之间不抢固定端口。 */
function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close(() => resolve(port));
		});
	});
}

const logs: Record<string, string> = {};

function capture(name: string, child: ChildProcess): void {
	logs[name] = "";
	const sink = (chunk: Buffer) => {
		const text = chunk.toString();
		logs[name] += text;
		if (!text.includes("ExperimentalWarning")) process.stderr.write(`  [${name}] ${text}`);
	};
	child.stdout?.on("data", sink);
	child.stderr?.on("data", sink);
}

function startRelay(port: number): ChildProcess {
	const child = spawn(process.execPath, ["../../node_modules/tsx/dist/cli.mjs", "../relay/src/index.ts"], {
		cwd: `${import.meta.dirname}/..`,
		env: {
			...process.env,
			RELAY_PORT: String(port),
			RELAY_STORE_PATH: join(TMP, "relay-state.json"),
			RELAY_OWNER_TOKEN: OWNER_TOKEN,
			NODE_OPTIONS: "",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	capture("relay", child);
	return child;
}

function startHarness(port: number, relayPort: number, relayToken: string, mobileProxy: "on" | "off"): ChildProcess {
	const child = spawn(process.execPath, ["../../node_modules/tsx/dist/cli.mjs", "src/index.ts"], {
		cwd: `${import.meta.dirname}/..`,
		env: {
			...process.env,
			PORT: String(port),
			LLM_PROVIDER: "faux",
			LLM_API_KEY: "",
			AGENT_TOKEN,
			AGENT_DB_PATH: join(TMP, "agent.sqlite"),
			MEMORY_DB_PATH: join(TMP, "memory.db"),
			PROJECTS_DB_PATH: join(TMP, "projects.sqlite"),
			DIARY_DB_PATH: join(TMP, "diary.sqlite"),
			AGENT_SSE_SEQ_DB_PATH: join(TMP, "chat-events.sqlite"),
			AUTONOMY_ENABLED: "false", // 探针显式关（默认已于 2026-11-13 翻成开）
			PAIRING_STORE_PATH: join(TMP, "pairing.json"),
			AGENT_CHAT_META_PATH: join(TMP, "chat-meta.json"),
			AGENT_APPROVALS_PATH: join(TMP, "approvals.json"),
			PROVIDERS_PATH: join(TMP, "providers.json"),
			MODEL_RUNTIME_PATH: join(TMP, "runtime.json"),
			DELEGATIONS_DB_PATH: join(TMP, "delegations.sqlite"),
			CURRENT_PROJECT: "",
			CHANCELLOR_ENABLED: "false",
			RELAY_ENABLED: "1",
			RELAY_URL: `ws://127.0.0.1:${relayPort}`,
			RELAY_TOKEN: relayToken,
			RELAY_DEVICE_NAME: "探针主机",
			RELAY_OWNER_TOKEN: OWNER_TOKEN,
			...(mobileProxy === "off" ? { RELAY_MOBILE_PROXY_ENABLED: "off" } : {}),
			NODE_OPTIONS: "",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	capture(`harness-${mobileProxy}`, child);
	return child;
}

async function waitReady(base: string, path: string, token?: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			const response = await fetch(`${base}${path}`, {
				headers: token ? { authorization: `Bearer ${token}` } : {},
			});
			if (response.ok) return;
		} catch {
			/* 还没起来 */
		}
		await sleep(200);
	}
	throw new Error(`没能就绪：${base}${path}`);
}

async function waitConnected(base: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const response = await fetch(`${base}/api/v1/relay/status`, {
			headers: { authorization: `Bearer ${AGENT_TOKEN}` },
		});
		const data = (await response.json()) as { connected?: boolean };
		if (data.connected) return;
		await sleep(200);
	}
	throw new Error("harness 没能连上中继");
}

async function stop(child: ChildProcess | null): Promise<void> {
	if (!child || child.exitCode !== null) return;
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	child.kill();
	await Promise.race([exited, sleep(5_000)]);
}

/** 走 harness 建一次会话并收完 SSE（faux 链路），让 /agent/chats 有真数据。 */
async function chatOnce(base: string, userText: string): Promise<string> {
	const response = await fetch(`${base}/api/v1/agent/chat`, {
		method: "POST",
		headers: { authorization: `Bearer ${AGENT_TOKEN}`, "content-type": "application/json" },
		body: JSON.stringify({ messages: [{ role: "user", content: userText }] }),
	});
	if (!response.ok || !response.body) throw new Error(`chat → ${response.status}`);
	let text = "";
	const decoder = new TextDecoder();
	const reader = response.body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		text += decoder.decode(value, { stream: true });
	}
	const match = text.match(/"conversationId":"([^"]+)"/);
	if (!match) throw new Error("chat 流里没有 conversationId");
	return match[1];
}

async function main(): Promise<void> {
	mkdirSync(TMP, { recursive: true });
	const relayPort = await freePort();
	const harnessPort = await freePort();
	const base = `http://127.0.0.1:${relayPort}`;
	const harnessBase = `http://127.0.0.1:${harnessPort}`;
	const owner = { authorization: `Bearer ${OWNER_TOKEN}` };
	const agent = { authorization: `Bearer ${AGENT_TOKEN}` };

	const relay = startRelay(relayPort);
	let harness: ChildProcess | null = null;
	try {
		await waitReady(base, "/api/relay/info");
		check(true, "中继就绪", `:${relayPort}（随机端口）`);

		// ── 准备：harness 以设备身份拿到中继 deviceToken ─────────────
		const codeRes = await fetch(`${base}/api/relay/pair/code`, { method: "POST", headers: owner });
		const pairCode = ((await codeRes.json()) as { code: string }).code;
		const redeemRes = await fetch(`${base}/api/relay/pair/redeem`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ code: pairCode, deviceName: "探针主机", platform: "windows" }),
		});
		const host = (await redeemRes.json()) as { deviceId: string; deviceToken: string };
		check(redeemRes.status === 200 && !!host.deviceToken, "harness 设备已签发（中继侧）");

		harness = startHarness(harnessPort, relayPort, host.deviceToken, "on");
		await waitReady(harnessBase, "/healthz");
		await waitConnected(harnessBase);
		check(true, "harness 经中继上线（RELAY_ENABLED=1）");

		// 任务主机位 = 反代默认路由目标
		const homeRes = await fetch(`${base}/api/relay/home-device`, {
			method: "POST",
			headers: { ...owner, "content-type": "application/json" },
			body: JSON.stringify({ deviceId: host.deviceId }),
		});
		check(homeRes.status === 200, "设任务主机位（反代默认落点）");

		const conversationId = await chatOnce(harnessBase, "探针：手机经中继要读到这句话");
		check(!!conversationId, "harness 落了一个真会话", `cid=${conversationId.slice(0, 8)}`);

		// ── H2：harness 代调中继签发加入码（owner 令牌只在服务端）────
		const joinCodeRes = await fetch(`${harnessBase}/api/v1/relay/join-code`, {
			method: "POST",
			headers: { ...agent, "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		const issued = (await joinCodeRes.json()) as {
			joinCode?: string;
			expiresAt?: number;
			relayUrl?: string;
			url?: string;
			dataUrl?: string;
			message?: string;
		};
		check(joinCodeRes.status === 200 && !!issued.joinCode, "「添加设备」拿到加入码", issued.message ?? "");
		check(
			issued.relayUrl === `http://127.0.0.1:${relayPort}`,
			"中继地址默认取 RELAY_URL 的对外形态（ws→http）",
			issued.relayUrl,
		);
		check(
			Boolean(issued.url?.startsWith("lifediary://relay/join?u=")) &&
				Boolean(issued.url?.includes(`c=${issued.joinCode}`)),
			"二维码深链含 u/c 两参",
		);
		check(
			Boolean(issued.dataUrl?.startsWith("data:image/png;base64,")),
			"二维码是服务端渲染的 PNG dataURL",
		);

		// ── R2：真 join → deviceToken ────────────────────────────
		const joinRes = await fetch(`${base}/api/relay/join`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ joinCode: issued.joinCode, deviceName: "探针手机", platform: "android" }),
		});
		const phone = (await joinRes.json()) as { deviceId: string; deviceToken: string };
		check(joinRes.status === 200 && !!phone.deviceToken, "手机 join 换到 deviceToken", `device=${phone.deviceId.slice(0, 8)}`);

		// ── H1：手机经中继反代读 harness 真数据 ──────────────────
		const chatsRes = await fetch(`${base}/api/v1/agent/chats?limit=5`, {
			headers: { authorization: `Bearer ${phone.deviceToken}` },
		});
		const chatsBody = (await chatsRes.text()).slice(0, 400);
		const chats = JSON.parse(chatsBody) as { chats?: Array<{ conversationId: string }> };
		check(chatsRes.status === 200, "经中继 GET /api/v1/agent/chats → 200", `status=${chatsRes.status}`);
		check(
			Boolean(chats.chats?.some((chat) => chat.conversationId === conversationId)),
			"返回的是 harness 真数据（刚建的会话在列表里）",
			`n=${chats.chats?.length ?? 0}`,
		);

		const statusRes = await fetch(`${base}/api/v1/relay/status`, {
			headers: { authorization: `Bearer ${phone.deviceToken}` },
		});
		const statusBody = (await statusRes.json()) as { enabled?: boolean; connected?: boolean };
		check(
			statusRes.status === 200 && statusBody.enabled === true && statusBody.connected === true,
			"同一条反代路也通 /relay/status（不是单端点特判）",
		);

		// 写路径：POST 正文经中继→invoke→内部 handler 原样落地（中继只转 authorization，不带 content-type）
		const renameRes = await fetch(`${base}/api/v1/agent/chat/${conversationId}/rename`, {
			method: "POST",
			headers: { authorization: `Bearer ${phone.deviceToken}`, "content-type": "application/json" },
			body: JSON.stringify({ title: "经中继改名" }),
		});
		check(renameRes.status === 200, "经中继 POST 带正文 → 200", `status=${renameRes.status}`);
		const afterRes = await fetch(`${base}/api/v1/agent/chats?limit=5`, {
			headers: { authorization: `Bearer ${phone.deviceToken}` },
		});
		const after = (await afterRes.json()) as { chats?: Array<{ conversationId: string; title?: string }> };
		check(
			after.chats?.find((chat) => chat.conversationId === conversationId)?.title === "经中继改名",
			"写回后经反代再读能看到新标题（POST body 真落地）",
		);

		// 鉴权仍然生效：坏令牌不该被中继放进来
		const badRes = await fetch(`${base}/api/v1/agent/chats`, {
			headers: { authorization: "Bearer not-a-device-token" },
		});
		check(badRes.status === 403, "中继侧坏令牌 → 403 空体", `status=${badRes.status}`);

		// 反代不放行加入码：任一已加入设备不该能替主人继续发码/拉新设备
		const proxiedJoin = await fetch(`${base}/api/v1/relay/join-code`, {
			method: "POST",
			headers: { authorization: `Bearer ${phone.deviceToken}`, "content-type": "application/json" },
			body: "{}",
		});
		check(proxiedJoin.status === 404, "手机反代调 join-code → 404（owner 动作不走这条面）");

		// ── 回滚开关：harness 侧 off → 通道不注册，invoke 回 404 ──
		await stop(harness);
		harness = startHarness(harnessPort, relayPort, host.deviceToken, "off");
		await waitReady(harnessBase, "/healthz");
		await waitConnected(harnessBase);
		const offRes = await fetch(`${base}/api/v1/agent/chats`, {
			headers: { authorization: `Bearer ${phone.deviceToken}` },
		});
		const offText = await offRes.text();
		check(
			offRes.status === 404 && offText.includes("not_found"),
			"harness RELAY_MOBILE_PROXY_ENABLED=off → 反代 404",
			`status=${offRes.status}`,
		);
		const offJoin = await fetch(`${harnessBase}/api/v1/relay/join-code`, {
			method: "POST",
			headers: { ...agent, "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		check(offJoin.status === 404, "同开关下「添加设备」端点也 404（fail-closed）");

		// ── 令牌纪律：两进程日志里不该出现任何凭据 ─────────────────
		const all = Object.values(logs).join("\n");
		const leaked = [
			["AGENT_TOKEN", AGENT_TOKEN],
			["OWNER_TOKEN", OWNER_TOKEN],
			["harness deviceToken", host.deviceToken],
			["phone deviceToken", phone.deviceToken],
			["joinCode", issued.joinCode ?? ""],
		].filter(([, value]) => value && all.includes(value));
		check(leaked.length === 0, "日志不含任何令牌 / 加入码", leaked.map(([name]) => name).join(", "));
	} finally {
		await stop(harness);
		await stop(relay);
		try {
			rmSync(TMP, { recursive: true, force: true });
		} catch {
			/* Windows 上子进程还没放手就先跳过，.data 下的一次性目录 */
		}
	}

	if (failures > 0) {
		console.error(`\n[probe] 失败 ${failures} 项`);
		process.exitCode = 1;
		return;
	}
	console.log("\n[probe] 全项通过");
}

await main();
