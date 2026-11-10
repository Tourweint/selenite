import type { Hono } from "hono";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { insideOrEqual, realTargetOf } from "./path-guard.ts";
import {
	findSkillInDir,
	resolveSkillsDir,
	scanSkillDir,
	type ResolvedSkillsDir,
	type SkillSource,
} from "./skills.ts";
import { getSkillState } from "./skill-state.ts";
import { isSkillStale, readSkillUsage, skillUsageEnabled } from "./skill-usage.ts";
import {
	adviceSystemPrompt,
	adviceViewOf,
	generateAdvice,
	illegalAdviceActions,
	parseAdviceResponse,
	pruneAdviceSnapshot,
	readAdviceSnapshot,
	skillAdviceEnabled,
	skillAdvicePath,
	writeAdviceSnapshot,
	type AdviceSkillRow,
} from "./skill-advice.ts";
import { readLlmConfig } from "./provider.ts";

/**
 * 技能管理端点（2026-11-08 扫尾批 9-S；2026-11-08 批 10-A 改多来源只读展示）。
 *
 * 动作都是"人对自己的技能库"的操作：
 *   GET    /api/v1/agent/skills        列表（全部来源；名字 + 摘要 + 大小 + 更新时间 + 来源）
 *   GET    /api/v1/agent/skills/:name  读一条（.md / SKILL.md 全文；任意来源都可读）
 *   PUT    /api/v1/agent/skills/:name  写一条（只在**主目录**；不存在即新建）
 *   DELETE /api/v1/agent/skills/:name  删一条（**只删主目录**；删除即停用，没有启停位）
 *
 * 口径照本项目其它管理端点：
 *   - 鉴权失败 403 空体（auth 中间件统一处理，这里不碰）；
 *   - 技能名不合法 / 正文超限 / 路径越界 / 只读来源 → 400 带说明；
 *   - 找不到 → 404 `not_found`；
 *   - `SKILLS_ADMIN=false` → 整组路由不挂（404 = 未启用）。
 *
 * **写操作锁死在 `resolveSkillsDir()` 的主目录内**：名字白名单挡穿越，realpath 复核
 * （复用 path-guard 的 `realTargetOf` / `insideOrEqual`）挡"目录内符号链接指向外面"。
 * `~/.agents/skills` 是别的工具的家：**可读、不可写/删**（连影子副本都不落主目录——
 * 那样用户会以为自己改的是那一份）。应用目录的内置手册仍允许在用户目录写同名技能覆盖，
 * 这是 9-S 就有的合并语义（先到先得）。
 *
 * 为什么不做启停位：技能是目录里的文件，删除即停；多一个"禁用"状态就多一份与磁盘不一致的状态。
 * 增删只影响下一个会话（D5 的既有取舍），界面文案如实说明。
 *
 * **永不自动删除（2026-11-10 批 17 §四.4，纪律）**：技能只能由人删。
 * 用量账只负责标记 `stale`（>90 天未用），不删、不移、不改文件；
 * 本文件里唯一的删除是用户显式 `DELETE /skills/:name`。别在这里加"自动清理"。
 */

/** 单槽上限 64KB（与执事 SOUL/USER/技能同口径，cindy 同款） */
export const SKILL_SLOT_LIMIT = 64 * 1024;

/**
 * 技能名白名单：小写字母/数字/短横线/下划线，1-64 字符，且不能以 `-`/`_` 开头。
 * 与 `partner_skill_write` 的 slug 校验同一条正则——两条写技能的入口不能各有一套名字规则。
 */
const SKILL_NAME = /^[a-z0-9][a-z0-9-_]{0,63}$/;

/** 回滚开关：false/0/off = 端点不挂（设置页显示未启用），一行退回"只能手工放文件" */
export function skillsAdminEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env.SKILLS_ADMIN?.trim().toLowerCase();
	if (!raw) return true;
	return raw !== "false" && raw !== "0" && raw !== "off";
}

export interface SkillsApiDeps {
	/** 覆盖目录解析（单测/探针指临时目录）；不传 = resolveSkillsDir() */
	resolve?: () => ResolvedSkillsDir;
	/** 覆盖回滚开关（单测）；不传 = skillsAdminEnabled() */
	enabled?: boolean;
}

type SkillPath =
	| { ok: false; message: string }
	| { ok: true; path: string };

/** 名字校验 + 真实落点复核：目标（含符号链接解引用后）必须仍在技能目录内。 */
function skillPathOf(dir: string, name: string): SkillPath {
	if (!SKILL_NAME.test(name)) {
		return {
			ok: false,
			message: "技能名只能是小写字母 / 数字 / 短横线 / 下划线，1-64 字符",
		};
	}
	let root: string;
	try {
		root = realpathSync(dir);
	} catch {
		return { ok: false, message: "技能目录不存在" };
	}
	const path = join(dir, `${name}.md`);
	if (!insideOrEqual(root, realTargetOf(path))) {
		return { ok: false, message: "路径越出技能目录" };
	}
	return { ok: true, path };
}

/** 正文校验：与 `createSkillStore` 的收录条件保持一致，不写出"索引里看不见"的文件。 */
function contentProblem(content: string): string | null {
	if (Buffer.byteLength(content, "utf8") > SKILL_SLOT_LIMIT) {
		return "技能正文最多 64KB";
	}
	const [first, ...rest] = content.trim().split(/\r?\n/);
	if (!first?.trim()) return "第 1 行是索引摘要，不能为空";
	if (!rest.join("\n").trim()) return "第 1 行是摘要，第 2 行起是正文：至少要有两行";
	return null;
}

/** 先写临时文件再改名：读到的永远是整份文件，不会撞上半份手册。 */
function atomicWrite(path: string, content: string): void {
	const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
	try {
		writeFileSync(temp, content, "utf8");
		renameSync(temp, path);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

/** 只读来源里的同名技能（用于把"不能在这里改"说清楚，而不是默默落一份影子副本）。 */
function readOnlyMatchOf(sources: SkillSource[], name: string): SkillSource | null {
	for (const source of sources) {
		if (source.writable) continue;
		// `~/.agents/skills` 只读；应用目录允许被用户目录同名覆盖（9-S 的合并语义），不拦
		if (source.origin !== "agents") continue;
		if (findSkillInDir(source.dir, name)) return source;
	}
	return null;
}

/**
 * 管理面（列表 / 读一条）的越界复核：文件解引用后必须仍在该来源目录内。
 *
 * 加载器（模型侧）不设这道闸——那里只是读用户自己的目录；但管理端点会把内容
 * 原样回给前端，目录里一个指向外部的符号链接就等于把任意文件端出去。
 */
function insideSource(dir: string, path: string): boolean {
	try {
		return insideOrEqual(realpathSync(dir), realTargetOf(path));
	} catch {
		return false;
	}
}

export function mountSkills(app: Hono, deps: SkillsApiDeps = {}): void {
	const resolve = deps.resolve ?? (() => resolveSkillsDir());
	if (!(deps.enabled ?? skillsAdminEnabled())) return;
	const skillState = getSkillState();
	const adviceOn = skillAdviceEnabled();
	const advicePath = () => skillAdvicePath();

	/** 管理面口径的技能名清单（先到先得 + 白名单 + 越界复核；与列表端点同一条规则） */
	const adminSkillNames = (): string[] => {
		const names: string[] = [];
		const claimed = new Set<string>();
		for (const source of resolve().dirs) {
			for (const entry of scanSkillDir(source.dir)) {
				if (claimed.has(entry.name)) continue;
				claimed.add(entry.name);
				if (!entry.valid) continue;
				if (!SKILL_NAME.test(entry.name)) continue;
				if (!insideSource(source.dir, entry.path)) continue;
				names.push(entry.name);
			}
		}
		return names;
	};

	/** 评估输入行：在名字清单之上带摘要 / 启停 / 用量（模型判断"本机用不上"要有材料） */
	const adminSkillRows = (): AdviceSkillRow[] => {
		const resolved = resolve();
		const usageOn = skillUsageEnabled();
		const usage = usageOn ? readSkillUsage() : {};
		const now = new Date();
		const rows: AdviceSkillRow[] = [];
		const claimed = new Set<string>();
		for (const source of resolved.dirs) {
			for (const entry of scanSkillDir(source.dir)) {
				if (claimed.has(entry.name)) continue;
				claimed.add(entry.name);
				if (!entry.valid || !SKILL_NAME.test(entry.name)) continue;
				if (!insideSource(source.dir, entry.path)) continue;
				const used = usage[entry.name];
				rows.push({
					name: entry.name,
					summary: entry.summary,
					enabled: skillState.isEnabled(entry.name),
					usageCount: usageOn ? (used?.count ?? 0) : null,
					stale: usageOn ? isSkillStale(used?.lastUsedAt ?? null, entry.path ? statSync(entry.path).mtime.toISOString() : now.toISOString()) : false,
					origin: source.origin,
				});
			}
		}
		return rows;
	};

	app.get("/api/v1/agent/skills", (c) => {
		const resolved = resolve();
		// 用量账（2026-11-10 批 17 §四）：每请求读一份；开关关着时整组字段不出现（回滚到旧形状）。
		const usageOn = skillUsageEnabled();
		const usage = usageOn ? readSkillUsage() : {};
		const now = new Date();
		const items: {
			name: string;
			summary: string;
			size: number;
			updatedAt: string;
			origin: string;
			writable: boolean;
			form: "flat" | "dir";
			enabled: boolean;
			/** 2026-11-10 批 17：可选字段，老客户端忽略即可。 */
			usageCount?: number;
			lastUsedAt?: string | null;
			stale: boolean;
		}[] = [];
		const claimed = new Set<string>();
		for (const source of resolved.dirs) {
			for (const entry of scanSkillDir(source.dir)) {
				if (claimed.has(entry.name)) continue; // 与加载器同一条先到先得规则
				claimed.add(entry.name);
				if (!entry.valid) continue;
				// 白名单外的文件名（如中文名）继续给模型用，但不进管理面：
				// 管理端点只能按白名单读写，列出来也点不开。只读来源同样按这条过滤。
				if (!SKILL_NAME.test(entry.name)) continue;
				// 目录里若有指向外部的符号链接，内容可能是任意文件——不进管理列表
				if (!insideSource(source.dir, entry.path)) continue;
				try {
					const stat = statSync(entry.path);
					if (!stat.isFile()) continue;
					const used = usage[entry.name];
					const lastUsedAt = used?.lastUsedAt ?? null;
					items.push({
						name: entry.name,
						summary: entry.summary,
						size: stat.size,
						updatedAt: stat.mtime.toISOString(),
						origin: source.origin,
						writable: source.writable,
						form: entry.form,
						// 启停位（2026-11-09）：默认全关，界面上逐条/批量开
						enabled: skillState.isEnabled(entry.name),
						// 只标记，不删不移；从未用过的以文件 mtime 为基线（新建技能不会一上来就 stale）
						...(usageOn
							? { usageCount: used?.count ?? 0, lastUsedAt }
							: {}),
						stale: usageOn
							? isSkillStale(lastUsedAt, stat.mtime.toISOString(), now)
							: false,
					});
				} catch {
					// 单个文件读不了不该让整页列表 500
				}
			}
		}
		return c.json({
			ok: true,
			dir: resolved.dir,
			origin: resolved.origin,
			dirs: resolved.dirs.map((source) => ({
				dir: source.dir,
				origin: source.origin,
				writable: source.writable,
				exists: source.exists,
			})),
			items,
		});
	});

	/** 启停位（2026-11-09 用户拍板：技能默认全关，界面上开）。开 = 进索引/能被 skill 工具取到。 */
	app.put("/api/v1/agent/skills/:name/enabled", async (c) => {
		const name = c.req.param("name");
		if (!SKILL_NAME.test(name)) {
			return c.json(
				{ error: "bad_request", message: "技能名只能是小写字母 / 数字 / 短横线 / 下划线，1-64 字符" },
				400,
			);
		}
		const body = (await c.req.json().catch(() => null)) as { enabled?: unknown } | null;
		if (typeof body?.enabled !== "boolean") {
			return c.json({ error: "bad_request", message: "enabled 必须是布尔" }, 400);
		}
		// 存在性：按加载器同一条先到先得扫一遍（关着的技能从 names() 里查不到，不能拿那个判断）
		let exists = false;
		for (const source of resolve().dirs) {
			const found = findSkillInDir(source.dir, name);
			if (found?.valid) {
				exists = true;
				break;
			}
		}
		if (!exists) return c.json({ error: "not_found", message: `没有叫「${name}」的技能` }, 404);
		skillState.setEnabled(name, body.enabled);
		return c.json({
			ok: true,
			name,
			enabled: body.enabled,
			// 索引按会话冻结（D5）：开关对已在跑的会话不生效；工具侧取手册是即时的
			note: "索引随下一个会话刷新；已在跑的会话里 skill 工具立即取不到（或恢复）这份手册",
		});
	});

	/** 批量启停（2026-11-09 用户口径：默认全关，界面上能一键全开/全关） */
	app.put("/api/v1/agent/skills/enabled-all", async (c) => {
		const body = (await c.req.json().catch(() => null)) as { enabled?: unknown } | null;
		if (typeof body?.enabled !== "boolean") {
			return c.json({ error: "bad_request", message: "enabled 必须是布尔" }, 400);
		}
		const names: string[] = [];
		const claimed = new Set<string>();
		for (const source of resolve().dirs) {
			for (const entry of scanSkillDir(source.dir)) {
				if (claimed.has(entry.name)) continue;
				claimed.add(entry.name);
				// 与列表同一条管理面规则：白名单外的名字不进管理面，也不被它批量开关
				if (entry.valid && SKILL_NAME.test(entry.name)) names.push(entry.name);
			}
		}
		skillState.setAll(body.enabled, names);
		return c.json({ ok: true, count: names.length, enabled: body.enabled, note: "索引随下一个会话刷新" });
	});

	/* ── 技能分类建议（2026-11-10 批 30；`SKILL_ADVICE=false` 回滚 = 三条路由不挂）──
	 * 建议归建议（skills-advice.json 快照），开关归开关（skills-state.json）：
	 * 本组路由里唯一的写动作是 PUT 采纳启停位（名字必须来自快照）。
	 * ego-browser 这类符号链接技能不在管理列表（insideSource 闸），天然不进评估范围。 */
	if (adviceOn) {
		app.get("/api/v1/agent/skills/advice", (c) => {
			const names = adminSkillNames();
			const view = adviceViewOf(readAdviceSnapshot(advicePath()), names);
			return c.json({ ok: true, ...view });
		});

		app.post("/api/v1/agent/skills/advice", async (c) => {
			const rows = adminSkillRows();
			if (!rows.length) {
				return c.json({ error: "bad_request", message: "技能库是空的，没有可评估的对象" }, 400);
			}
			const text = await generateAdvice(rows);
			if (text === null) {
				return c.json({ error: "unavailable", message: "模型不可用，评估没跑成" }, 503);
			}
			const items = parseAdviceResponse(text);
			if (items === null) {
				return c.json({ error: "unavailable", message: "模型输出解析失败，评估没跑成" }, 503);
			}
			// 先修旧快照（清掉已消失技能）再合并本次结果，一次性原子替换
			const previous = readAdviceSnapshot(advicePath());
			const merged = previous ? pruneAdviceSnapshot(previous, rows.map((row) => row.name)) : null;
			const baseItems = merged?.items ?? {};
			const config = readLlmConfig();
			writeAdviceSnapshot(advicePath(), {
				generatedAt: new Date().toISOString(),
				model: config ? `${config.model.provider}/${config.model.modelId}` : "",
				items: { ...baseItems, ...items },
			});
			const view = adviceViewOf(readAdviceSnapshot(advicePath()), rows.map((row) => row.name));
			return c.json({ ok: true, ...view });
		});

		app.put("/api/v1/agent/skills/advice", async (c) => {
			const body = (await c.req.json().catch(() => null)) as { actions?: unknown } | null;
			if (!Array.isArray(body?.actions)) {
				return c.json({ error: "bad_request", message: "需要 actions 数组" }, 400);
			}
			const actions: { name: string; enabled: boolean }[] = [];
			for (const raw of body.actions) {
				if (!raw || typeof raw !== "object") continue;
				const { name, enabled } = raw as Record<string, unknown>;
				if (typeof name !== "string" || !SKILL_NAME.test(name) || typeof enabled !== "boolean") continue;
				actions.push({ name, enabled });
			}
			if (!actions.length) {
				return c.json({ error: "bad_request", message: "actions 里没有合法条目" }, 400);
			}
			// 闸门：名字必须来自快照（防"伪造建议直接开技能"）；启停端点再做技能存在性检查
			const illegal = illegalAdviceActions(actions, readAdviceSnapshot(advicePath()));
			if (illegal.length) {
				return c.json(
					{ error: "bad_request", message: `这些名字不在评估快照里：${illegal.join("、")}` },
					400,
				);
			}
			let applied = 0;
			for (const action of actions) {
				const exists = adminSkillNames().includes(action.name);
				if (!exists) continue;
				skillState.setEnabled(action.name, action.enabled);
				applied += 1;
			}
			return c.json({
				ok: true,
				applied,
				note: "索引随下一个会话刷新；已在跑的会话里 skill 工具立即取不到（或恢复）这份手册",
			});
		});
	}

	app.get("/api/v1/agent/skills/:name", (c) => {
		const name = c.req.param("name");
		if (!SKILL_NAME.test(name)) {
			return c.json(
				{ error: "bad_request", message: "技能名只能是小写字母 / 数字 / 短横线 / 下划线，1-64 字符" },
				400,
			);
		}
		const resolved = resolve();
		// 读取链先到先得：第一个"占了这个名字"的来源就是它，格式不对也一样（与加载器一致）
		for (const source of resolved.dirs) {
			const found = findSkillInDir(source.dir, name);
			if (!found) continue;
			// 符号链接指向目录外：与写侧同一口径，一律 400，不读、不端出去
			if (!insideSource(source.dir, found.path)) {
				return c.json({ error: "bad_request", message: "路径越出技能目录" }, 400);
			}
			if (!found.valid) {
				return c.json({ error: "not_found", message: "这个技能格式不对，读不出正文" }, 404);
			}
			try {
				return c.json({
					ok: true,
					name,
					content: readFileSync(found.path, "utf8"),
					origin: source.origin,
					writable: source.writable,
					form: found.form,
				});
			} catch {
				return c.json({ error: "not_found", message: "读不到这个技能" }, 404);
			}
		}
		return c.json({ error: "not_found", message: "没有这个技能" }, 404);
	});

	app.put("/api/v1/agent/skills/:name", async (c) => {
		const name = c.req.param("name");
		const body = (await c.req.json().catch(() => null)) as { content?: unknown } | null;
		if (typeof body?.content !== "string") {
			return c.json({ error: "bad_request", message: "需要 content（技能全文）" }, 400);
		}
		const problem = contentProblem(body.content);
		if (problem) return c.json({ error: "bad_request", message: problem }, 400);

		const resolved = resolve();
		const dir = resolved.dir;
		try {
			mkdirSync(dir, { recursive: true });
		} catch {
			return c.json({ error: "bad_request", message: "技能目录不可写" }, 400);
		}
		const checked = skillPathOf(dir, name);
		if (!checked.ok) return c.json({ error: "bad_request", message: checked.message }, 400);

		// 主目录里还没有这份技能、但只读用户目录里有 → 明确拒绝（不写影子副本）
		if (!existsSync(checked.path)) {
			const readOnly = readOnlyMatchOf(resolved.dirs, name);
			if (readOnly) {
				return c.json(
					{
						error: "bad_request",
						message: `这个技能来自只读用户技能目录（${readOnly.dir}），不能在这里改；要改请在原目录里改`,
					},
					400,
				);
			}
		}

		const created = !existsSync(checked.path);
		try {
			atomicWrite(checked.path, body.content);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			console.error(`[skills] 写 ${name} 失败: ${detail}`);
			return c.json({ error: "internal_error", message: "写入失败，详见服务端日志" }, 500);
		}
		// 只记名字与是否新建：技能正文不进日志
		console.log(`[skills] ${created ? "新建" : "更新"} ${name}`);
		return c.json({ ok: true, name, created });
	});

	app.delete("/api/v1/agent/skills/:name", (c) => {
		const name = c.req.param("name");
		const resolved = resolve();
		const dir = resolved.dir;
		const checked = skillPathOf(dir, name);
		if (!checked.ok) return c.json({ error: "bad_request", message: checked.message }, 400);
		if (!existsSync(checked.path)) {
			const readOnly = readOnlyMatchOf(resolved.dirs, name);
			if (readOnly) {
				return c.json(
					{
						error: "bad_request",
						message: `这个技能来自只读用户技能目录（${readOnly.dir}），不能在这里删；要删请在原目录里删`,
					},
					400,
				);
			}
			return c.json({ error: "not_found", message: "没有这个技能" }, 404);
		}
		try {
			rmSync(checked.path);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			console.error(`[skills] 删 ${name} 失败: ${detail}`);
			return c.json({ error: "internal_error", message: "删除失败，详见服务端日志" }, 500);
		}
		console.log(`[skills] 删除 ${name}`);
		return c.json({ ok: true, name });
	});
}
