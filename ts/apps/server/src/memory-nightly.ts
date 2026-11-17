/**
 * 记忆 · 每晚自动整理（2026-11-14；2026-11-16 合并"拆分 + 对账"）
 *
 * 用户口径：每天像手动点一次"整理"那样泡一遍。**机械拆分自动做，语义对账只出建议**：
 *   - 先拆：把 ≥200 字的长记忆拆成原子，原文进档案（无模型、无损、可回退）；
 *   - 再对账：重复 / 过时 / 说法冲突只出建议，早上人来点（D18 不变）。
 * 与手动共用同一条 `startReview` 路径（同提示词、同证据、同审计），区别只有触发者：
 *   - global（总管 + 我的记忆）一次；
 *   - 每个在职执事各一次（他们的记忆互不可见，不能混在一个 scope 里整理）。
 *
 * 三个硬约束：
 * 1. 语义改动不自动应用、不自动删除。D18 不变：应用永远是人逐条点。
 * 2. 串行跑（一次一个 scope）。同时打 N 个模型请求既浪费、又容易触发上游限流。
 * 3. 跨重启不重复：当天跑过的日期落 `.data/memory-nightly.json`；服务 03:30 没开着的日子，
 *    启动后补跑一次（`MEMORY_NIGHTLY_REVIEW=false` 可整体关掉）。
 *
 * 日志只记 scope / 条数 / 耗时（D8），不记正文。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { memoryEngine } from "./agent/assist.ts";
import { flagEnabled } from "./flags.ts";
import { consolidateLlmEnabled, reviewModelAvailable, startReview } from "./memory-consolidate.ts";
import { runConsolidatePass } from "./memory-consolidate-pass.ts";
import { applySplitPlan, buildSplitPlan, memorySplitEnabled } from "./memory-split.ts";
import { CHIEF_PARTNER_ID, COMPANIONS_ENABLED, partnersStore } from "./partners.ts";

const DEFAULT_AT = "03:30";
/** 启动补跑延迟：让服务先完成恢复（恢复扫描/会话自愈）再打模型。 */
const CATCH_UP_DELAY_MS = 90_000;

interface NightlySplitResult {
	documents: number;
	atoms: number;
	archived: number;
	skipped: number;
	failed: number;
}

interface NightlyState {
	lastRunDay: string;
	lastFinishedAt: string | null;
	lastScopes: Array<{
		scope: string;
		ok: boolean;
		proposals: number;
		error?: string;
		/** 2026-11-16：当晚这个 scope 的机械拆分结果（0 = 没有长记忆可拆）。 */
		split?: NightlySplitResult;
	}>;
}

interface TimerHandle {
	unref?: () => void;
}

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;

/** 每晚拆分开关（2026-11-16）：默认开；`MEMORY_NIGHTLY_SPLIT=false/0/off` = 只对账、不拆。 */
export function memoryNightlySplitEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return flagEnabled("MEMORY_NIGHTLY_SPLIT", env);
}

function atOverridePath(): string {
	const dbPath = process.env.MEMORY_DB_PATH ?? ".data/memory.db";
	return join(dirname(dbPath), "memory-nightly-at.json");
}

function readAtOverride(): string | null {
	try {
		const parsed = JSON.parse(readFileSync(atOverridePath(), "utf8")) as { at?: unknown };
		if (typeof parsed.at !== "string") return null;
		const match = /^(\d{1,2}):(\d{2})$/.exec(parsed.at.trim());
		if (!match) return null;
		const hour = Number(match[1]);
		const minute = Number(match[2]);
		if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) return null;
		return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
	} catch {
		return null;
	}
}

/** 页面改时间：落盘；重启调度器后生效。 */
export function setMemoryNightlyAt(at: string): boolean {
	const match = /^(\d{1,2}):(\d{2})$/.exec((at || "").trim());
	if (!match) return false;
	const hour = Number(match[1]);
	const minute = Number(match[2]);
	if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) return false;
	const path = atOverridePath();
	const tmp = `${path}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(tmp, JSON.stringify({ at: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` }, null, 2), "utf8");
		renameSync(tmp, path);
		return true;
	} catch (error) {
		console.warn(`[memory] 每晚整理时间落盘失败: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
}

export function memoryNightlyEnabled(): boolean {
	return flagEnabled("MEMORY_NIGHTLY_REVIEW");
}

export function memoryNightlyAt(): string {
	return readAtOverride() ?? memoryNightlyEnvAt();
}

function memoryNightlyEnvAt(): string {
	const raw = (process.env.MEMORY_NIGHTLY_AT ?? "").trim();
	const match = /^(\d{1,2}):(\d{2})$/.exec(raw);
	if (!match) return DEFAULT_AT;
	const hour = Number(match[1]);
	const minute = Number(match[2]);
	if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) return DEFAULT_AT;
	return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function statePath(): string {
	const dbPath = process.env.MEMORY_DB_PATH ?? ".data/memory.db";
	return join(dirname(dbPath), "memory-nightly.json");
}

interface NightlyTaskOverride {
	enabled: boolean;
	deleted: boolean;
}

type NightlyTaskOverrides = Record<string, NightlyTaskOverride>;

function tasksPath(): string {
	const dbPath = process.env.MEMORY_DB_PATH ?? ".data/memory.db";
	return join(dirname(dbPath), "memory-nightly-tasks.json");
}

function readTaskOverrides(): NightlyTaskOverrides {
	try {
		const parsed = JSON.parse(readFileSync(tasksPath(), "utf8")) as Record<string, unknown>;
		const out: NightlyTaskOverrides = {};
		for (const [scope, value] of Object.entries(parsed || {})) {
			if (!value || typeof value !== "object") continue;
			const row = value as Partial<NightlyTaskOverride>;
			out[scope] = {
				enabled: row.enabled !== false,
				deleted: row.deleted === true,
			};
		}
		return out;
	} catch {
		return {};
	}
}

function writeTaskOverrides(value: NightlyTaskOverrides): void {
	const path = tasksPath();
	const tmp = `${path}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
		renameSync(tmp, path);
	} catch (error) {
		console.warn(`[memory] 每晚整理任务状态落盘失败: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function taskState(scope: string, overrides = readTaskOverrides()): NightlyTaskOverride {
	return overrides[scope] ?? { enabled: true, deleted: false };
}

function localDayKey(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function readState(): NightlyState {
	try {
		const parsed = JSON.parse(readFileSync(statePath(), "utf8")) as Partial<NightlyState>;
		return {
			lastRunDay: typeof parsed.lastRunDay === "string" ? parsed.lastRunDay : "",
			lastFinishedAt: typeof parsed.lastFinishedAt === "string" ? parsed.lastFinishedAt : null,
			lastScopes: Array.isArray(parsed.lastScopes) ? parsed.lastScopes : [],
		};
	} catch {
		return { lastRunDay: "", lastFinishedAt: null, lastScopes: [] };
	}
}

function writeState(state: NightlyState): void {
	const path = statePath();
	const tmp = `${path}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
		renameSync(tmp, path);
	} catch (error) {
		console.warn(`[memory] 每晚整理状态落盘失败: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** 本次要整理的范围：我的 + 每个在职执事（与 /memory/scopes 同一口径）。 */
function nightlyScopes(): Array<{ scope: string; label: string }> {
	const scopes = [{ scope: "global", label: "我的记忆" }];
	if (!COMPANIONS_ENABLED) return scopes;
	try {
		for (const partner of partnersStore().list()) {
			if (!partner.id || partner.id === CHIEF_PARTNER_ID) continue;
			if (partner.status === "archived") continue;
			scopes.push({ scope: `partner:${partner.id}`, label: partner.name || partner.id });
		}
	} catch (error) {
		console.warn(`[memory] 每晚整理读执事失败: ${error instanceof Error ? error.message : String(error)}`);
	}
	return scopes;
}

/** 供定时任务页展示：每晚整理会覆盖哪些人（只读，跳过已删除的）。 */
export function memoryNightlyScopes(): Array<{ scope: string; label: string; enabled: boolean }> {
	const overrides = readTaskOverrides();
	return nightlyScopes()
		.map((item) => ({ ...item, enabled: taskState(item.scope, overrides).enabled }))
		.filter((item) => !taskState(item.scope, overrides).deleted);
}

/** 页面能不能操作这个范围（防止拿一个不存在的 scope 改状态）。 */
export function memoryNightlyTaskExists(scope: string): boolean {
	return nightlyScopes().some((item) => item.scope === scope);
}

/** 暂停 / 启用一个人的整理任务；返回是否找到。 */
export function setMemoryNightlyTaskEnabled(scope: string, enabled: boolean): boolean {
	if (!memoryNightlyTaskExists(scope)) return false;
	const overrides = readTaskOverrides();
	const current = taskState(scope, overrides);
	overrides[scope] = { enabled, deleted: current.deleted };
	writeTaskOverrides(overrides);
	return true;
}

/** 删除一个人的整理任务；只停调度，不动这个人的记忆。 */
export function deleteMemoryNightlyTask(scope: string): boolean {
	if (!memoryNightlyTaskExists(scope)) return false;
	const overrides = readTaskOverrides();
	overrides[scope] = { enabled: false, deleted: true };
	writeTaskOverrides(overrides);
	return true;
}

/** 跑一遍。导出供探针/测试直接调用；正常由定时器触发。 */
export async function runMemoryNightlyReview(now = new Date()): Promise<void> {
	if (running) return;
	if (!memoryNightlyEnabled()) return;
	if (!memoryEngine) return;
	// 拆分不需要模型：没有可用模型也照拆，只是跳过对账。
	const canReview = consolidateLlmEnabled() && reviewModelAvailable();
	if (!canReview) {
		console.log("[memory] 每晚对账跳过：没有可用模型；机械拆分照常跑");
	}
	const day = localDayKey(now);
	const state = readState();
	if (state.lastRunDay === day) return;

	running = true;
	const started = Date.now();
	const results: NightlyState["lastScopes"] = [];
	try {
		const overrides = readTaskOverrides();
		for (const item of nightlyScopes()) {
			const task = taskState(item.scope, overrides);
			if (task.deleted || !task.enabled) continue;

			// 1) 机械拆分：长记忆 → 原子 + 原文档案；无模型、无损、幂等。
			let split: NightlySplitResult | undefined;
			if (memorySplitEnabled() && memoryNightlySplitEnabled()) {
				try {
					const preview = buildSplitPlan(memoryEngine, item.scope);
					if (preview.plans.length > 0) {
						split = applySplitPlan(memoryEngine, preview);
						console.log(
							`[memory] 每晚拆分 ${item.label} 文档=${split.documents} 原子=${split.atoms} 归档=${split.archived} 跳过=${split.skipped} 失败=${split.failed}`,
						);
					}
				} catch (error) {
					const detail = error instanceof Error ? error.message : String(error);
					console.warn(`[memory] 每晚拆分 ${item.label} 失败: ${detail.slice(0, 200)}`);
				}
			}

			// 2) 确定性审计：总是跑（不需要模型），只写 diff 建议。
			let auditOk = true;
			try {
				runConsolidatePass(item.scope);
			} catch (error) {
				auditOk = false;
				const detail = error instanceof Error ? error.message : String(error);
				console.warn(`[memory] 每晚审计 ${item.label} 失败: ${detail.slice(0, 200)}`);
			}

			// 3) 语义对账：只出建议，人逐条应用（D18）。
			if (!canReview) {
				results.push({
					scope: item.scope,
					ok: auditOk,
					proposals: 0,
					...(auditOk ? {} : { error: "audit_failed" }),
					...(split ? { split } : {}),
				});
				continue;
			}
			const job = startReview(item.scope);
			if (job.alreadyRunning || !job.promise) {
				results.push({
					scope: item.scope,
					ok: false,
					proposals: 0,
					error: "already_running",
					...(split ? { split } : {}),
				});
				continue;
			}
			const result = await job.promise;
			const proposals = result.ok ? result.proposals.length : 0;
			results.push({
				scope: item.scope,
				ok: result.ok,
				proposals,
				...(result.ok ? {} : { error: result.error }),
				...(split ? { split } : {}),
			});
			console.log(
				`[memory] 每晚整理 ${item.label} ${result.ok ? `建议=${proposals}` : `失败=${result.error}`} ${Date.now() - started}ms`,
			);
		}
	} finally {
		running = false;
		writeState({
			lastRunDay: day,
			lastFinishedAt: new Date().toISOString(),
			lastScopes: results,
		});
		// 兜底：模型异常时 startReview 会自己记错误，这里只留一行总数
		const total = results.reduce((sum, item) => sum + item.proposals, 0);
		const splitAtoms = results.reduce((sum, item) => sum + (item.split?.atoms ?? 0), 0);
		console.log(
			`[memory] 每晚整理结束：${results.length} 个范围，拆出 ${splitAtoms} 条原子，共 ${total} 条建议`,
		);
	}
}

/** 下一次触发时刻（本地时区）。 */
export function nextNightlyAt(now: Date, at = memoryNightlyAt()): Date {
	const [hourText, minuteText] = at.split(":");
	const next = new Date(now);
	next.setHours(Number(hourText), Number(minuteText), 0, 0);
	if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
	return next;
}

function schedule(delayMs: number): void {
	if (timer) clearTimeout(timer);
	timer = setTimeout(() => {
		void runMemoryNightlyReview()
			.catch((error: unknown) => {
				console.warn(`[memory] 每晚整理异常: ${error instanceof Error ? error.message : String(error)}`);
			})
			.finally(() => {
				schedule(Math.max(1000, nextNightlyAt(new Date()).getTime() - Date.now()));
			});
	}, Math.max(1000, delayMs));
	timer.unref?.();
}

/**
 * 启动调度。幂等：重复调用不会叠出第二个定时器。
 * - 今天 03:30 还没过 → 等到 03:30；
 * - 已经过了、今天还没跑 → 90 秒后补跑，然后接明天 03:30。
 */
export function startMemoryNightlyScheduler(): void {
	if (!memoryNightlyEnabled()) return;
	if (!memoryEngine) return;
	if (timer) return;

	const now = new Date();
	const at = memoryNightlyAt();
	const todayAt = nextNightlyAt(new Date(now.getTime() - 24 * 60 * 60 * 1000), at);
	const ranToday = readState().lastRunDay === localDayKey(now);
	const delay = ranToday
		? Math.max(1000, nextNightlyAt(now, at).getTime() - now.getTime())
		: todayAt.getTime() <= now.getTime()
			? CATCH_UP_DELAY_MS
			: Math.max(1000, todayAt.getTime() - now.getTime());
	schedule(delay);
	console.log(
		`[memory] 每晚整理已挂：每天 ${at}，${ranToday ? "今天已跑过" : "今天待补跑"}，下次 ${new Date(Date.now() + delay).toISOString()}`,
	);
}

/** 测试用：停掉定时器 / 重置运行标记。生产不调用。 */
export function stopMemoryNightlyScheduler(): void {
	if (timer) clearTimeout(timer);
	timer = null;
	running = false;
}

/** 页面上改完时间后重排下一次；不影响正在跑的那一轮。 */
export function restartMemoryNightlyScheduler(): void {
	stopMemoryNightlyScheduler();
	startMemoryNightlyScheduler();
}
