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
import { isAbsolute, join, parse, resolve as resolvePath } from "node:path";
import { insideOrEqual, realTargetOf } from "./path-guard.ts";
import { flagEnabled } from "./flags.ts";
import {
	findSkillInDir,
	resolveSkillsDir,
	scanSkillDir,
	type ResolvedSkillsDir,
	type SkillSource,
} from "./skills.ts";
import {
	addCustomSkillDir,
	excludeSkillDir,
	extraSkillDirsEnabled,
	readCustomSkillDirs,
	removeCustomSkillDir,
	skillDirKey,
	SKILL_DIRS_MAX,
} from "./skills-dirs.ts";
import {
	getSkillState,
	skillStateEnabled,
	WORKER_SKILL_OWNER,
	workerSkillScopeEnabled,
} from "./skill-state.ts";
import { isCoreSkill } from "./core-skills.ts";
import { isSkillStale, readSkillUsage, skillUsageEnabled } from "./skill-usage.ts";
import {
	adviceViewOf,
	illegalAdviceActions,
	parseAdviceResponse,
	pruneAdviceSnapshot,
	readAdviceSnapshot,
	renderAdvicePrompt,
	skillAdviceEnabled,
	skillAdvicePath,
	writeAdviceSnapshot,
	type AdviceSkillRow,
} from "./skill-advice.ts";

/**
 * 技能管理端点（2026-11-08 扫尾批 9-S；2026-11-08 批 10-A 改多来源只读展示；
 * 2026-11-23 多位置：自加目录 + 可选写入目标）。
 *
 * 动作都是"人对自己的技能库"的操作：
 *   GET    /api/v1/agent/skills        列表（全部来源；名字 + 摘要 + 大小 + 更新时间 + 来源 + 所在目录）
 *   GET    /api/v1/agent/skills/:name  读一条（.md / SKILL.md 全文；任意来源都可读，可带 ?dir=）
 *   PUT    /api/v1/agent/skills/:name  写一条（默认主目录；带 dir 时写该可写来源，不存在即新建）
 *   DELETE /api/v1/agent/skills/:name  删一条（默认主目录；带 dir 时删该可写来源；删除即停用）
 *   POST   /api/v1/agent/skill-dirs    登记一个自加位置（{path,label?}；不碰磁盘文件）
 *   DELETE /api/v1/agent/skill-dirs    移除一个位置（?path=）：自加位置删登记，
 *                                      `.agents` / 内置目录记进排除名单；磁盘文件都不动
 *
 * 口径照本项目其它管理端点：
 *   - 鉴权失败 403 空体（auth 中间件统一处理，这里不碰）；
 *   - 技能名不合法 / 正文超限 / 路径越界 / 只读来源 → 400 带说明；
 *   - 找不到 → 404 `not_found`；
 *   - `SKILLS_ADMIN=false` → 整组路由不挂（404 = 未启用）；
 *   - `SKILLS_EXTRA_DIRS=false` → 只关自加位置这一层（读取链忽略 + `/skill-dirs` 404）。
 *
 * **写操作锁死在可写来源内**（默认主目录，或显式选中的自加位置）：名字白名单挡穿越，
 * realpath 复核（复用 path-guard 的 `realTargetOf` / `insideOrEqual`）挡"目录内符号链接指向外面"。
 * `~/.agents/skills` 是别的工具的家：**可读、不可写/删**（连影子副本都不落主目录——
 * 那样用户会以为自己改的是那一份）。应用目录的内置手册仍允许在主目录写同名技能覆盖，
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

/** 位置来源的中文说明（错误提示与界面共用一份口径） */
const SKILL_ORIGIN_TEXT: Record<string, string> = {
	env: "AGENT_SKILLS_DIR",
	user: "主目录",
	custom: "自加位置",
	agents: ".agents/skills",
	app: "内置目录",
};

/** 回滚开关：false/0/off = 端点不挂（设置页显示未启用），一行退回"只能手工放文件" */
export function skillsAdminEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return flagEnabled("SKILLS_ADMIN", env);
}

export interface SkillsApiDeps {
	/** 覆盖目录解析（单测/探针指临时目录）；不传 = resolveSkillsDir() */
	resolve?: () => ResolvedSkillsDir;
	/** 覆盖回滚开关（单测）；不传 = skillsAdminEnabled() */
	enabled?: boolean;
	/**
	 * 技能文件 / 位置变动后的回调（2026-11-23）：装配层传 `refreshSkillStore`，
	 * 让运行中的技能库就地重扫。不传 = 老行为（下一个会话仍会重新解析链，但旧 store 不动）。
	 */
	onChange?: () => void;
}

/** 同一个目录（Windows 大小写不敏感） */
function sameDir(a: string, b: string): boolean {
	return skillDirKey(a) === skillDirKey(b);
}

/** 按路径找读取链里的来源；`writableOnly` 时只认可写来源（主目录 / 自加位置）。 */
function sourceForDir(
	resolved: ResolvedSkillsDir,
	dir: string,
	writableOnly: boolean,
): SkillSource | null {
	for (const source of resolved.dirs) {
		if (!sameDir(source.dir, dir)) continue;
		if (writableOnly && !source.writable) return null;
		return source;
	}
	return null;
}

/** 写 / 删的目标目录：不带 dir = 主目录（旧行为）；带 dir = 必须是可写来源。 */
function targetDirOf(
	resolved: ResolvedSkillsDir,
	requested: string,
): { ok: true; dir: string } | { ok: false; message: string } {
	const dir = requested.trim();
	if (!dir) return { ok: true, dir: resolved.dir };
	const source = sourceForDir(resolved, dir, true);
	if (!source) {
		return {
			ok: false,
			message: "这个位置不能写：只有主目录和自加位置能新建 / 改 / 删技能",
		};
	}
	return { ok: true, dir: source.dir };
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
	const notifyChange = () => deps.onChange?.();

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
					enabled: !skillStateEnabled() || skillState.isEnabled(entry.name),
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
		// 2026-11-15 个人技能可见性：带 partnerId 时逐项追加"该人是否可用"。
		// 不带时形状不变（旧客户端/全局设置页原样）。
		const partnerId = c.req.query("partnerId")?.trim() || null;
		// SKILL_STATE=false 是"全进索引、不过滤"的逃生门；此时管理面也要显示全员可用，
		// 否则界面会把实际可见的技能说成关着。
		const stateOn = skillStateEnabled();
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
			/** 2026-11-23 多位置：这条技能实际来自哪个目录（前端按它分位置 / 带回写目标） */
			dir: string;
			writable: boolean;
			form: "flat" | "dir";
			/** 2026-11-16 工具裁剪 A：代码内置技能，始终可用、没有启停位。 */
			core: boolean;
			enabled: boolean;
			/** 2026-11-15：带 partnerId 时才出现；该人实际可用（全局开 || 按人覆盖开）。 */
			partnerEnabled?: boolean;
			/** 2026-11-15：全局没开、但该人单独开。 */
			partnerOverride?: boolean;
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
					// core 只认代码名单（isCoreSkill），不认技能文件 frontmatter 自封。
					const core = isCoreSkill(entry.name);
					items.push({
						name: entry.name,
						summary: entry.summary,
						size: stat.size,
						updatedAt: stat.mtime.toISOString(),
						origin: source.origin,
						writable: source.writable,
						form: entry.form,
						core,
						dir: source.dir,
						// 启停位（2026-11-09）：默认全关，界面上逐条/批量开。
						// core 没有启停位，一律给 true（即使启停位里没有 / 全关）。
						enabled: core || (stateOn ? skillState.isEnabled(entry.name) : true),
						...(partnerId
							? {
									partnerEnabled: core
										? true
										: stateOn
											? skillState.isEnabledFor(partnerId, entry.name)
											: true,
									partnerOverride: core
										? false
										: stateOn
											? skillState.isOverridden(partnerId, entry.name)
											: false,
								}
							: {}),
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
			// 多位置能力是否开着（2026-11-23）：关着时界面不画「添加位置」入口
			extraDirs: extraSkillDirsEnabled(),
			dirs: resolved.dirs.map((source) => ({
				dir: source.dir,
				origin: source.origin,
				writable: source.writable,
				exists: source.exists,
				removable: source.removable === true,
				...(source.label ? { label: source.label } : {}),
			})),
			items,
		});
	});

	/* ── 自加技能库位置（2026-11-23；2026-11-24 扩到内置来源）────────
	 * 只登记目录：绝对路径、必须已存在且是目录、不与现有来源重复、最多 SKILL_DIRS_MAX 个。
	 * 不替用户建目录（打错一个字母不该在磁盘上生成空目录）；不删磁盘文件。
	 * DELETE 的范围：自加位置 = 删登记；`.agents` / 内置目录 = 记进排除名单（读取链跳过）；
	 * 主目录（新建技能的落点）不可移除。重新添加同一路径即恢复。
	 * `SKILLS_EXTRA_DIRS=false/0/off` → 这两个端点 404（读取链也忽略自加位置与排除名单）。 */
	app.post("/api/v1/agent/skill-dirs", async (c) => {
		if (!extraSkillDirsEnabled()) {
			return c.json({ error: "not_found", message: "多位置未启用（SKILLS_EXTRA_DIRS=false）" }, 404);
		}
		const body = (await c.req.json().catch(() => null)) as { path?: unknown; label?: unknown } | null;
		const raw = typeof body?.path === "string" ? body.path.trim() : "";
		if (!raw) return c.json({ error: "bad_request", message: "需要 path（目录绝对路径）" }, 400);
		if (!isAbsolute(raw)) {
			return c.json({ error: "bad_request", message: "填绝对路径（例如 D:\\skills）" }, 400);
		}
		const absolute = resolvePath(raw);
		if (absolute === parse(absolute).root) {
			return c.json({ error: "bad_request", message: "不能把盘符根目录加成技能库位置" }, 400);
		}
		let isDir = false;
		try {
			isDir = statSync(absolute).isDirectory();
		} catch {
			/* 不存在 */
		}
		if (!isDir) {
			return c.json(
				{ error: "bad_request", message: `这个目录不存在（先在资源管理器里建好）：${absolute}` },
				400,
			);
		}
		if (body?.label !== undefined && typeof body.label !== "string") {
			return c.json({ error: "bad_request", message: "label 必须是字符串" }, 400);
		}
		const label = typeof body?.label === "string" ? body.label.trim().slice(0, 40) : "";
		const resolved = resolve();
		const dup = resolved.dirs.find((source) => sameDir(source.dir, absolute));
		if (dup) {
			return c.json(
				{ error: "bad_request", message: `这个目录已经在技能库里了（${SKILL_ORIGIN_TEXT[dup.origin] ?? dup.origin}）` },
				400,
			);
		}
		const current = readCustomSkillDirs();
		if (current.length >= SKILL_DIRS_MAX) {
			return c.json(
				{ error: "bad_request", message: `最多加 ${SKILL_DIRS_MAX} 个位置，先移除不用的` },
				400,
			);
		}
		try {
			addCustomSkillDir(absolute, label);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			console.error(`[skills] 登记位置失败: ${detail}`);
			return c.json({ error: "internal_error", message: "写入失败，详见服务端日志" }, 500);
		}
		notifyChange();
		console.log(`[skills] 新增位置 ${absolute}`);
		return c.json({ ok: true, path: absolute, ...(label ? { label } : {}) });
	});

	app.delete("/api/v1/agent/skill-dirs", (c) => {
		if (!extraSkillDirsEnabled()) {
			return c.json({ error: "not_found", message: "多位置未启用（SKILLS_EXTRA_DIRS=false）" }, 404);
		}
		const raw = c.req.query("path")?.trim() ?? "";
		if (!raw) return c.json({ error: "bad_request", message: "需要 ?path=目录路径" }, 400);
		if (!isAbsolute(raw)) {
			return c.json({ error: "bad_request", message: "只能移除登记表里的绝对路径" }, 400);
		}
		const absolute = resolvePath(raw);
		const resolved = resolve();
		const source = resolved.dirs.find((entry) => sameDir(entry.dir, absolute));
		if (!source) {
			return c.json(
				{ error: "not_found", message: "这个位置不在技能库里（已经移除，或不属于当前读取链）" },
				404,
			);
		}
		// 主目录 = 新建技能的落点：不在这一页提供移除（2026-11-24 用户拍板）
		if (sameDir(source.dir, resolved.dir)) {
			return c.json({ error: "bad_request", message: "主目录不能移除：新建技能默认写在这里" }, 400);
		}
		const kind = source.origin;
		let removed = false;
		try {
			// 自加位置删登记；`.agents` / 内置目录记排除名单
			removed = kind === "custom" ? removeCustomSkillDir(absolute) : excludeSkillDir(absolute);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			console.error(`[skills] 移除位置失败: ${detail}`);
			return c.json({ error: "internal_error", message: "写入失败，详见服务端日志" }, 500);
		}
		if (!removed) {
			return c.json({ error: "not_found", message: "这个位置不在技能库里（已经移除过了）" }, 404);
		}
		notifyChange();
		console.log(`[skills] 移除位置 ${absolute}（${kind === "custom" ? "删登记" : "不再读取"}）`);
		return c.json({
			ok: true,
			path: absolute,
			removed: kind === "custom" ? "unregistered" : "excluded",
			note:
				kind === "custom"
					? "只删了登记，磁盘上的目录和文件没动"
					: "以后不再从这个目录读取技能；磁盘上的目录和文件没动",
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
		// 内置技能没有启停位：始终可用，不给关（2026-11-16 工具裁剪 A）。
		if (isCoreSkill(name)) {
			return c.json(
				{ error: "bad_request", message: "系统内置技能，始终可用，不能关闭" },
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

	/**
	 * 普通助手的技能可见性（2026-11-21）：与执事个人页同语义，归属键固定 `worker`。
	 * - 全局已开 / core → 409 锁死（所有人都有，不能按人关）；
	 * - 只写 `.data/skills-state.json` 的 `partners.worker` 覆盖层，不改技能文件；
	 * - 技能不存在 → 404（防状态里堆无效名字）。
	 * 读侧复用 `GET /api/v1/agent/skills?partnerId=worker`（同一套 partnerEnabled/partnerOverride）。
	 */
	app.put("/api/v1/agent/worker-skills/:name/enabled", async (c) => {
		const name = c.req.param("name");
		if (!SKILL_NAME.test(name)) {
			return c.json({ error: "bad_request", message: "技能名不合法" }, 400);
		}
		const body = (await c.req.json().catch(() => null)) as { enabled?: unknown } | null;
		if (typeof body?.enabled !== "boolean") {
			return c.json({ error: "bad_request", message: "enabled 必须是布尔" }, 400);
		}
		if (!skillStateEnabled()) {
			return c.json(
				{ error: "locked", message: "技能过滤已关闭，所有人都有；不能再按人开关" },
				409,
			);
		}
		if (!workerSkillScopeEnabled()) {
			return c.json(
				{
					error: "locked",
					message: "普通助手技能独立选择已关闭（WORKER_SKILL_SCOPE=false）",
				},
				409,
			);
		}
		const state = getSkillState();
		if (isCoreSkill(name)) {
			return c.json(
				{ error: "locked", message: "系统内置技能，始终可用，不能按人开关" },
				409,
			);
		}
		if (state.isEnabled(name)) {
			return c.json(
				{ error: "locked", message: "全局已开启，所有人都有；普通助手不能单独关" },
				409,
			);
		}
		let exists = false;
		for (const source of resolve().dirs) {
			const found = findSkillInDir(source.dir, name);
			if (found?.valid) {
				exists = true;
				break;
			}
		}
		if (!exists) return c.json({ error: "not_found", message: `没有叫「${name}」的技能` }, 404);
		state.setEnabledFor(WORKER_SKILL_OWNER, name, body.enabled);
		c.header("cache-control", "no-store");
		return c.json({
			ok: true,
			owner: WORKER_SKILL_OWNER,
			name,
			enabled: body.enabled,
			note: "索引随下一个普通助手会话刷新；已在跑的会话里 skill 工具立即取不到（或恢复）这份手册",
		});
	});

	/** 批量启停（2026-11-09 用户口径：默认全关，界面上能一键全开/全关） */
	app.put("/api/v1/agent/skills/enabled-all", async (c) => {		const body = (await c.req.json().catch(() => null)) as { enabled?: unknown } | null;
		if (typeof body?.enabled !== "boolean") {
			return c.json({ error: "bad_request", message: "enabled 必须是布尔" }, 400);
		}
		const names: string[] = [];
		const claimed = new Set<string>();
		for (const source of resolve().dirs) {
			for (const entry of scanSkillDir(source.dir)) {
				if (claimed.has(entry.name)) continue;
				claimed.add(entry.name);
				// 与列表同一条管理面规则：白名单外的名字不进管理面，也不被它批量开关。
				// core 不参与全开/全关统计与写入（否则界面显示"已全关"但内置技能还在）。
				if (isCoreSkill(entry.name)) continue;
				if (entry.valid && SKILL_NAME.test(entry.name)) names.push(entry.name);
			}
		}
		skillState.setAll(body.enabled, names);
		return c.json({ ok: true, count: names.length, enabled: body.enabled, note: "索引随下一个会话刷新" });
	});

	/* ── 技能分类建议（2026-11-10 批 30；`SKILL_ADVICE=false` 回滚 = 路由不挂）──
	 * 评估在**总管对话里**做（v1 的后端候选链盲扫被用户否了：不知道会撞上哪个模型，
	 * 万一能力低但计费高就亏了）——这里只出"预填提示词"（GET 带 prompt）和收
	 * "总管评估完的 JSON"（POST 导入快照）。采纳仍是 PUT（名字必须来自快照）。
	 * ego-browser 这类符号链接技能不在管理列表（insideSource 闸），天然不进评估范围。 */
	if (adviceOn) {
		app.get("/api/v1/agent/skills/advice", (c) => {
			const rows = adminSkillRows();
			const view = adviceViewOf(readAdviceSnapshot(advicePath()), rows.map((row) => row.name));
			// 无快照 / 快照过期时给预填提示词：前端拿它跳总管对话并预填（用户点发送才开跑）
			const prompt = rows.length ? renderAdvicePrompt(rows) : null;
			return c.json({ ok: true, ...view, prompt });
		});

		app.post("/api/v1/agent/skills/advice", async (c) => {
			const body = (await c.req.json().catch(() => null)) as
				| { items?: unknown; model?: unknown }
				| null;
			if (!body || typeof body !== "object" || Array.isArray(body.items)) {
				return c.json({ error: "bad_request", message: "需要 items 对象（save_skill_advice 的同款输出）" }, 400);
			}
			// 与工具同一条清洗口径：非法条目丢、一条合法都没有 = 整份不可信
			const items = parseAdviceResponse(JSON.stringify({ items: body.items }));
			if (items === null) {
				return c.json({ error: "bad_request", message: "items 里没有一条合法建议（bucket/frequency 不合口径）" }, 400);
			}
			const rows = adminSkillRows();
			if (!rows.length) {
				return c.json({ error: "bad_request", message: "技能库是空的，没有可评估的对象" }, 400);
			}
			// 先修旧快照（清掉已消失技能）再合并本次结果，一次性原子替换
			const previous = readAdviceSnapshot(advicePath());
			const merged = previous ? pruneAdviceSnapshot(previous, rows.map((row) => row.name)) : null;
			writeAdviceSnapshot(advicePath(), {
				generatedAt: new Date().toISOString(),
				model: typeof body.model === "string" ? body.model : (merged?.model ?? ""),
				items: { ...(merged?.items ?? {}), ...items },
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
				// core 始终可用：即使快照里出现内置技能，也不写它的启停位（双保险）。
				if (isCoreSkill(action.name)) continue;
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
		// 指定位置（2026-11-23）：只在这个来源里找，找不到就 404（不回落别的来源，
		// 否则「改的是哪个文件」又变成猜的）。不带 = 读取链先到先得。
		const requested = c.req.query("dir")?.trim() ?? "";
		let sources = resolved.dirs;
		if (requested) {
			const source = sourceForDir(resolved, requested, false);
			if (!source) {
				return c.json({ error: "bad_request", message: "这个目录不在技能库里" }, 400);
			}
			sources = [source];
		}
		for (const source of sources) {
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
					dir: source.dir,
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
		const body = (await c.req.json().catch(() => null)) as { content?: unknown; dir?: unknown } | null;
		if (typeof body?.content !== "string") {
			return c.json({ error: "bad_request", message: "需要 content（技能全文）" }, 400);
		}
		const problem = contentProblem(body.content);
		if (problem) return c.json({ error: "bad_request", message: problem }, 400);
		if (body?.dir !== undefined && typeof body.dir !== "string") {
			return c.json({ error: "bad_request", message: "dir 必须是字符串" }, 400);
		}

		const resolved = resolve();
		const target = targetDirOf(resolved, typeof body?.dir === "string" ? body.dir : "");
		if (!target.ok) return c.json({ error: "bad_request", message: target.message }, 400);
		const dir = target.dir;
		try {
			mkdirSync(dir, { recursive: true });
		} catch {
			return c.json({ error: "bad_request", message: "技能目录不可写" }, 400);
		}
		const checked = skillPathOf(dir, name);
		if (!checked.ok) return c.json({ error: "bad_request", message: checked.message }, 400);

		// 默认写主目录时：主目录里还没有这份技能、但只读用户目录里有 → 明确拒绝（不写影子副本）。
		// 显式选了自加位置就照写——那个位置本来就是"我要多放一份"的意图。
		if (!existsSync(checked.path) && sameDir(dir, resolved.dir)) {
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
		console.log(`[skills] ${created ? "新建" : "更新"} ${name}（${dir}）`);
		notifyChange();
		return c.json({ ok: true, name, created, dir });
	});

	app.delete("/api/v1/agent/skills/:name", (c) => {
		const name = c.req.param("name");
		const resolved = resolve();
		const target = targetDirOf(resolved, c.req.query("dir")?.trim() ?? "");
		if (!target.ok) return c.json({ error: "bad_request", message: target.message }, 400);
		const dir = target.dir;
		const checked = skillPathOf(dir, name);
		if (!checked.ok) return c.json({ error: "bad_request", message: checked.message }, 400);
		if (!existsSync(checked.path)) {
			// 默认主目录没这份时，再明确告诉你它来自只读目录（选了自加位置就只认那个位置）
			if (sameDir(dir, resolved.dir)) {
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
			}
			return c.json({ error: "not_found", message: "这个位置里没有这个技能" }, 404);
		}
		try {
			rmSync(checked.path);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			console.error(`[skills] 删 ${name} 失败: ${detail}`);
			return c.json({ error: "internal_error", message: "删除失败，详见服务端日志" }, 500);
		}
		console.log(`[skills] 删除 ${name}（${dir}）`);
		notifyChange();
		return c.json({ ok: true, name, dir });
	});
}
