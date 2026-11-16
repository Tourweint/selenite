import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { flagEnabled } from "./flags.ts";

/**
 * 技能库（2026-10-31，App 方案《Agent 化与上下文分层》步骤 2，D4/D5）。
 *
 * 技能 = 一份**流程类手册**（怎么引导一场会议回顾、怎么引导一次回忆），不是事实、不是人格。
 * 存放（2026-11-08 批 10-A 起为**多目录合并链**，先到先得）：
 *   1. `AGENT_SKILLS_DIR` 显式（部署自选；管理端点也写这里）；
 *   2. 用户目录 `%USERPROFILE%\.lifediary\skills`（管理界面写这里，首访自动 mkdir）；
 *   3. 标准用户技能目录 `%USERPROFILE%\.agents\skills`（跨工具共享，**只读**）；
 *   4. 应用目录 `apps/server/skills/`（内置手册兜底）。
 *
 * 两种文件形态都认：
 *   - 扁平 `<名>.md`：第 1 行 = 索引摘要，其余 = 完整手册（本仓库原生形态）；
 *   - 目录 `<名>/SKILL.md`：标准 agent skill 形态，摘要 = frontmatter 的 `description`，
 *     正文 = frontmatter 之后的内容，其余 frontmatter 字段忽略。
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
	/**
	 * 全部技能名（`skill` 工具的兜底提示用）。
	 * partnerId 给了就按该人过滤（全局开 || 该人覆盖开）；不给 = 只看全局。
	 */
	names(partnerId?: string | null): string[];
	/** 完整手册正文；名字不存在 / 对该人不可见返回 undefined */
	manual(name: string, partnerId?: string | null): string | undefined;
	/**
	 * 本会话的技能索引。首轮渲染后按「会话 + 执事」冻结；
	 * 没有任何技能时返回 undefined（section 整个省略，别渲染一个空标题）。
	 */
	indexFor(conversationId: number, partnerId?: string | null): string | undefined;
	/**
	 * 预览用：按当前目录 + 该人可见性渲染，不写 `frozen`、不依赖会话。
	 * 设置页“默认开销”拿它看“新会话的第一轮会读到什么”。
	 * 旧测试里的最小 SkillStore 可以不带这个方法；生产 store 一定有。
	 */
	previewIndex?(partnerId?: string | null): string | undefined;
}

/**
 * 应用自带的技能目录（`apps/server/skills/`，两条内置手册）。
 *
 * 落点跟着代码走：源码 `src/skills.ts` → `../skills`；dist 里 `dist/src/skills.js` →
 * `dist/skills`（build.mjs 会把 skills/ 抄过去），与 `agent/assist.ts` 的老口径同址。
 */
export const APP_SKILLS_DIR = fileURLToPath(new URL("../skills", import.meta.url));

export type SkillsDirOrigin = "env" | "user" | "agents" | "app";

export interface SkillSource {
	/** 目录绝对（或部署给的）路径 */
	dir: string;
	/** env = AGENT_SKILLS_DIR 显式；user = 用户目录；agents = `~/.agents/skills`；app = 应用目录兜底 */
	origin: SkillsDirOrigin;
	/**
	 * 管理端点能否在这个目录里写/删。
	 * 只有主目录为 true；`~/.agents/skills` 是别的工具的家，只读；应用目录是内置手册，只读。
	 */
	writable: boolean;
	/** 目录当前是否存在（不存在时加载器跳过，管理列表也如实标出来） */
	exists: boolean;
}

export interface ResolvedSkillsDir {
	/** 主目录（管理端点写目标）；读取链里的第一个 */
	dir: string;
	/** 主目录来源（`agents` 永远不会是主目录） */
	origin: Exclude<SkillsDirOrigin, "agents">;
	/** 完整读取链，按优先级从高到低排列 */
	dirs: SkillSource[];
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

/** 路径去重键：Windows 大小写不敏感，同一个目录写两种大小写不该算两个来源。 */
function pathKey(dir: string): string {
	const absolute = resolvePath(dir);
	return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

/**
 * 技能读取链解析（2026-11-08 批 10-A，上位计划 §一；取代 9-S 的单目录版本）。
 *
 * 优先级（**先到先得**，同名技能只有第一个来源生效）：
 *   1. `AGENT_SKILLS_DIR` 显式指定（部署自选目录，不替用户建）——显式时它取代主目录槽位，
 *      不再额外创建 `.lifediary\skills`；
 *   2. 用户目录 `%USERPROFILE%\.lifediary\skills`——**不存在则首次访问自动 mkdir**，
 *      这样设置页打开就能立刻增删，不用先手工建目录；
 *   3. 标准用户技能目录 `%USERPROFILE%\.agents\skills`（跨工具共享，只读；不存在就跳过）；
 *   4. 应用目录 `apps/server/skills/` 兜底（内置手册）。
 *
 * 主目录 = 管理端点（GET/PUT/DELETE）的写目标：有显式 env 就是 env 目录，否则用户目录，
 * 用户目录建不出来才回落应用目录（沿用 9-S 的兜底）。`dirs` 是**读取链**：主目录永远第一，
 * 后面跟着 .agents 与应用目录（同一路径只留一次）。
 */
export function resolveSkillsDir(options: ResolveSkillsDirOptions = {}): ResolvedSkillsDir {
	const env = options.env ?? process.env;
	const appDir = options.appDir ?? APP_SKILLS_DIR;
	const home = options.home?.trim() || userHomeOf(env);
	const agentsDir = join(home, ".agents", "skills");

	const explicit = env.AGENT_SKILLS_DIR?.trim();
	let main: { dir: string; origin: Exclude<SkillsDirOrigin, "agents"> };
	if (explicit) {
		main = { dir: explicit, origin: "env" };
	} else {
		const userDir = join(home, ".lifediary", "skills");
		try {
			mkdirSync(userDir, { recursive: true });
			main = { dir: userDir, origin: "user" };
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			console.warn(`[skills] 用户技能目录不可用（${detail}），回落应用目录`);
			main = { dir: appDir, origin: "app" };
		}
	}

	const dirs: SkillSource[] = [];
	const seen = new Set<string>();
	const push = (dir: string, origin: SkillsDirOrigin, writable: boolean) => {
		const key = pathKey(dir);
		if (seen.has(key)) return;
		seen.add(key);
		dirs.push({ dir, origin, writable, exists: existsSync(dir) });
	};
	push(main.dir, main.origin, true);
	push(agentsDir, "agents", false);
	push(appDir, "app", false);

	return { dir: main.dir, origin: main.origin, dirs };
}

/**
 * 一个目录里扫出来的技能（含格式不对的条目）。
 *
 * `valid=false` 的条目**仍然占名**：合并链靠它挡住低优先级目录里的同名技能——
 * 否则一份坏掉的总管技能会被全局同名手册顶掉，行为和"没有这份技能"完全不一样。
 */
export interface ScannedSkill {
	name: string;
	/** flat = `<名>.md`；dir = `<名>/SKILL.md` */
	form: "flat" | "dir";
	/** 实际读取的文件路径（列表要 stat 它） */
	path: string;
	summary: string;
	manual: string;
	valid: boolean;
}

/**
 * 块标量取值（2026-11-11）：从 `start` 行起收集到缩进回退（返回那一行，主循环把它当 key
 * 继续解析）或 frontmatter 结束。块缩进 = 第一条非空行的缩进；空行属于块。
 * `>` 折叠式：非空行之间折成空格、空行算段落换行；`|` 字面式：保留换行；
 * `-` 变体不补尾换行（clip/strip 之差）。比真 YAML 简化：锚点 / 别名 / 更深缩进的
 * 字面保留都不认——description 用不到，别在这里长出半成品 YAML。
 */
function blockScalarOf(
	lines: string[],
	start: number,
	end: number,
	folded: boolean,
	strip: boolean,
): { value: string; next: number } {
	let indent = -1;
	const collected: string[] = [];
	let next = end;
	for (let index = start; index < end; index += 1) {
		const line = lines[index] ?? "";
		if (!line.trim()) {
			collected.push("");
			continue;
		}
		const currentIndent = line.length - line.trimStart().length;
		if (indent === -1) indent = currentIndent;
		if (currentIndent < indent) {
			next = index;
			break;
		}
		collected.push(line.slice(indent));
	}
	while (collected.length && !collected[0]!.trim()) collected.shift();
	while (collected.length && !collected[collected.length - 1]!.trim()) collected.pop();
	if (!collected.length) return { value: "", next };
	if (!folded) return { value: collected.join("\n") + (strip ? "" : "\n"), next };
	let value = "";
	for (const text of collected) {
		if (!text.trim()) value += "\n";
		else if (!value || value.endsWith("\n")) value += text;
		else value += ` ${text}`;
	}
	return { value, next };
}

/**
 * frontmatter 的最小解析（2026-10-31 最小实现；2026-11-11 补多行块标量）：
 * 只认第一段 `---` 包起来的单行 `key: value`，外加 `key: >` / `>-` / `|` / `|-`
 * 块标量（后续行按缩进归属，见 blockScalarOf）——官方 SKILL.md 的 description 是这种写法。
 *
 * 刻意不做完整 YAML：技能只需要 `description`，其余字段忽略；锚点 / 别名 / 嵌套结构 /
 * 引号转义都不解析——真需要时再换解析器，而不是在这里长出一个半成品的 YAML。
 */
function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
	const lines = raw.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return { data: {}, body: raw };
	let end = -1;
	for (let index = 1; index < lines.length; index += 1) {
		if (lines[index]?.trim() === "---") {
			end = index;
			break;
		}
	}
	if (end === -1) return { data: {}, body: raw };
	const data: Record<string, string> = {};
	for (let index = 1; index < end; index += 1) {
		const line = lines[index] ?? "";
		if (!line.trim() || line.startsWith(" ") || line.startsWith("\t")) continue;
		const colon = line.indexOf(":");
		if (colon <= 0) continue;
		const key = line.slice(0, colon).trim().toLowerCase();
		const marker = line.slice(colon + 1).trim();
		// 块标量只认 `>` / `>-` / `|` / `|-` 四个写法；`>+` / `|2` 之类按单行值落下去，
		// readDirSkill 会把"只剩一个符号"的值当没有摘要跳过
		const block = /^([>|])(-)?$/.exec(marker);
		if (block) {
			const scalar = blockScalarOf(lines, index + 1, end, block[1] === ">", block[2] === "-");
			data[key] = scalar.value;
			index = scalar.next - 1; // 主循环再 +1；next 指向块后第一条非块内容
			continue;
		}
		let value = marker;
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1).trim();
		}
		data[key] = value;
	}
	return { data, body: lines.slice(end + 1).join("\n") };
}

function readFlatSkill(path: string, name: string): ScannedSkill {
	const base = { name, form: "flat" as const, path, summary: "", manual: "", valid: false };
	try {
		const raw = readFileSync(path, "utf8").trim();
		const [first, ...rest] = raw.split("\n");
		const summary = (first ?? "").trim();
		const manual = rest.join("\n").trim();
		// 格式不对的文件宁可不上索引：渲染半份手册比没有手册更糟
		if (!summary || !manual) return base;
		return { ...base, summary, manual, valid: true };
	} catch {
		return base;
	}
}

function readDirSkill(path: string, name: string): ScannedSkill {
	const base = { name, form: "dir" as const, path, summary: "", manual: "", valid: false };
	try {
		const raw = readFileSync(path, "utf8");
		const { data, body } = parseFrontmatter(raw);
		const rawSummary = (data.description ?? "").trim();
		// 解析器不支持的块标量变体（`>+` / `|2` / `>-2` 等：chomp 指示符或显式缩进位数）
		// 会按单行值落成一个裸符号：等于没有摘要，宁可跳过，也不把 ">" 注进索引
		// （2026-11-11 起常规的 `>` / `|` 块已由解析器吃掉）
		const summary = /^[>|][+-]?\d*$/.test(rawSummary) ? "" : rawSummary;
		const manual = body.trim();
		// 标准形态：没有 description 就没有索引摘要，只能跳过（正文仍可手工看）
		if (!summary || !manual) return base;
		return { ...base, summary, manual, valid: true };
	} catch {
		return base;
	}
}

/**
 * 扫一个技能目录，返回两种形态的条目（扁平 .md 与 目录/SKILL.md）。
 *
 * 同一目录内同名时**扁平形态优先**（`.md` 是本仓库原生写法，先到先得的老口径）；
 * 两种形态都按名字排序遍历，结果稳定。
 */
export function scanSkillDir(dir: string): ScannedSkill[] {
	if (!existsSync(dir)) return [];
	let entries: string[];
	try {
		entries = readdirSync(dir).sort();
	} catch {
		return [];
	}

	const out: ScannedSkill[] = [];
	const claimed = new Set<string>();

	// 第一轮：扁平 `<名>.md`
	for (const file of entries) {
		if (!file.endsWith(".md")) continue;
		const name = file.slice(0, -3);
		if (!name || claimed.has(name)) continue;
		claimed.add(name);
		out.push(readFlatSkill(join(dir, file), name));
	}

	// 第二轮：`<名>/SKILL.md`（隐藏目录跳过：.git / .DS_Store 之类不是技能）
	for (const entry of entries) {
		if (entry.startsWith(".")) continue;
		if (claimed.has(entry)) continue;
		const path = join(dir, entry, "SKILL.md");
		if (!existsSync(path)) continue;
		claimed.add(entry);
		out.push(readDirSkill(path, entry));
	}

	return out;
}

/**
 * 在单个目录里按名字找一条技能（扁平优先，其次目录形态）。
 *
 * 只给管理端点的"读一条"用：它要的是**原始文件全文**（编辑器里看到什么就存什么），
 * 与加载器的摘要/正文切分不是一回事。名字来自 URL，先由白名单挡住穿越。
 */
export function findSkillInDir(dir: string, name: string): ScannedSkill | null {
	if (!name || name === "." || name === ".." || /[/\\]/.test(name)) return null;
	const flat = join(dir, `${name}.md`);
	if (existsSync(flat)) return readFlatSkill(flat, name);
	const dirSkill = join(dir, name, "SKILL.md");
	if (existsSync(dirSkill)) return readDirSkill(dirSkill, name);
	return null;
}

/**
 * dir 可为单目录，或**按优先级从高到低排列的目录数组**（批次D D1 的总管技能合并；
 * 2026-11-08 批 10-A 起 assist.ts 传的是 `resolveSkillsDir().dirs` 的全链）。
 * 数组形态：先到的目录拥有同名技能（同名时总管技能覆盖全局 skills/ 兜底）；
 * 每个名字只认第一个出现它的目录，含格式不对的文件也占位，防全局兜底顶掉总管占位。
 * 单目录形态行为与改动前一致。
 */
/**
 * 技能索引摘要截断的**总开关**（2026-11-15 上下文预算批，界面「行为开关」页）。
 *
 * `SKILLS_INDEX_CLIP`：缺省开；`false` / `0` / `off` = 关（索引显示完整摘要）。
 * 关掉等于回到 11-15 之前的形态（索引可能上万字）。只影响索引那一行，
 * `skill(name)` 取的手册仍是完整正文。
 */
export function skillsIndexClipEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return flagEnabled("SKILLS_INDEX_CLIP", env);
}

/**
 * 技能索引摘要的截断字数（2026-11-15 上下文预算批）。
 *
 * 实测：开 19 个技能时索引 3889 字，摘要平均 205 字（最长的 1018 字）；
 * 索引每轮都在 system 段里，比记忆注入（2000 字）还占地方。截到 120 字后约 2200 字。
 *
 * 口径：总开关关 → 0（不截断）；否则缺省 120；`SKILLS_INDEX_SUMMARY_CHARS=0` = 不截断
 * （一行回滚）；非法值回落默认；clamp `0..2000`。
 * 只影响索引里那一行，`skill(name)` 取的手册仍是完整正文。
 */
export function skillsIndexSummaryChars(env: NodeJS.ProcessEnv = process.env): number {
	if (!skillsIndexClipEnabled(env)) return 0;
	const raw = (env.SKILLS_INDEX_SUMMARY_CHARS ?? "").trim();
	if (!raw) return 120;
	const value = Number(raw);
	if (!Number.isFinite(value)) return 120;
	return Math.min(2000, Math.max(0, Math.round(value)));
}

export function createSkillStore(
	dirOrDirs: string | string[],
	options: {
		visible?: (name: string) => boolean;
		/** 2026-11-15 按人可见：全局开 || 该人覆盖开。不传 = 回落 visible。 */
		visibleFor?: (partnerId: string, name: string) => boolean;
		/**
		 * 代码内置技能（2026-11-16 工具裁剪 A）：返回 true 的名字绕过启停位 / 按人可见性，
		 * 始终进索引、始终能被 skill(name) 取到。默认 () => false = 旧行为零改动。
		 * 只认调用方传入的代码名单（isCoreSkill），不认技能文件 frontmatter 自封。
		 */
		isCore?: (name: string) => boolean;
		/**
		 * 索引里每条摘要最多显示多少字（2026-11-15 上下文预算批）。
		 * 不传 / 0 = 不截断（旧行为）；正文手册（`manual`）永远不受影响。
		 * 也收函数：界面「行为开关」页改了总开关后，新会话首渲染现读新值（热生效）。
		 */
		indexSummaryChars?: number | (() => number);
	} = {},
): SkillStore | null {
	const dirs = Array.isArray(dirOrDirs) ? dirOrDirs : [dirOrDirs];
	/** 每次渲染现算：函数形式读的是当前 env（界面开关改完，新会话立即按新值渲染）。 */
	const summaryCharsOf = (): number => {
		const raw =
			typeof options.indexSummaryChars === "function"
				? options.indexSummaryChars()
				: options.indexSummaryChars;
		return Number.isFinite(raw) && (raw ?? 0) > 0 ? Math.floor(raw as number) : 0;
	};
	// 启停位（2026-11-09）：visible 不传 = 全部可见（旧行为）；传了则索引 / 名单 / 取手册都按它过滤
	const visible = options.visible ?? (() => true);
	const visibleFor = options.visibleFor;
	const isCore = options.isCore ?? (() => false);
	// core 短路：内置技能不受启停位 / 按人可见性影响。索引、names()、manual() 都走这一条，
	// 三处自动一致（2026-11-16 工具裁剪 A）。
	const canSee = (name: string, partnerId?: string | null): boolean =>
		isCore(name) || (partnerId && visibleFor ? visibleFor(partnerId, name) : visible(name));

	const skills = new Map<string, { summary: string; manual: string }>();
	const claimed = new Set<string>();
	for (const dir of dirs) {
		for (const entry of scanSkillDir(dir)) {
			if (claimed.has(entry.name)) continue; // 先到的目录优先
			claimed.add(entry.name);
			if (!entry.valid) {
				console.warn(`[skills] 跳过格式不对的技能文件: ${entry.path}`);
				continue;
			}
			skills.set(entry.name, { summary: entry.summary, manual: entry.manual });
		}
	}
	if (skills.size === 0) return null;

	const frozen = new Map<string, string | undefined>();
	const frozenKey = (conversationId: number, partnerId?: string | null) =>
		`${conversationId}|${partnerId ?? ""}`;
	const renderIndex = (partnerId?: string | null): string | undefined => {
		// 摘要截断（2026-11-15 上下文预算批）：技能索引每轮都在 system 里，实测开 19 个技能
		// 就占 3889 字（摘要平均 205 字，有的写成整段说明）。截断只影响索引里那一行；
		// 模型真要用手册，`skill(name)` 取到的仍是完整正文（L2），所以信息不丢。
		const limit = summaryCharsOf();
		const clip = (summary: string): string => {
			if (limit <= 0 || summary.length <= limit) return summary;
			return `${summary.slice(0, limit - 1)}…`;
		};
		const lines = [...skills.keys()]
			.filter((name) => canSee(name, partnerId))
			.map((name) => `- ${name}：${clip(skills.get(name)!.summary)}`);
		// 一个可见的都没有：整个 section 省略（接口注释的既有口径），别渲染空标题
		if (!lines.length) return undefined;
		return (
			"可用技能（对方的事需要按某个流程引导时，先调 skill(name) 取完整手册再开始）：\n" +
			lines.join("\n")
		);
	};

	// 名字只记前 40 个：`.agents/skills` 可能有上百条，整串打出来日志没法看
	const names = [...skills.keys()];
	const preview = names.slice(0, 40).join("、") + (names.length > 40 ? `、…（共 ${names.length} 条）` : "");
	console.log(`[skills] 已加载 ${skills.size} 条技能：${preview}`);
	return {
		names: (partnerId) => [...skills.keys()].filter((name) => canSee(name, partnerId)),
		manual: (name, partnerId) => (canSee(name, partnerId) ? skills.get(name)?.manual : undefined),
		indexFor(conversationId, partnerId) {
			// 全关时渲染结果是 undefined：用 has 判冻，别用 get——undefined 也算"已冻结"
			const key = frozenKey(conversationId, partnerId);
			if (!frozen.has(key)) frozen.set(key, renderIndex(partnerId));
			return frozen.get(key);
		},
		previewIndex(partnerId) {
			// 只渲染，不写 frozen：设置页预览不能污染真实会话的首轮快照。
			return renderIndex(partnerId);
		},
	};
}

/**
 * 技能斜杠调用（2026-11-09 用户口径：对话框输入「/技能名」就能用）。
 * 纯函数：匹配 `/name`（名字规则与 SKILL_NAME 同一条）+ 后面是空白或行尾才算，
 * `/abc/def` 这种路径样不算。生命周期钩子据此把手册整份注入本轮。
 */
export function skillSlashOf(text: string): string | null {
	const match = /^\/([a-z0-9][a-z0-9-_]{0,63})(?:\s|$)/.exec(String(text || "").trimStart());
	return match ? match[1] : null;
}
