/**
 * 日记镜像端到端探针（2026-10-29）。
 *
 * 真起一个服务进程，用 HTTP 验 `POST /api/v1/diary/sync` 的合并口径：
 * 上行插入 / 幂等重发 / 下行增量 / 软删与"删除不自愈" / 冲突回吐 / 8KB 截断。
 *
 *   pnpm --filter @lifediary/server diary
 */
import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = Number(process.env.PROBE_PORT ?? 8097);
const BASE = `http://127.0.0.1:${PORT}`;
const DB = ".data/probe-diary.sqlite";
const TOKEN = "diary-probe-token";

let failures = 0;
function check(ok: boolean, label: string, detail = ""): void {
	if (ok) {
		console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
	} else {
		failures += 1;
		console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

function startServer(): ChildProcess {
	const child = spawn(process.execPath, ["../../node_modules/tsx/dist/cli.mjs", "src/index.ts"], {
		cwd: import.meta.dirname ? `${import.meta.dirname}/..` : ".",
		env: {
			...process.env,
			PORT: String(PORT),
			LLM_PROVIDER: "faux",
			LLM_API_KEY: "",
			AGENT_TOKEN: TOKEN,
			AGENT_DB_PATH: ".data/probe-diary-agent.sqlite",
			MEMORY_DB_PATH: ".data/probe-diary-memory.db",
			DIARY_DB_PATH: DB,
			NODE_OPTIONS: "",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout?.on("data", (chunk: Buffer) => {
		const text = chunk.toString();
		if (text.includes("[diary]")) process.stdout.write(`  [server] ${text}`);
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
	throw new Error("server did not start");
}

interface Wire {
	id: string;
	status?: string;
	source?: string;
	localSource?: string;
	entryDate?: string;
	finalText?: string;
	rawSnapshot?: string;
	types?: string[];
	mood?: number | null;
	createdAt?: number;
	updatedAt?: number;
	deleted?: boolean;
	conversationId?: string | null;
}

async function sync(entries: Wire[], since = 0): Promise<{ entries: Wire[]; serverTime: number }> {
	const response = await fetch(`${BASE}/api/v1/diary/sync`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
		body: JSON.stringify({ entries, since }),
	});
	if (!response.ok) throw new Error(`sync ${response.status}: ${await response.text()}`);
	return (await response.json()) as { entries: Wire[]; serverTime: number };
}

async function status(): Promise<{ count: number; items: Array<Record<string, unknown>> }> {
	const response = await fetch(`${BASE}/api/v1/diary/status`, {
		headers: { Authorization: `Bearer ${TOKEN}` },
	});
	return (await response.json()) as { count: number; items: Array<Record<string, unknown>> };
}

const manual: Wire = {
	id: "01j-manual-0001",
	status: "CONFIRMED",
	source: "MANUAL",
	localSource: "MANUAL",
	entryDate: "2026-10-29",
	finalText: "今天自己写的一段。",
	rawSnapshot: "",
	types: ["NOTE"],
	mood: null,
	createdAt: 1_761_700_000_000,
	updatedAt: 1_761_700_000_000,
	conversationId: null,
};

const reordered: Wire = {
	id: "01j-ai-0002",
	status: "CONFIRMED",
	source: "AI_REARRANGED",
	localSource: "INTERVIEW",
	entryDate: "2026-10-29",
	finalText: "对话之后的总结成稿。",
	rawSnapshot: "用户：今天很累\n助手：……",
	types: ["FEELING", "NOTE"],
	mood: 3,
	createdAt: 1_761_700_100_000,
	updatedAt: 1_761_700_100_000,
	conversationId: "oa-abc123",
};

async function main(): Promise<void> {
	rmSync(DB, { force: true });
	const server = startServer();
	try {
		await waitForReady();

		console.log("1) 首次同步：两条上行，source 区分正确");
		const first = await sync([manual, reordered]);
		// since=0 是"整批下拉"，所以刚上行的行会原样回吐（客户端按 updatedAt 幂等跳过）
		check(
			first.entries.every((entry) => entry.id === manual.id || entry.id === reordered.id),
			"首次下行只含刚上行的两条",
			`out=${first.entries.length}`,
		);
		let snapshot = await status();
		check(snapshot.count === 2, "镜像里应有两条", `count=${snapshot.count}`);
		check(
			snapshot.items.some((item) => item.id === manual.id && item.source === "MANUAL"),
			"手写那条 source=MANUAL",
		);
		check(
			snapshot.items.some((item) => item.id === reordered.id && item.source === "AI_REARRANGED"),
			"收敛那条 source=AI_REARRANGED",
		);
		check(
			snapshot.items.some((item) => item.localSource === "INTERVIEW"),
			"保留手机端原始来源（localSource=INTERVIEW）",
		);

		console.log("2) 幂等：同一批重发不新增行");
		await sync([manual, reordered]);
		snapshot = await status();
		check(snapshot.count === 2, "重发后仍是两条", `count=${snapshot.count}`);

		console.log("3) 下行增量：since=0 能整批拉回（换机恢复的主路径）");
		const pulled = await sync([], 0);
		check(pulled.entries.length === 2, "下行应带回两条", `out=${pulled.entries.length}`);
		check(
			pulled.entries.find((entry) => entry.id === reordered.id)?.rawSnapshot === reordered.rawSnapshot,
			"raw_snapshot 完整拉回",
		);
		check(pulled.serverTime > 0, "serverTime 为正整数毫秒", String(pulled.serverTime));

		console.log("4) 删除：deleted=true 上行 → 软标记，正文保留");
		// 真机上行的墓碑**只带 id + 删除时刻**（正文为空）：这里必须照原样模拟，
		// 否则"墓碑走了覆盖分支把正文抹成空"的 bug 探针看不见（2026-10-29 真机就撞了这个）。
		await sync([{ id: reordered.id, deleted: true, updatedAt: reordered.updatedAt! + 5000 }]);
		snapshot = await status();
		const deletedItem = snapshot.items.find((item) => item.id === reordered.id);
		check(deletedItem?.deleted === true, "镜像标 deleted=true");
		check(Number(deletedItem?.chars) > 0, "软删后正文仍在（供后期分析）", `chars=${deletedItem?.chars}`);
		check(deletedItem?.entryDate === reordered.entryDate, "软删后 entryDate 未被抹掉", `${deletedItem?.entryDate}`);

		console.log("5) 删除不自愈：再发一次旧 updatedAt 的非删版本");
		const revive = await sync([{ ...reordered, deleted: false, updatedAt: reordered.updatedAt! }]);
		snapshot = await status();
		check(
			snapshot.items.find((item) => item.id === reordered.id)?.deleted === true,
			"镜像仍是 deleted=true（旧版本覆盖不回来）",
		);
		check(
			revive.entries.some((entry) => entry.id === reordered.id && entry.deleted === true),
			"响应回吐胜出行，客户端据此标删",
		);

		console.log("6) 云端更新覆盖本地：上行更旧 → 响应带回镜像版本");
		const conflict = await sync(
			[{ ...manual, finalText: "旧版本正文", updatedAt: manual.updatedAt! - 1000 }],
			0,
		);
		const winner = conflict.entries.find((entry) => entry.id === manual.id);
		check(winner?.finalText === manual.finalText, "镜像版本胜出并回给客户端", winner?.finalText ?? "");

		console.log("7) 8KB 截断保护");
		const huge = "永".repeat(20000); // 每个汉字 3 字节 → 约 60KB
		await sync([{ ...manual, finalText: huge, rawSnapshot: huge, updatedAt: manual.updatedAt! + 10_000 }]);
		snapshot = await status();
		const clipped = Number(snapshot.items.find((item) => item.id === manual.id)?.chars);
		check(clipped > 0 && clipped <= 2730, "final_text 按 8KB 字节截断", `chars=${clipped}`);

		console.log("8) 未授权一律 403 空体");
		const denied = await fetch(`${BASE}/api/v1/diary/sync`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer wrong" },
			body: JSON.stringify({ entries: [], since: 0 }),
		});
		check(denied.status === 403, "错误令牌被拒", `status=${denied.status}`);
		check((await denied.text()).length === 0, "403 响应体为空");
	} finally {
		server.kill();
		await sleep(200);
		rmSync(DB, { force: true });
	}

	console.log(failures === 0 ? "\n全部通过 ✅" : `\n${failures} 项失败 ❌`);
	process.exit(failures === 0 ? 0 : 1);
}

await main();
