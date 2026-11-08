import type { Hono } from "hono";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { insideOrEqual, realTargetOf } from "./path-guard.ts";
import { resolveSkillsDir, type ResolvedSkillsDir } from "./skills.ts";

/**
 * 技能管理端点（2026-11-08 扫尾批 9-S，上位计划 §三.2）。
 *
 * 动作都是"人对自己的技能库"的操作：
 *   GET    /api/v1/agent/skills        列表（名字 + 首行摘要 + 大小 + 更新时间）
 *   GET    /api/v1/agent/skills/:name  读一条（.md 全文）
 *   PUT    /api/v1/agent/skills/:name  写一条（不存在即新建；body `{content}`）
 *   DELETE /api/v1/agent/skills/:name  删一条（删除即停用，没有启停位）
 *
 * 口径照本项目其它管理端点：
 *   - 鉴权失败 403 空体（auth 中间件统一处理，这里不碰）；
 *   - 技能名不合法 / 正文超限 / 路径越界 → 400 带说明；
 *   - 找不到 → 404 `not_found`；
 *   - `SKILLS_ADMIN=false` → 整组路由不挂（404 = 未启用）。
 *
 * **写操作锁死在 `resolveSkillsDir()` 解析出的目录内**：名字白名单挡穿越，realpath 复核
 * （复用 path-guard 的 `realTargetOf` / `insideOrEqual`）挡"目录内符号链接指向外面"。
 *
 * 为什么不做启停位：技能是目录里的文件，删除即停；多一个"禁用"状态就多一份与磁盘不一致的状态。
 * 增删只影响下一个会话（D5 的既有取舍），界面文案如实说明。
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

export function mountSkills(app: Hono, deps: SkillsApiDeps = {}): void {
	const resolve = deps.resolve ?? (() => resolveSkillsDir());
	if (!(deps.enabled ?? skillsAdminEnabled())) return;

	app.get("/api/v1/agent/skills", (c) => {
		const { dir, origin } = resolve();
		const items: { name: string; summary: string; size: number; updatedAt: string }[] = [];
		if (existsSync(dir)) {
			for (const file of readdirSync(dir).sort()) {
				if (!file.endsWith(".md")) continue;
				const name = file.slice(0, -3);
				const checked = skillPathOf(dir, name);
				// 白名单外的文件名（如中文名）继续给模型用，但不进管理面：
				// 管理端点只能按白名单读写，列出来也点不开。
				if (!checked.ok) continue;
				try {
					const stat = statSync(checked.path);
					if (!stat.isFile()) continue;
					const raw = readFileSync(checked.path, "utf8").trim();
					const summary = (raw.split(/\r?\n/)[0] ?? "").trim();
					items.push({ name, summary, size: stat.size, updatedAt: stat.mtime.toISOString() });
				} catch {
					// 单个文件读不了不该让整页列表 500
				}
			}
		}
		return c.json({ ok: true, dir, origin, items });
	});

	app.get("/api/v1/agent/skills/:name", (c) => {
		const { dir } = resolve();
		const checked = skillPathOf(dir, c.req.param("name"));
		if (!checked.ok) return c.json({ error: "bad_request", message: checked.message }, 400);
		if (!existsSync(checked.path)) {
			return c.json({ error: "not_found", message: "没有这个技能" }, 404);
		}
		try {
			return c.json({
				ok: true,
				name: c.req.param("name"),
				content: readFileSync(checked.path, "utf8"),
			});
		} catch {
			return c.json({ error: "not_found", message: "读不到这个技能" }, 404);
		}
	});

	app.put("/api/v1/agent/skills/:name", async (c) => {
		const name = c.req.param("name");
		const body = (await c.req.json().catch(() => null)) as { content?: unknown } | null;
		if (typeof body?.content !== "string") {
			return c.json({ error: "bad_request", message: "需要 content（技能全文）" }, 400);
		}
		const problem = contentProblem(body.content);
		if (problem) return c.json({ error: "bad_request", message: problem }, 400);

		const { dir } = resolve();
		try {
			mkdirSync(dir, { recursive: true });
		} catch {
			return c.json({ error: "bad_request", message: "技能目录不可写" }, 400);
		}
		const checked = skillPathOf(dir, name);
		if (!checked.ok) return c.json({ error: "bad_request", message: checked.message }, 400);

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
		const { dir } = resolve();
		const checked = skillPathOf(dir, name);
		if (!checked.ok) return c.json({ error: "bad_request", message: checked.message }, 400);
		if (!existsSync(checked.path)) {
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
