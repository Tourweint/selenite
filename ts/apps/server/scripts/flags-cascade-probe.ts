/**
 * 级联开关端点探针（2026-11-25）：真起服务 + 真 HTTP，验证四条端点的读写语义与回滚门。
 *
 * 覆盖：
 *   A. 默认门开（FLAG_CASCADE_ENABLE 缺省）：
 *      enable-plan（缺的父 / willWrite / 不把 plan 集算进 revive）→ enable（无 confirm / 有 confirm /
 *      重复 enable）→ disable-plan → disable；父项连带关后子项「存储值保留、effectiveValue 变关」；
 *      再关一次被父锁住的子项，只验 200 + alreadyOff，不 500。
 *   B. 回滚门关（FLAG_CASCADE_ENABLE=false）：四条端点整组 404，
 *      旧的 GET flags / PUT 单键照旧可用。
 *
 * 隔离口径：
 *   - 两份独立的 mkdtemp 根目录，子进程 cwd = 各自 ROOT，故 index.ts 首行 loadEnvFile()
 *     读的是 ROOT/.env（不存在），不会读到项目 .env；相对 `.data/*` 默认值也落 ROOT。
 *   - 端口启动前由 OS 分配；就绪判定除 /healthz 外还要过本探针独有 token 的鉴权，
 *     端口上蹲着别的服务时直接中止，绝不冒认成功。
 *   - 子进程只继承 OS 必需变量 + 本次显式 baseEnv，不联网、不继承宿主密钥 / 代理 / 中继。
 *   - 不打印令牌，也不打印任何记忆内容；只打印开关名、条数与判定结论。
 *
 *   pnpm --filter @lifediary/server flags-cascade
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TSX_CLI = fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url));
const SERVER_ENTRY = fileURLToPath(new URL("../src/index.ts", import.meta.url));
/** 本次探针独有：用来确认端口上的服务真是自己起的那个 */
const TOKEN = "flags-cascade-probe-token";

let passed = 0;
let failed = 0;
const roots: string[] = [];

function check(ok: boolean, label: string, expected: string, actual: string): void {
	if (ok) {
		passed += 1;
		console.log(`PASS ${label}`);
		return;
	}
	failed += 1;
	console.log(`FAIL ${label}（期望 ${expected} / 实际 ${actual}）`);
}

/** 开关的「关」判定（布尔 false / 枚举 off / 0）；只用于断言，不替代服务端口径。 */
function isOff(value: unknown): boolean {
	return value === "false" || value === "off" || value === "0";
}

function authHeaders(): Record<string, string> {
	return { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` };
}

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

/** 每个服务一份：所有落盘路径都在自己的 ROOT 下，关掉自动后台调度，不碰宿主真实配置。 */
function baseEnv(root: string, port: number): Record<string, string> {
	return {
		PORT: String(port),
		AGENT_TOKEN: TOKEN,
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
		PARTNERS_DB_PATH: join(root, "partners.sqlite"),
		PARTNER_HOMES_ROOT: join(root, "partner-homes"),
		ROUTINES_STATE_PATH: join(root, "routines.json"),
		AUTONOMY_STATE_PATH: join(root, "autonomy-state.json"),
		DIARY_DB_PATH: join(root, "diary.sqlite"),
		PAIRING_STORE_PATH: join(root, "pairing.json"),
		COMPANION_HOMES_PATH: join(root, "companion-homes.json"),
		REMOTE_DELEGATIONS_PATH: join(root, "remote-delegations.json"),
		CHANCELLOR_WORK_ROOT: join(root, "runs"),
		// 关掉一切自动后台调度与外部连接：探针只验开关端点
		AUTONOMY_ENABLED: "false",
		MODEL_PROBE_LEVELS: "false",
		DELEGATION_RECOVER_REPORT: "false",
		CHANCELLOR_ENABLED: "false",
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

interface Service {
	name: string;
	root: string;
	port: number;
	child: ChildProcess | null;
}

async function allocatePort(): Promise<number> {
	return new Promise<number>((resolvePort, rejectPort) => {
		const probe = createNetServer();
		probe.once("error", rejectPort);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			const port = typeof address === "object" && address !== null ? address.port : 0;
			probe.close(() => resolvePort(port));
		});
	});
}

async function startService(name: string, extraEnv: Record<string, string>): Promise<Service> {
	const root = mkdtempSync(join(tmpdir(), `lifediary-flags-cascade-${name}-`));
	roots.push(root);
	const port = await allocatePort();
	const child = spawn(process.execPath, [TSX_CLI, SERVER_ENTRY], {
		cwd: root,
		env: { ...osEnv(), ...baseEnv(root, port), ...extraEnv },
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	const service: Service = { name, root, port, child };
	const lifecycle: {
		spawnError: Error | null;
		exit: { code: number | null; signal: NodeJS.Signals | null } | null;
	} = { spawnError: null, exit: null };
	child.once("error", (error) => {
		lifecycle.spawnError = error;
	});
	child.once("exit", (code, signal) => {
		lifecycle.exit = { code, signal };
	});
	// 子进程日志可能带环境细节：只吞掉，不转发到探针输出
	child.stdout?.resume();
	child.stderr?.resume();

	const base = `http://127.0.0.1:${port}`;
	const deadline = Date.now() + 30_000;
	for (;;) {
		if (lifecycle.spawnError) throw new Error(`服务 ${name} 进程启动失败：${lifecycle.spawnError.message}`);
		if (lifecycle.exit) {
			throw new Error(`服务 ${name} 提前退出（code=${lifecycle.exit.code} signal=${lifecycle.exit.signal}）`);
		}
		const health = await fetch(`${base}/healthz`).catch(() => null);
		if (health?.ok) {
			// healthz 免鉴权：用本次探针独有的 token 再敲一次受保护端点，认不出自己就中止
			const identity = await fetch(`${base}/api/v1/agent/policy`, { headers: authHeaders() }).catch(() => null);
			if (!identity?.ok) {
				throw new Error(`端口 ${port} 上的服务不是本探针进程（healthz 可通但鉴权不通过），已中止`);
			}
			console.log(`服务 ${name}：port=${port} root=${root}`);
			return service;
		}
		if (Date.now() > deadline) throw new Error(`服务 ${name} 30 秒没起来`);
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
}

async function waitPortFree(port: number): Promise<void> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const free = await new Promise<boolean>((resolve) => {
			const probe = createNetServer();
			probe.once("error", () => resolve(false));
			probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
		});
		if (free) return;
		if (Date.now() > deadline) throw new Error(`端口 ${port} 在子进程退出后仍未释放`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

async function stopService(service: Service): Promise<void> {
	const child = service.child;
	if (!child || child.pid === undefined) return;
	if (child.exitCode !== null || child.signalCode !== null) {
		await waitPortFree(service.port);
		return;
	}
	const exited = new Promise<void>((resolve) => {
		if (child.exitCode !== null || child.signalCode !== null) resolve();
		else child.once("exit", () => resolve());
	});
	child.kill("SIGTERM");
	const force = setTimeout(() => {
		try {
			child.kill("SIGKILL");
		} catch {
			/* 已退出 */
		}
	}, 5_000);
	force.unref();
	const ended = await Promise.race([
		exited.then(() => true),
		new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000)),
	]);
	clearTimeout(force);
	if (!ended) throw new Error(`服务 ${service.name} 子进程 pid=${child.pid} 未退出`);
	await waitPortFree(service.port);
}

async function api(
	service: Service,
	method: string,
	path: string,
	body?: unknown,
): Promise<{ status: number; body: any }> {
	const response = await fetch(`http://127.0.0.1:${service.port}${path}`, {
		method,
		headers: authHeaders(),
		signal: AbortSignal.timeout(15_000),
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const text = await response.text();
	let parsed: any = null;
	if (text) {
		try {
			parsed = JSON.parse(text);
		} catch {
			parsed = { raw: text.slice(0, 200) };
		}
	}
	return { status: response.status, body: parsed };
}

function flagOf(flagsBody: any, key: string): any {
	const list: any[] = Array.isArray(flagsBody?.flags) ? flagsBody.flags : [];
	return list.find((entry) => entry?.key === key);
}

function keysOf(items: any): string {
	const mapped = (Array.isArray(items) ? items : []).map((item) => item?.key ?? "?");
	return mapped.length > 0 ? mapped.join(",") : "(空)";
}

/** 服务 A：级联开（MEMORY_ENABLED=false 锁子项，MEMORY_EXTRACT 不设 → 存储值回落默认 auto）。 */
async function runServiceA(): Promise<void> {
	const service = await startService("a", { MEMORY_ENABLED: "false" });
	try {
		// 1. enable-plan：缺的父、父自己要写、plan 集不进 revive
		const plan = await api(service, "GET", "/api/v1/agent/flags/MEMORY_EXTRACT/enable-plan");
		check(plan.status === 200, "A GET enable-plan 返回 200", "200", String(plan.status));
		const missing: any[] = Array.isArray(plan.body?.missing) ? plan.body.missing : [];
		const missingMemory = missing.find((node) => node?.key === "MEMORY_ENABLED");
		check(
			Boolean(missingMemory),
			"A enable-plan missing 含 MEMORY_ENABLED",
			"missing 含 MEMORY_ENABLED",
			`missing=${keysOf(missing)}`,
		);
		check(
			missingMemory?.willWrite === true,
			"A enable-plan MEMORY_ENABLED 的 willWrite 为 true",
			"willWrite=true",
			`willWrite=${String(missingMemory?.willWrite)}`,
		);
		const revive: any[] = Array.isArray(plan.body?.revive) ? plan.body.revive : [];
		check(
			!revive.some((node) => node?.key === "MEMORY_ENABLED" || node?.key === "MEMORY_EXTRACT"),
			"A enable-plan revive 不含 plan 集（MEMORY_ENABLED / MEMORY_EXTRACT）",
			"revive 不含 MEMORY_ENABLED、MEMORY_EXTRACT",
			`revive=${keysOf(revive)}`,
		);

		// 2. enable：无 body / 无 confirm 都不许写
		const noBody = await api(service, "POST", "/api/v1/agent/flags/MEMORY_EXTRACT/enable");
		check(noBody.status === 400, "A POST enable 无 body 返回 400", "400", String(noBody.status));
		check(
			noBody.body?.error === "needs_confirm",
			"A POST enable 无 body 的 error 为 needs_confirm",
			"needs_confirm",
			String(noBody.body?.error ?? "(空)"),
		);
		const noConfirm = await api(service, "POST", "/api/v1/agent/flags/MEMORY_EXTRACT/enable", {});
		check(noConfirm.status === 400, "A POST enable 无 confirm 返回 400", "400", String(noConfirm.status));
		check(
			noConfirm.body?.error === "needs_confirm",
			"A POST enable 无 confirm 的 error 为 needs_confirm",
			"needs_confirm",
			String(noConfirm.body?.error ?? "(空)"),
		);

		// 3. enable confirm:true → 写父项
		const enabled = await api(service, "POST", "/api/v1/agent/flags/MEMORY_EXTRACT/enable", { confirm: true });
		check(enabled.status === 200, "A POST enable confirm:true 返回 200", "200", String(enabled.status));
		const changed: any[] = Array.isArray(enabled.body?.changed) ? enabled.body.changed : [];
		check(
			changed.some((item) => item?.key === "MEMORY_ENABLED"),
			"A POST enable 的 changed 含 MEMORY_ENABLED",
			"changed 含 MEMORY_ENABLED",
			`changed=${keysOf(changed)}`,
		);

		// 4. 写完两个开关都不该再是关
		const flagsAfterEnable = await api(service, "GET", "/api/v1/agent/flags");
		check(flagsAfterEnable.status === 200, "A GET flags 返回 200", "200", String(flagsAfterEnable.status));
		const memoryEnabled = flagOf(flagsAfterEnable.body, "MEMORY_ENABLED");
		const memoryExtract = flagOf(flagsAfterEnable.body, "MEMORY_EXTRACT");
		check(
			typeof memoryEnabled?.effectiveValue === "string" && !isOff(memoryEnabled.effectiveValue),
			"A 打开后 MEMORY_ENABLED effectiveValue 不再是关",
			"effectiveValue 非 false/0/off",
			`effective=${String(memoryEnabled?.effectiveValue ?? "(缺)")}`,
		);
		check(
			typeof memoryExtract?.effectiveValue === "string" && !isOff(memoryExtract.effectiveValue),
			"A 打开后 MEMORY_EXTRACT effectiveValue 不再是关",
			"effectiveValue 非 false/0/off",
			`effective=${String(memoryExtract?.effectiveValue ?? "(缺)")}`,
		);

		// 5. 再 POST 一次：幂等，不重复写
		const again = await api(service, "POST", "/api/v1/agent/flags/MEMORY_EXTRACT/enable", { confirm: true });
		check(again.status === 200, "A 再 POST enable 返回 200", "200", String(again.status));
		check(
			again.body?.alreadyOn === true,
			"A 再 POST enable 的 alreadyOn 为 true",
			"alreadyOn=true",
			`alreadyOn=${String(again.body?.alreadyOn)}`,
		);
		const againChanged: any[] = Array.isArray(again.body?.changed) ? again.body.changed : [];
		check(
			againChanged.length === 0,
			"A 再 POST enable 的 changed 为空",
			"changed.length=0",
			`changed.length=${againChanged.length}（${keysOf(againChanged)}）`,
		);

		// 6. disable-plan：可关，且点名会被连带失效的子项
		const disablePlan = await api(service, "GET", "/api/v1/agent/flags/MEMORY_ENABLED/disable-plan");
		check(disablePlan.status === 200, "A GET disable-plan 返回 200", "200", String(disablePlan.status));
		check(
			disablePlan.body?.disableable === true,
			"A disable-plan 的 disableable 为 true",
			"disableable=true",
			`disableable=${String(disablePlan.body?.disableable)}`,
		);
		const affected: any[] = Array.isArray(disablePlan.body?.affected) ? disablePlan.body.affected : [];
		check(
			affected.some((item) => item?.key === "MEMORY_EXTRACT"),
			"A disable-plan 的 affected 含 MEMORY_EXTRACT",
			"affected 含 MEMORY_EXTRACT",
			`affected=${keysOf(affected)}`,
		);

		// 记下子项此刻的存储值；关父项后要逐字对得上
		const extractValueBefore = memoryExtract?.value;
		check(
			typeof extractValueBefore === "string" && extractValueBefore !== "",
			"A 记下 MEMORY_EXTRACT 的存储值（供关父后比对）",
			"value 为非空字符串",
			`value=${String(extractValueBefore ?? "(缺)")}`,
		);

		// 7. disable：只写父项关值
		const disabled = await api(service, "POST", "/api/v1/agent/flags/MEMORY_ENABLED/disable", { confirm: true });
		check(disabled.status === 200, "A POST /flags/MEMORY_ENABLED/disable 返回 200", "200", String(disabled.status));

		// 8. 关父项后：子项存储值不动，effectiveValue 变关
		const flagsAfterDisable = await api(service, "GET", "/api/v1/agent/flags");
		check(flagsAfterDisable.status === 200, "A 关父后 GET flags 返回 200", "200", String(flagsAfterDisable.status));
		const memoryExtractAfter = flagOf(flagsAfterDisable.body, "MEMORY_EXTRACT");
		check(
			memoryExtractAfter?.value === extractValueBefore,
			"A 关父项后 MEMORY_EXTRACT.value 不变",
			`value=${String(extractValueBefore ?? "(缺)")}`,
			`value=${String(memoryExtractAfter?.value ?? "(缺)")}`,
		);
		check(
			isOff(memoryExtractAfter?.effectiveValue),
			"A 关父项后 MEMORY_EXTRACT.effectiveValue 变关",
			"effectiveValue 为 false/0/off",
			`effective=${String(memoryExtractAfter?.effectiveValue ?? "(缺)")} lockedBy=${String(memoryExtractAfter?.lockedBy)}`,
		);

		// 9. 再关一次被父锁住的子项：有 offValue=off，只验 200 + alreadyOff，不 500
		const extractOff = await api(service, "POST", "/api/v1/agent/flags/MEMORY_EXTRACT/disable", { confirm: true });
		check(
			extractOff.status === 200,
			"A POST /flags/MEMORY_EXTRACT/disable 返回 200（不 500）",
			"200",
			String(extractOff.status),
		);
		check(
			extractOff.body?.alreadyOff === true,
			"A 目标已被父锁时 POST disable 返回 alreadyOff",
			"alreadyOff=true",
			`alreadyOff=${String(extractOff.body?.alreadyOff)}`,
		);
	} finally {
		await stopService(service);
	}
}

/** 服务 B：回滚门关掉，四条端点整组 404，旧列表 / 单键 PUT 不受影响。 */
async function runServiceB(): Promise<void> {
	const service = await startService("b", { FLAG_CASCADE_ENABLE: "false" });
	try {
		const endpoints: { label: string; method: string; path: string; body?: unknown }[] = [
			{ label: "GET enable-plan", method: "GET", path: "/api/v1/agent/flags/MEMORY_EXTRACT/enable-plan" },
			{
				label: "POST enable",
				method: "POST",
				path: "/api/v1/agent/flags/MEMORY_EXTRACT/enable",
				body: { confirm: true },
			},
			{ label: "GET disable-plan", method: "GET", path: "/api/v1/agent/flags/MEMORY_ENABLED/disable-plan" },
			{
				label: "POST disable",
				method: "POST",
				path: "/api/v1/agent/flags/MEMORY_ENABLED/disable",
				body: { confirm: true },
			},
		];
		for (const endpoint of endpoints) {
			const result = await api(service, endpoint.method, endpoint.path, endpoint.body);
			check(result.status === 404, `B ${endpoint.label} 返回 404`, "404", String(result.status));
		}

		// 旧的列表 / 单键 PUT 不受回滚门影响
		const flags = await api(service, "GET", "/api/v1/agent/flags");
		check(flags.status === 200, "B GET flags 仍返回 200", "200", String(flags.status));
		const rows: any[] = Array.isArray(flags.body?.flags) ? flags.body.flags : [];
		check(rows.length > 0, "B GET flags 的列表非空", "flags 条数 > 0", `flags 条数=${rows.length}`);

		const put = await api(service, "PUT", "/api/v1/agent/flags/MEMORY_EXTRACT", { value: "rule" });
		check(put.status === 200, "B PUT /flags/MEMORY_EXTRACT（合法值 rule）返回 200", "200", String(put.status));
		check(
			put.body?.ok === true,
			"B PUT /flags/MEMORY_EXTRACT 的 ok 为 true",
			"ok=true",
			`ok=${String(put.body?.ok)}`,
		);
	} finally {
		await stopService(service);
	}
}

async function main(): Promise<void> {
	console.log("— 服务 A：级联开（MEMORY_ENABLED=false，MEMORY_EXTRACT 不设）");
	await runServiceA();
	console.log("— 服务 B：回滚门关（FLAG_CASCADE_ENABLE=false）");
	await runServiceB();
}

main()
	.catch((error) => {
		failed += 1;
		console.error(`FAIL 探针执行异常（期望 正常跑完 / 实际 ${error instanceof Error ? error.message : String(error)}）`);
	})
	.finally(() => {
		console.log(`\n${passed} passed / ${failed} failed`);
		process.exitCode = failed > 0 ? 1 : 0;
		for (const root of roots) {
			try {
				rmSync(root, { recursive: true, force: true });
			} catch {
				/* Windows 句柄延迟：下一次再清 */
			}
		}
	});
