import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 技能库（2026-10-31，App 方案《Agent 化与上下文分层》步骤 2，D4/D5）。
 *
 * 技能 = 一份**流程类手册**（怎么引导一场会议回顾、怎么引导一次回忆），不是事实、不是人格。
 * 存放：技能目录下的 `*.md` 文件，文件名 = 技能名。目录解析见 `resolveSkillsDir()`（2026-11-08 扫尾批 9-S：
 * `AGENT_SKILLS_DIR` 显式 → 用户目录 → 应用目录兜底；用户目录可增删，应用目录是内置手册）。
 * 文件格式刻意简单：**第 1 行 = 索引里的一行摘要，其余 = 完整手册**。
 *
 * 与缓存的关系（方案 §2.1 不变量：所有 system 在首轮 user 前写齐，此后冻结）：
 * - 索引走 L1（extension 的 `skills` section），durable 对 section 是"最小补丁"语义——
 *   渲染值不变就不追加新 `pi.system`；
 * - 所以索引**按会话冻结**：每个会话第一次渲染时记下当时的索引，之后技能目录再变也不改写，
 *   本会话不会中途追加 system（那会整段作废已命中的缓存前缀）；
 * - "技能增删只影响下一个会话"是刻意取舍（方案 D5 / §4.4）。
 * - 技能**正文**不进 system：模型判断需要时调 `skill(name)` 工具取，走 L2（每轮追加）。
 */

export interface SkillStore {
	/** 全部技能名（`skill` 工具的兜底提示用） */
	names(): string[];
	/** 完整手册正文；名字不存在返回 undefined */
	manual(name: string): string | undefined;
	/**
	 * 本会话的技能索引。首轮渲染后按会话冻结；
	 * 没有任何技能时返回 undefined（section 整个省略，别渲染一个空标题）。
	 */
	indexFor(conversationId: number): string | undefined;
}

/**
 * 应用自带的技能目录（`apps/server/skills/`，两条内置手册）。
 *
 * 落点跟着代码走：源码 `src/skills.ts` → `../skills`；dist 里 `dist/src/skills.js` →
 * `dist/skills`（build.mjs 会把 skills/ 抄过去），与 `agent/assist.ts` 的老口径同址。
 */
export const APP_SKILLS_DIR = fileURLToPath(new URL("../skills", import.meta.url));

export type SkillsDirOrigin = "env" | "user" | "app";

export interface ResolvedSkillsDir {
	/** 技能目录（管理端点只读写这里） */
	dir: string;
	/** env = AGENT_SKILLS_DIR 显式；user = 用户目录；app = 应用目录兜底 */
	origin: SkillsDirOrigin;
}

export interface ResolveSkillsDirOptions {
	env?: NodeJS.ProcessEnv;
	/** 覆盖用户主目录（单测/探针用）；不传 = env 的 USERPROFILE/HOME → os.homedir() */
	home?: string;
	/** 覆盖应用目录（单测用）；不传 = APP_SKILLS_DIR */
	appDir?: string;
}

function userHomeOf(env: NodeJS.ProcessEnv): string {
	return env.USERPROFILE?.trim() || env.HOME?.trim() || homedir();
}

/**
 * 技能目录解析（2026-11-08 扫尾批 9-S，上位计划 §三.1）。
 *
 * 优先级：
 *   1. `AGENT_SKILLS_DIR` 显式指定（部署自选目录，不替用户建）；
 *   2. 用户目录 `%USERPROFILE%\.lifediary\skills`——**不存在则首次访问自动 mkdir**，
 *      这样设置页打开就能立刻增删，不用先手工建目录；
 *   3. 应用目录 `apps/server/skills/` 兜底（内置手册；只有用户目录建不出来时才落到这里）。
 *
 * 注意这只是"**可写的那一个**目录"。技能库（`createSkillStore`）要保留两条内置手册可见时，
 * 调用方在 origin=user 的情况下应传 `[resolved.dir, APP_SKILLS_DIR]`：先到先得，
 * 用户目录的同名技能覆盖内置手册。origin=app 时单目录即可。
 */
export function resolveSkillsDir(options: ResolveSkillsDirOptions = {}): ResolvedSkillsDir {
	const env = options.env ?? process.env;
	const explicit = env.AGENT_SKILLS_DIR?.trim();
	if (explicit) return { dir: explicit, origin: "env" };

	const home = options.home?.trim() || userHomeOf(env);
	const userDir = join(home, ".lifediary", "skills");
	try {
		mkdirSync(userDir, { recursive: true });
		return { dir: userDir, origin: "user" };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[skills] 用户技能目录不可用（${detail}），回落应用目录`);
	}
	return { dir: options.appDir ?? APP_SKILLS_DIR, origin: "app" };
}

/**
 * dir 可为单目录，或**按优先级从高到低排列的目录数组**（批次D D1 的总管技能合并）。
 * 数组形态：先到的目录拥有同名技能（同名时总管技能覆盖全局 skills/ 兜底）；
 * 每个名字只认第一个出现它的目录，含格式不对的文件也占位，防全局兜底顶掉总管占位。
 * 单目录形态行为与改动前完全一致。
 */
export function createSkillStore(dirOrDirs: string | string[]): SkillStore | null {
	const dirs = Array.isArray(dirOrDirs) ? dirOrDirs : [dirOrDirs];

	const skills = new Map<string, { summary: string; manual: string }>();
	const claimed = new Set<string>();
	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		for (const file of readdirSync(dir).sort()) {
			if (!file.endsWith(".md")) continue;
			const name = file.slice(0, -3);
			if (claimed.has(name)) continue; // 先到的目录优先
			claimed.add(name);
			const raw = readFileSync(join(dir, file), "utf8").trim();
			const [first, ...rest] = raw.split("\n");
			const summary = (first ?? "").trim();
			const manual = rest.join("\n").trim();
			// 格式不对的文件宁可不上索引：渲染半份手册比没有手册更糟
			if (!summary || !manual) {
				console.warn(`[skills] 跳过格式不对的技能文件（第 1 行应是摘要）：${file}`);
				continue;
			}
			skills.set(name, { summary, manual });
		}
	}
	if (skills.size === 0) return null;

	const frozen = new Map<number, string>();
	const renderIndex = (): string => {
		const lines = [...skills.entries()].map(([name, skill]) => `- ${name}：${skill.summary}`);
		return (
			"可用技能（对方的事需要按某个流程引导时，先调 skill(name) 取完整手册再开始）：\n" +
			lines.join("\n")
		);
	};

	console.log(`[skills] 已加载 ${skills.size} 条技能：${[...skills.keys()].join("、")}`);
	return {
		names: () => [...skills.keys()],
		manual: (name) => skills.get(name)?.manual,
		indexFor(conversationId) {
			let index = frozen.get(conversationId);
			if (index === undefined) {
				index = renderIndex();
				frozen.set(conversationId, index);
			}
			return index;
		},
	};
}
