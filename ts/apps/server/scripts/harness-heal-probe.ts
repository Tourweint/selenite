/**
 * Harness 自愈探针（2026-11-07）。
 *
 * 验的是「底层 Session 因一次存储错误死掉之后，下一次取用能不能自己重开」。
 * 真实场景长这样：SQLite 被别的东西短暂锁住 / 磁盘抖一下 → 内核第一次抛错就把整份
 * Session 判死（SessionFailed），此后每一次读写都立刻失败，页面于是全站 500。
 *
 * 这里不 mock 业务，只在**存储层**插一次真实失败（包装 Storage，让下一次 commit 抛
 * 真的 Error），然后看：
 *   1. 这次失败确实变成 SessionFailed（内核口径）；
 *   2. 不重启进程，重开之后照样能读到之前已提交的数据。
 *
 *   pnpm --filter @lifediary/server harness-heal
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness, SessionFailed, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

const DB = ".data/probe-harness-heal.sqlite";
const CTX = BACKGROUND_CONTEXT;
const registry = createRegistry();
const models = createModels();

let failures = 0;
function check(ok: boolean, label: string, detail = ""): void {
	if (ok) {
		console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
	} else {
		failures += 1;
		console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

/** 包一层：`breakNext()` 之后的下一次 commit 直接抛错（模拟一次真实 IO 失败）。 */
function flaky(storage: Storage): Storage & { breakNext: () => void } {
	let broken = false;
	// 必须用 Proxy 转发而不是 `{...storage}`：Storage 是 class 实例，方法在原型链上，
	// 展开只会拿到可枚举的自有字段，`scanTasks` 之类会整个消失（实测踩过）。
	const proxy = new Proxy(storage, {
		get(target, prop, receiver) {
			if (prop === "breakNext") {
				return () => {
					broken = true;
				};
			}
			if (prop === "commit") {
				return (writes: Parameters<Storage["commit"]>[0], context: Parameters<Storage["commit"]>[1]) => {
					if (broken) {
						broken = false;
						throw new Error("probe: disk I/O error");
					}
					return target.commit(writes, context);
				};
			}
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as Storage & { breakNext: () => void };
	return proxy;
}

async function open(store: Storage) {
	return Harness.open(store, { models, registry }, CTX);
}

mkdirSync(dirname(DB), { recursive: true });
rmSync(DB, { force: true });
rmSync(`${DB}-shm`, { force: true });
rmSync(`${DB}-wal`, { force: true });

console.log("[1] 正常打开，建一个会话（先落一份已提交状态）");
const storage1 = openNodeSqliteStorage(DB);
const wrapped = await storage1.then(flaky);
const first = await open(wrapped);
const root = await first.root(CTX, {});
check(Boolean(root), "root 会话已创建");

console.log("[2] 让下一次 commit 失败（模拟一次瞬时存储错误）");
wrapped.breakNext();
let firstError: unknown;
try {
	await first.createConversation({ ownership: { kind: "ownerless" } }, CTX);
} catch (error) {
	firstError = error;
}
// 内核口径（session.d.ts）：**第一个**撞上 Storage 错误的调用拿到原始错误，
// 之后每一个调用拿到 SessionFailed。所以判"Session 死了"必须看第二次。
check(
	!(firstError instanceof SessionFailed),
	"第一个失败调用拿到原始错误（不是 SessionFailed）",
	String((firstError as Error)?.message ?? firstError),
);

let seen: unknown;
try {
	await first.root(CTX, {});
} catch (error) {
	seen = error;
}
check(
	seen instanceof SessionFailed,
	"后续调用被内核判定为 SessionFailed（整份 Session 作废）",
	String((seen as Error)?.message ?? seen),
);

console.log("[3] 不重启进程，重开一份再读之前的数据");
const second = await open(await openNodeSqliteStorage(DB));
const root2 = await second.root(CTX, {});
check(Boolean(root2), "重开后 root 会话仍在（从已提交状态恢复）");

console.log("[4] 重开之后写操作正常");
const created = await second.createConversation({ ownership: { kind: "ownerless" } }, CTX);
check(Boolean(created?.id), "重开后仍能建会话");

await second.close(CTX);
rmSync(DB, { force: true });
rmSync(`${DB}-shm`, { force: true });
rmSync(`${DB}-wal`, { force: true });

if (failures > 0) {
	console.log(`\n${failures} 项未通过`);
	process.exitCode = 1;
} else {
	console.log("\n全部通过");
}
