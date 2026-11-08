/**
 * 宰相层验证 1/4：Windows 下 pid 存活判断是否可靠（2026-11-08 扫尾批 8a）。
 *
 * 验的是 `chancellor/src/lease.ts` 的 `isPidAlive()`——崩溃恢复（inflight）与
 * 租约过期（lease）都拿它当"进程还在不在"的唯一判据。
 *
 * 结论要回答的是"哪类情况下会误判活/死"，不是"函数有没有 bug"：
 *   1. 正常活 / 正常死 / 无权限 / 非法 pid 的行为；
 *   2. **pid 被回收后被别的进程复用**——无法在系统里稳定制造"同 pid 换人"，
 *      但判据只看 pid、不看启动时间，所以"拿一个无关活进程的 pid 写进记录"
 *      与"pid 被复用"对函数是**同一份输入**；这里用前者等价模拟，并跑到
 *      崩溃恢复那一层看后果（原单被判 still_running，永不接管）。
 *   3. 租约的两道闸：心跳过期 vs pid 死亡，哪个先成立；pid 误判活时
 *      租约最长会被拖多久（LEASE_STALE_MS）。
 *
 *   pnpm --filter @lifediary/server pid
 */
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoverDelegations } from "../../../../../chancellor/src/index.ts";
import { isPidAlive, LeaseManager, releaseStaleLeases } from "../../../../../chancellor/src/lease.ts";
import { inflightPath, readInflight, startInflight } from "../../../../../chancellor/src/inflight.ts";

let failures = 0;
function check(ok: boolean, label: string, detail = ""): void {
	if (ok) {
		console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
	} else {
		failures += 1;
		console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 起一个活着但与本仓库无关的进程，模拟"pid 已被回收给别的进程"。 */
function spawnUnrelated(): ChildProcess {
	return spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], {
		stdio: "ignore",
		windowsHide: true,
	});
}

const TEMP = mkdtempSync(join(tmpdir(), "lifediary-pid-"));
const child = spawnUnrelated();

try {
	console.log("[1] 基本行为（Windows / Node " + process.version + "）");
	check(isPidAlive(process.pid), "当前进程 pid → 活", `pid=${process.pid}`);

	const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore", windowsHide: true });
	const deadPid = dead.pid ?? -1;
	await new Promise((resolve) => dead.once("exit", resolve));
	await wait(200);
	check(!isPidAlive(deadPid), "已退出进程 pid → 死", `pid=${deadPid}`);

	let eperm = "";
	try {
		process.kill(4, 0);
		eperm = "alive";
	} catch (error) {
		eperm = (error as NodeJS.ErrnoException).code ?? "unknown";
	}
	check(isPidAlive(4), "无权限进程（Windows pid 4）→ 判活（EPERM 当活）", `process.kill=${eperm}`);

	check(!isPidAlive(0), "pid 0 → 死（函数自己挡掉，process.kill(0,0) 本身会返回成功）");
	check(!isPidAlive(-1), "负数 pid → 死");
	check(!isPidAlive(1.5), "非整数 pid → 死");
	check(!isPidAlive(999_999), "不存在的 pid → 死");

	console.log("\n[2] pid 复用：一个无关活进程顶着记录里的 pid");
	check(Boolean(child.pid), "无关进程已起", `pid=${child.pid}`);
	check(isPidAlive(child.pid ?? -1), "判据返回活（与'pid 被复用'完全同一份输入）");

	// 把这具"别人的 pid"写进 inflight，跑真正的启动恢复，看后果。
	const workRoot = join(TEMP, "runs");
	const ticketId = "T-reused-pid";
	const ticketDir = join(workRoot, ticketId);
	mkdirSync(ticketDir, { recursive: true });
	writeFileSync(
		join(ticketDir, "ticket.json"),
		JSON.stringify({
			id: ticketId,
			prompt: "探针：pid 复用",
			status: "dispatching",
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
			options: { dry: false, maxTasks: 1, workRoot },
		}),
	);
	startInflight(ticketDir, ticketId);
	// startInflight 写的是当前进程的 pid；改成一个"看起来还活着"的无关进程 pid，
	// 这正是内核崩溃后 PID 被系统回收给别人的状态。
	const record = readInflight(ticketDir);
	check(Boolean(record), "inflight 已落盘");
	writeFileSync(
		inflightPath(ticketDir),
		JSON.stringify({ ...record, pid: child.pid, updatedAt: new Date().toISOString() }),
	);
	const summary = await recoverDelegations(workRoot, { log: () => {} });
	check(
		summary.stillRunning === 1 && summary.resumed === 0,
		"恢复把该单判成 still_running，未接管/未自动续跑",
		`stillRunning=${summary.stillRunning} resumed=${summary.resumed}`,
	);

	console.log("\n[3] 租约：心跳与 pid 两道闸，谁先成立");
	const dataDir = join(TEMP, "data");
	const holder = new LeaseManager({ dataDir, projectId: "p", ticketId: "t-holder", seq: 1 });
	check(holder.acquire(["src/a.ts"]).ok, "holder 拿到租约");
	const sha = crypto.createHash("sha1").update("src/a.ts").digest("hex");
	const ownerFile = join(dataDir, "leases", "p", sha, "owner.json");
	// 把持有者改成一个"活着的无关进程"，心跳新鲜：租约不该被抢。
	writeFileSync(
		ownerFile,
		JSON.stringify({
			pid: child.pid,
			ticketId: "t-holder",
			seq: 1,
			path: "src/a.ts",
			acquiredAt: new Date().toISOString(),
			heartbeatAt: new Date().toISOString(),
		}),
	);
	const rival = new LeaseManager({ dataDir, projectId: "p", ticketId: "t-rival", seq: 2 });
	const blocked = rival.acquire(["src/a.ts"]);
	check(!blocked.ok, "心跳新鲜 + pid 活（复用）→ 抢不到", blocked.blockedPath ?? "");

	// 心跳过期：即使 pid 活，也按过期回收（LEASE_STALE_MS 默认 5 分钟）。
	writeFileSync(
		ownerFile,
		JSON.stringify({
			pid: child.pid,
			ticketId: "t-holder",
			seq: 1,
			path: "src/a.ts",
			acquiredAt: new Date(Date.now() - 10 * 60_000).toISOString(),
			heartbeatAt: new Date(Date.now() - 10 * 60_000).toISOString(),
		}),
	);
	const afterStale = rival.acquire(["src/a.ts"]);
	check(afterStale.ok, "心跳过期（>5min）→ pid 再活也回收");
	// 单独造一把过期锁，验启动清扫也会回收（不要拿 rival 刚拿到的新锁来验）。
	const shaStale = crypto.createHash("sha1").update("src/stale.ts").digest("hex");
	mkdirSync(join(dataDir, "leases", "p", shaStale), { recursive: true });
	writeFileSync(
		join(dataDir, "leases", "p", shaStale, "owner.json"),
		JSON.stringify({
			pid: child.pid,
			ticketId: "t-stale",
			seq: 9,
			path: "src/stale.ts",
			acquiredAt: new Date(Date.now() - 10 * 60_000).toISOString(),
			heartbeatAt: new Date(Date.now() - 10 * 60_000).toISOString(),
		}),
	);
	check(
		releaseStaleLeases(join(dataDir, "leases", "p")) >= 1,
		"启动清扫 releaseStaleLeases 也会回收过期锁",
	);

	// 反向：pid 已死 + 心跳新鲜 → isStale 里的 pid 检查直接判过期。
	rival.releaseAll();
	const holder2 = new LeaseManager({ dataDir, projectId: "p", ticketId: "t-holder", seq: 1 });
	holder2.acquire(["src/b.ts"]);
	const shaB = crypto.createHash("sha1").update("src/b.ts").digest("hex");
	writeFileSync(
		join(dataDir, "leases", "p", shaB, "owner.json"),
		JSON.stringify({
			pid: deadPid,
			ticketId: "t-holder",
			seq: 1,
			path: "src/b.ts",
			acquiredAt: new Date().toISOString(),
			heartbeatAt: new Date().toISOString(),
		}),
	);
	const r2 = new LeaseManager({ dataDir, projectId: "p", ticketId: "t-rival", seq: 3 });
	const got = r2.acquire(["src/b.ts"]);
	check(got.ok, "pid 已死 + 心跳新鲜 → 立刻回收");
	r2.releaseAll();
	holder2.releaseAll();

	console.log(
		"\n[结论] 误判面：① pid 复用后判活——恢复永不接管（无超时），租约最多拖 5 分钟；" +
			"② EPERM 当活是正确取舍；③ 真正的竞争窗口是'检查后进程刚好退出'（TOCTOU），无解但极窄。",
	);
} finally {
	child.kill();
	try {
		rmSync(TEMP, { recursive: true, force: true });
	} catch {
		/* 临时目录留给系统清 */
	}
}

console.log(failures === 0 ? "\n✓ pid 存活判断实测完成，全部符合预期" : `\n✗ 有 ${failures} 项不对`);
process.exit(failures === 0 ? 0 : 1);
