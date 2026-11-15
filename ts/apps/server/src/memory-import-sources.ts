import { homedir } from "node:os";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MemoryKind } from "@lifediary/memory";
import { importMemory } from "./memory-consolidate.ts";
import { projectsStore, type Project } from "./projects.ts";

/**
 * 记忆导入的**本机来源**（2026-11-15 第一轮；同日第二轮扩成全量来源清单）。
 *
 * 别家 AI 在这台机器上已经积累的记忆条目，解析成 {text, kind, createdAt} 交给
 * `importMemory`（2026-11-08 的导入管线：只增不改、规范化等价去重、落库自动打码）。
 * 本模块只补"来源发现 + 解析适配"，不碰记忆四层任何策略。
 *
 * 三条硬口径：
 *  - **路径是白名单常量**：客户端只能报来源 id，不能传路径——否则这就是任意文件读取。
 *    盘点结论（哪些家有货、哪些家刻意不接）见方案文档；这里登记能解析的 + 只列灰态的。
 *  - **只读**：解析绝不写别家的目录；SQLite 一律 readOnly 打开。
 *  - **不重复做下游校验**：长度上限、去重、kind 白名单、时间裁剪都在 importMemory，
 *    解析器产什么就交什么，skipped 计数保持单一口径。
 *
 * 来源分两层（2026-11-15 补充轮放开项目级）：global 语义的（Qoder/Qwen awareness、
 * CodeBuddy、Qoder CLI global）照原样收；**项目级的**（ZCode 各项目、Qoder CLI projects/）
 * 条目带【项目名】前缀后也进 global——召回是按相关性打分 + 窗口截断（recall.ts），
 * 不是全量注入，聊到相关话题才会浮出来，不构成每轮刷屏。第二轮继续沿用这条口径。
 *
 * 第二轮（用户："把所有 Agent 都列出来，没检测到的标灰"）：
 *  - 解析层统一支持 frontmatter / `§` 分节 / 标题分节 / 索引逐行四种形态；
 *  - 同目录有正文条目时，MEMORY.md 索引不参与（避免摘要 + 正文两份重复）；
 *  - 模板占位、0 字节、>2MB 的文件跳过；
 *  - 云端（ChatGPT / Claude）记忆在账号服务端，本机没有可读条目，按用户要求不再列这两个来源；
 *    其余本机读不到 / 只有规则文件的 Agent 仍只列灰态，`count: 0`。
 */

/** 来源开关：默认开；`MEMORY_IMPORT_SOURCES=false/0/off` 时两端点 404、按钮不渲染。 */
export function memoryImportSourcesEnabled(): boolean {
	const value = (process.env.MEMORY_IMPORT_SOURCES ?? "").trim().toLowerCase();
	return value !== "false" && value !== "0" && value !== "off";
}

/** 解析器产出：交给 importMemory 的最小形状（项目匹配由 server 统一决策）。 */
export interface SourceEntry {
	text: string;
	kind: MemoryKind;
	/** 文件 mtime / frontmatter 时间；空着则 importMemory 落 now */
	createdAt?: string;
	/** 项目级条目的兜底标签（【xx】前缀）；匹配上登记项目后不用它 */
	projectLabel?: string;
	/** 项目匹配线索：zcode 给目录名，qoder 给路径 slug */
	projectHint?: { name?: string; slug?: string };
}

export interface ImportSourceInfo {
	id: string;
	name: string;
	note: string;
	/** 条目数；0 = 没检测到（前端灰态） */
	count: number;
}

/** 一个文件怎么切条目：默认整篇正文，index 逐行索引，headings 按标题分节。 */
type Splitter = "section" | "headings" | "index";

/**
 * 一份待解析的文件：kind 是保底映射，splitter 表示切分方式。
 * projectLabel 是【项目名】兜底标签；projectHint 给 server 的匹配器
 * （匹配上登记项目就不带前缀、直接落项目 scope，见 runMemoryImportSource）。
 */
interface SourceFile {
	file: string;
	kind: MemoryKind;
	splitter?: Splitter;
	/** false = 不从 frontmatter 推 kind（极少用；默认推） */
	metaKind?: boolean;
	projectLabel?: string;
	projectHint?: { name?: string; slug?: string };
}

/** 来源定义：collect 找文件清单；collectEntries 用于 SQLite / JSON 这种非文件集合来源。 */
interface ImportSourceDef {
	id: string;
	name: string;
	note: string;
	collect?(home: string): SourceFile[];
	collectEntries?(home: string): SourceEntry[];
}

/** 超过这个大小的文件不是记忆粒度，整份跳过（读进内存也没意义）。 */
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

/** 空模板/占位文案：不是用户记忆，别把产品说明导进来。 */
const PLACEHOLDER_MARKERS = [
	"What do they care about?",
	"Learn about the person you're helping",
	"The more you know, the better you can help",
	"You're learning about a person, not building a dossier",
	"Build this over time",
	"empty — no memories saved yet",
	"PLACEHOLDER",
	"待填充",
	"暂无记录",
];

/**
 * 剥 YAML frontmatter，返回（meta 键值对, 正文）。只在首行是 `---` 时剥；
 * 没有或残缺就整个当正文——别家的格式残缺不是咱们的错，能拿多少拿多少。
 *
 * 嵌套键记成 `metadata.type` 这样的点路径（ZCode 记忆的 type 藏在 metadata 下）；
 * YAML 列表项（`- "x"` 行）和折叠续行不匹配键形态，天然忽略。
 */
function stripFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
	const lines = raw.split(/\r?\n/);
	if ((lines[0] ?? "").trim() !== "---") {
		return { meta: {}, body: raw };
	}
	const meta: Record<string, string> = {};
	let end = -1;
	let prefix = "";
	for (let i = 1; i < lines.length; i += 1) {
		const line = lines[i];
		if (line.trim() === "---") {
			end = i;
			break;
		}
		const m = /^(\s*)([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
		if (!m) continue;
		const [, indent, key, value] = m;
		if (indent) {
			if (prefix && value) meta[`${prefix}.${key.toLowerCase()}`] = value.trim().replace(/^["']|["']$/g, "");
		} else {
			prefix = key.toLowerCase();
			if (value) meta[prefix] = value.trim().replace(/^["']|["']$/g, "");
		}
	}
	if (end < 0) return { meta: {}, body: raw };
	return { meta, body: lines.slice(end + 1).join("\n") };
}

/** frontmatter 的 type / metadata.type → kind；认不出返回 null。 */
function kindFromMetaOrNull(meta: Record<string, string>): MemoryKind | null {
	const raw = (meta["metadata.type"] ?? meta["type"] ?? meta["memory_type"] ?? meta["category"] ?? "")
		.trim()
		.toLowerCase();
	switch (raw) {
		case "user":
		case "feedback":
		case "preference":
		case "persona":
			return "preference";
		case "project":
		case "reference":
		case "fact":
		case "memory":
			return "fact";
		case "episode":
		case "experience":
		case "session":
			return "episode";
		default:
			return null;
	}
}

/** 文件名/路径的强提示：USER 类优先偏好，episodes/daily 类优先经历。 */
function fileKindHint(file: string): { kind: MemoryKind; strong: true } | null {
	const normalized = file.replace(/\\/g, "/").toLowerCase();
	const base = normalized.split("/").pop() ?? "";
	const stem = base.replace(/\.(md|mdc|txt|json)$/i, "");
	if (/^(user|feedback|preference|persona|profile)/.test(stem) || /\/(user|feedback|preferences?)\//.test(normalized)) {
		return { kind: "preference", strong: true };
	}
	if (/^(episode|session|daily)/.test(stem) || /\/(episodes?|sessions?|daily)\//.test(normalized)) {
		return { kind: "episode", strong: true };
	}
	if (/^(project|reference|fact)/.test(stem)) return { kind: "fact", strong: true };
	return null;
}

const EPISODE_HEADING_RE =
	/【[^】]{0,40}(任务|完成|进度|每日|日记|对话|会话|记录|复盘|结果|执行|过程|产出|更新|归档)[^】]{0,40}】|【(?:Daily Memory|Completed Tasks?|Work Log|Session Summary|Task Description|Execution|Outcome|Timeline|Updated Files)】/i;
const EPISODE_MARKER_RE =
	/(任务描述|执行过程|执行步骤|操作步骤|完成情况|进度统计|每日记忆|对话记录|对话总结|会话记录|复盘|经过|本次任务|这次任务|上次任务|产出文件|产出：|产出|流程：|全部成功|格式化了|设计了|安装了|复制了|已安装|已复制|脚本位置|完成了|处理了|生成了|已生成|已处理|已归档|```mermaid|graph TD|sequenceDiagram)/i;
const EPISODE_TIME_RE =
	/(今天|昨天|前天|刚才|刚刚|这次|上次|本次|当天).{0,100}(完成|处理|修复|实现|执行|跑|做|改|部署|提交|测试|验证|安装|归档|生成|整理|输出)/i;
const EPISODE_DATE_RE =
	/(20\d{2}[-/年]\d{1,2}[-/月]\d{1,2}).{0,140}(完成|处理|修复|实现|执行|跑|做|改|部署|提交|测试|验证|安装|归档|生成|整理|输出|新增|更新|移除)/i;
const EPISODE_EN_RE =
	/\b(i|we|assistant|agent)\b.{0,120}\b(completed|fixed|implemented|ran|tested|deployed|created|updated|added|removed|moved|wrote|built|investigated)\b/i;

/** 统计一个正则命中的次数；不动原正则的 lastIndex。 */
function countMatches(pattern: RegExp, text: string): number {
	const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
	return (text.match(new RegExp(pattern.source, flags)) ?? []).length;
}

const PREFERENCE_HEADING_RE =
	/【[^】]{0,40}(偏好|喜好|口味|审美|配色|风格|习惯|沟通|工作方式|协作|原则|约定|规范|画像|人物|User Memory|Profile|Persona|Preference|Feedback)[^】]{0,40}】/i;
const PREFERENCE_STRONG_RE =
	/(用户|需求方|我|主人)[^。；\n]{0,30}(喜欢|偏好|不喜欢|讨厌|反感|反对|希望|不希望|想要|要求|习惯|倾向|更愿意|不想|不要|别|接受|介意|在意|重视|常用|默认|最好|尽量|以后|每次|沟通|称呼|口味|审美|配色|风格)|(用户|需求方|我)(原话|明确|说|问|反馈|纠正)|(不喜欢|偏好|讨厌|反感).{0,25}(紫色|颜色|配色|风格)|(采用|使用|偏好|不喜欢|不要|别).{0,25}(简约|紫色|颜色|配色|审美|主题)|(偏好|喜好|审美|配色|沟通方式|工作方式|协作方式|主要用|常用|习惯用|默认用)/i;
const PREFERENCE_WEAK_RE =
	/(偏好|喜好|口味|审美|配色|风格|习惯|沟通方式|工作方式|协作方式|画像|persona|profile|preference|feedback|约定|原则|规范)/i;
const PREFERENCE_EN_RE =
	/\b(user|i|we)\b.{0,80}\b(prefer|like|dislike|hate|want|avoid|favor|love|need|dissatisfied|annoyed|upset)\b|\b(writes?|respond|reply)\b.{0,40}\b(chinese|english|language)\b/i;

const FACT_HEADING_RE =
	/【[^】]{0,40}(项目|架构|技术栈|环境|配置|构建|依赖|版本|接口|端点|数据库|目录|路径|实现|规则|约束|方案|决策|结论|背景|定位|核心|Tech Stack|Project|Architecture|Environment|Setup|Implementation|API|Backend|Frontend)[^】]{0,40}】/i;
const FACT_MARKER_RE =
	/(项目|架构|技术栈|环境|配置|构建|依赖|版本|接口|端点|数据库|表|字段|目录|路径|脚本|命令|部署|实现|规则|约束|API|SQL|代码|组件|页面|布局|样式|逻辑|方案|决策|结论|背景|定位|核心能力|Tech Stack|Project|Architecture|Environment|Setup|Implementation|Backend|Frontend)/gi;
const TECH_TOKEN_RE =
	/\b(api|url|http|sql|json|yaml|sdk|cli|npm|pnpm|git|node|react|android|kotlin|gradle|python|typescript|docker|linux|windows|powershell|jdk|css|html|js|ts)\b|[A-Z]:\\|~\/|`[^`]+`|\b\d+\.\d+(?:\.\d+)?\b/gi;

/**
 * 单条内容的 kind 判定。文件级 fallback 只当保底：
 * - USER / feedback / preference / episodes / daily 这类文件名是强提示；
 * - 正文按“任务执行记录 → 用户偏好 → 项目事实”的顺序识别；
 * - 识别不出才回落到文件级 fallback。这样同一份 MEMORY.md 里的
 *   偏好、项目规则、任务日志不会全部被压成 fact。
 */
export function classifySourceKind(
	text: string,
	fallback: MemoryKind,
	context: { file?: string; explicit?: MemoryKind | null } = {},
): MemoryKind {
	const compact = text.replace(/\s+/g, " ").trim();
	if (!compact) return fallback;

	const hint = context.file ? fileKindHint(context.file) : null;
	if (context.explicit === "episode" || hint?.kind === "episode") return "episode";

	const episodeHeading = EPISODE_HEADING_RE.test(compact);
	const episodeMarkerHits = countMatches(EPISODE_MARKER_RE, compact);
	const episodeTime = EPISODE_TIME_RE.test(compact);
	const episodeDate = EPISODE_DATE_RE.test(compact);
	const episodeEn = EPISODE_EN_RE.test(compact);
	const episodeScore =
		(episodeHeading ? 3 : 0) +
		Math.min(episodeMarkerHits, 3) * 2 +
		(episodeTime ? 2 : 0) +
		(episodeDate ? 2 : 0) +
		(episodeEn ? 2 : 0) +
		(/```mermaid/i.test(compact) ? 4 : 0);
	if (episodeScore >= 5 && episodeScore >= (hint?.kind === "preference" ? 4 : 0)) return "episode";
	if (hint?.kind === "preference" && hint.strong) return "preference";

	const preferenceHeading = PREFERENCE_HEADING_RE.test(compact);
	const preferenceStrong = PREFERENCE_STRONG_RE.test(compact);
	const preferenceEn = PREFERENCE_EN_RE.test(compact);
	const preferenceWeak = PREFERENCE_WEAK_RE.test(compact);
	const preferenceScore =
		(preferenceHeading ? 3 : 0) + (preferenceStrong ? 3 : 0) + (preferenceEn ? 2 : 0) + (preferenceWeak ? 1 : 0);

	const factHits = (compact.match(FACT_MARKER_RE) ?? []).length;
	const techHits = (compact.match(TECH_TOKEN_RE) ?? []).length;
	const factScore =
		(FACT_HEADING_RE.test(compact) ? 3 : 0) + Math.min(factHits, 5) + Math.min(techHits, 4);

	if (preferenceHeading || preferenceStrong || preferenceEn) return "preference";
	if (hint?.kind === "preference" && hint.strong) return "preference";
	if (preferenceWeak && fallback === "preference") return "preference";
	if (factScore >= 3) return "fact";
	if (episodeScore >= 3) return "episode";
	if (preferenceScore >= 2) return "preference";
	if (context.explicit === "preference" && preferenceScore >= 1) return "preference";
	if (factScore >= 1) return "fact";
	return fallback;
}

/** qoder 分类 → kind：用户自己的分类是偏好与爱好，其余是项目事实。 */
function qoderCategoryKind(category: string): MemoryKind {
	return category.startsWith("user_") ? "preference" : "fact";
}

/** 文件名前缀 → kind：`user_*` / `feedback_*` 是偏好，`project_*` / `reference_*` 是事实。 */
function kindFromFileName(name: string, fallback: MemoryKind): MemoryKind {
	const lower = name.toLowerCase();
	if (/^(user|feedback|preference)/.test(lower)) return "preference";
	if (/^(project|reference|fact)/.test(lower)) return "fact";
	return fallback;
}

/** ZCode 项目目录名去尾巴哈希：`lifediary-harness-a914f932a11d9f44` → `lifediary-harness`。 */
function zcodeProjectLabel(dirName: string): string {
	return dirName.replace(/-[0-9a-f]{16}$/i, "") || dirName;
}

/** qoder 项目 slug 取尾段当项目名：`d-GitWarehouse-konwlegdecard` → `konwlegdecard`。 */
function qoderProjectLabel(slug: string): string {
	const parts = slug.split("-").filter(Boolean);
	return parts[parts.length - 1] || slug;
}

/**
 * IDE 类项目的 slug 解码：`D--Projects-projects-student-milk-order` → `student-milk-order`。
 * 先去掉 `--p2-<hash>` 的在途任务后缀，再从最后一个 `-projects-` 后面取整段；
 * 没有 `-projects-` 的老格式仍走"尾段"兜底（保持第一轮行为）。
 */
function labelFromProjectSlug(slug: string): string {
	const cleaned = slug.replace(/--p\d+-[0-9a-f]{8,}$/i, "");
	const low = cleaned.toLowerCase();
	const marker = "-projects-";
	const at = low.lastIndexOf(marker);
	if (at >= 0) {
		const tail = cleaned.slice(at + marker.length);
		if (tail) return tail;
	}
	return qoderProjectLabel(cleaned);
}

/** 安全列目录：不存在 / 权限不足都当空，别让一个来源拖死整张清单。 */
function safeReaddir(dir: string) {
	try {
		return readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
}

function subdirs(dir: string): string[] {
	return safeReaddir(dir)
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name);
}

function filesIn(dir: string, suffix = ""): string[] {
	return safeReaddir(dir)
		.filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
		.map((entry) => entry.name);
}

/** 递归找文件：深度有上限，跳过隐藏/缓存目录，单个目录读不到就跳过。 */
function walkFiles(root: string, options: { suffix?: string; maxDepth?: number; skip?: RegExp } = {}): string[] {
	const { suffix = "", maxDepth = 6, skip = /^(?:node_modules|\.git|\.tmp|cache|Cache)$/i } = options;
	const out: string[] = [];
	const walk = (dir: string, depth: number) => {
		if (depth > maxDepth) return;
		for (const entry of safeReaddir(dir)) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (skip.test(entry.name)) continue;
				walk(full, depth + 1);
			} else if (entry.isFile() && entry.name.endsWith(suffix)) {
				out.push(full);
			}
			if (out.length > 5000) return;
		}
	};
	walk(root, 0);
	return out;
}

function findFile(root: string, name: string, maxDepth = 4): string | null {
	const found = walkFiles(root, { suffix: name, maxDepth }).find((file) => basename(file) === name);
	return found ?? null;
}

/** 一个目录里的记忆文件：有正文条目就不收 MEMORY.md 索引，只有索引时才逐行收。 */
function collectMemoryDir(
	dir: string,
	kind: MemoryKind,
	options: {
		projectLabel?: string;
		projectHint?: { name?: string; slug?: string };
		kindByFileName?: boolean;
	} = {},
): SourceFile[] {
	const names = filesIn(dir, ".md");
	if (names.length === 0) return [];
	const entryNames = names.filter((name) => name !== "MEMORY.md");
	const chosen = entryNames.length > 0 ? entryNames : ["MEMORY.md"];
	return chosen.map((name) => ({
		file: join(dir, name),
		kind: options.kindByFileName ? kindFromFileName(name, kind) : kind,
		...(entryNames.length > 0 ? {} : { splitter: "index" as const }),
		...(options.projectLabel ? { projectLabel: options.projectLabel } : {}),
		...(options.projectHint ? { projectHint: options.projectHint } : {}),
	}));
}

/** Qoder CLI：`~/.qoder/memories/<hash>/global/<分类>/*.md`，projects/ 子树由另一个来源收。 */
function qoderCliCollect(home: string): SourceFile[] {
	const root = join(home, ".qoder", "memories");
	const out: SourceFile[] = [];
	for (const hash of subdirs(root)) {
		const globalDir = join(root, hash, "global");
		if (!existsSync(globalDir)) continue;
		for (const category of subdirs(globalDir)) {
			for (const file of filesIn(join(globalDir, category), ".md")) {
				out.push({
					file: join(globalDir, category, file),
					kind: qoderCategoryKind(category),
				});
			}
		}
	}
	return out;
}

/** Qoder CLI 的项目级半边：`projects/<slug>/<分类>/*.md`，slug 就是匹配线索。 */
function qoderCliProjectsCollect(home: string): SourceFile[] {
	const root = join(home, ".qoder", "memories");
	const out: SourceFile[] = [];
	for (const hash of subdirs(root)) {
		const projectsDir = join(root, hash, "projects");
		if (!existsSync(projectsDir)) continue;
		for (const project of subdirs(projectsDir)) {
			const label = labelFromProjectSlug(project);
			const projectDir = join(projectsDir, project);
			for (const category of subdirs(projectDir)) {
				for (const file of filesIn(join(projectDir, category), ".md")) {
					out.push({
						file: join(projectDir, category, file),
						kind: qoderCategoryKind(category),
						projectLabel: label,
						projectHint: { slug: project.toLowerCase(), name: label },
					});
				}
			}
		}
	}
	return out;
}

/** Qoder IDE 的全局记忆：`.qoder/memory` 与国行 `.qoder-cn/memory`（两个变体都收）。 */
function qoderIdeCollect(home: string): SourceFile[] {
	const out: SourceFile[] = [];
	for (const dirName of [".qoder", ".qoder-cn"]) {
		const dir = join(home, dirName, "memory");
		if (!existsSync(dir)) continue;
		out.push(...collectMemoryDir(dir, "preference", { kindByFileName: true }));
	}
	return out;
}

/** Qoder IDE 的项目记忆：`<home>/<.qoder|.qoder-cn>/projects/<slug>/memory/*.md`。 */
function qoderIdeProjectsCollect(home: string): SourceFile[] {
	const out: SourceFile[] = [];
	for (const dirName of [".qoder", ".qoder-cn"]) {
		const projectsRoot = join(home, dirName, "projects");
		for (const project of subdirs(projectsRoot)) {
			const memDir = join(projectsRoot, project, "memory");
			if (!existsSync(memDir)) continue;
			const label = labelFromProjectSlug(project);
			out.push(
				...collectMemoryDir(memDir, "fact", {
					projectLabel: label,
					projectHint: { name: label, slug: project.toLowerCase() },
					kindByFileName: true,
				}),
			);
		}
	}
	return out;
}

/** ZCode 各项目记忆：`~/.zcode/cli/memories/projects/<项目-哈希>/memory/*.md`（MEMORY.md 索引不收）。 */
function zcodeProjectsCollect(home: string): SourceFile[] {
	const root = join(home, ".zcode", "cli", "memories", "projects");
	const out: SourceFile[] = [];
	for (const project of subdirs(root)) {
		const memDir = join(root, project, "memory");
		if (!existsSync(memDir)) continue;
		const label = zcodeProjectLabel(project);
		for (const file of filesIn(memDir, ".md")) {
			if (file === "MEMORY.md") continue;
			out.push({
				file: join(memDir, file),
				kind: "fact",
				projectLabel: label,
				projectHint: { name: label },
			});
		}
	}
	return out;
}

/** awareness 家族的通用收集：`<home>/<dir>/awareness/main/{MEMORY.md,USER.md}`。 */
function awarenessCollectFrom(home: string, dirNames: string[]): SourceFile[] {
	const out: SourceFile[] = [];
	for (const dirName of dirNames) {
		const dir = join(home, dirName, "awareness", "main");
		for (const name of ["MEMORY.md", "USER.md"]) {
			const file = join(dir, name);
			if (!existsSync(file)) continue;
			out.push({
				file,
				kind: name === "USER.md" ? "preference" : "fact",
				splitter: "section",
			});
		}
	}
	return out;
}

/** Qoder Work awareness：MEMORY.md（事实）+ USER.md（偏好），条目按 `§` 行分节。 */
function qoderAwarenessCollect(home: string): SourceFile[] {
	return awarenessCollectFrom(home, [".qoderworkcn", ".qoderwork"]);
}

/** Qwen Work awareness：与 Qoder 同构。 */
function qwenAwarenessCollect(home: string): SourceFile[] {
	return awarenessCollectFrom(home, [".qwenworkcn", ".qwenwork"]);
}

/** CodeBuddy 全局记忆：`%LOCALAPPDATA%/CodeBuddyExtension/Data/Public/.memories/*.mdc`。 */
function codebuddyCollect(home: string): SourceFile[] {
	const root = join(home, "AppData", "Local", "CodeBuddyExtension", "Data", "Public", ".memories");
	const out: SourceFile[] = [];
	for (const file of filesIn(root, ".mdc")) {
		if (file.startsWith(".")) continue;
		out.push({ file: join(root, file), kind: "fact" });
	}
	return out;
}

/** CodeBuddy 项目记忆：`~/.codebuddy/projects/<slug>/memory/*.md`（索引同规则）。 */
function codebuddyProjectsCollect(home: string): SourceFile[] {
	const root = join(home, ".codebuddy", "projects");
	const out: SourceFile[] = [];
	for (const project of subdirs(root)) {
		const memDir = join(root, project, "memory");
		if (!existsSync(memDir)) continue;
		const label = labelFromProjectSlug(project);
		out.push(
			...collectMemoryDir(memDir, "fact", {
				projectLabel: label,
				projectHint: { name: label, slug: project.toLowerCase() },
				kindByFileName: true,
			}),
		);
	}
	return out;
}

/** Claude Code 项目记忆：`~/.claude/projects/<项目>/memory/*.md`。 */
function claudeCodeCollect(home: string): SourceFile[] {
	const root = join(home, ".claude", "projects");
	const out: SourceFile[] = [];
	for (const project of subdirs(root)) {
		const memDir = join(root, project, "memory");
		if (!existsSync(memDir)) continue;
		const label = labelFromProjectSlug(project);
		out.push(
			...collectMemoryDir(memDir, "preference", {
				projectLabel: label,
				projectHint: { name: label, slug: project.toLowerCase() },
				kindByFileName: true,
			}),
		);
	}
	return out;
}

/** GitHub Copilot Chat 的 workspace 记忆：一个 md 一条。 */
function copilotCollect(home: string): SourceFile[] {
	const root = join(home, "AppData", "Roaming", "Code", "User", "workspaceStorage");
	const out: SourceFile[] = [];
	for (const workspace of subdirs(root)) {
		const memRoot = join(root, workspace, "GitHub.copilot-chat", "memory-tool", "memories");
		if (!existsSync(memRoot)) continue;
		for (const file of walkFiles(memRoot, { suffix: ".md", maxDepth: 4 })) {
			out.push({ file, kind: "fact" });
		}
	}
	return out;
}

/** WorkBuddy 工作区笔记：`~/WorkBuddy/<会话>/.workbuddy/memory/*.md`。 */
function workbuddyCollect(home: string): SourceFile[] {
	const root = join(home, "WorkBuddy");
	const out: SourceFile[] = [];
	for (const workspace of subdirs(root)) {
		const memDir = join(root, workspace, ".workbuddy", "memory");
		for (const file of filesIn(memDir, ".md")) {
			out.push({ file: join(memDir, file), kind: "fact", splitter: "headings" });
		}
	}
	return out;
}

/** WorkBuddy AI：个人目录 MEMORY/USER + 旧版工作区 .workbuddy-ai/memory。 */
function workbuddyAiCollect(home: string): SourceFile[] {
	const out: SourceFile[] = [];
	const personalRoot = join(home, ".workbuddy-ai");
	for (const dirName of subdirs(personalRoot)) {
		if (!dirName.startsWith("user-")) continue;
		const personalDir = join(personalRoot, dirName);
		for (const name of ["MEMORY.md", "USER.md"]) {
			const file = join(personalDir, name);
			if (!existsSync(file)) continue;
			out.push({
				file,
				kind: name === "USER.md" ? "preference" : "fact",
				splitter: "headings",
			});
		}
	}
	for (const file of filesIn(join(personalRoot, "memory"), ".md")) {
		out.push({ file: join(personalRoot, "memory", file), kind: "fact", splitter: "headings" });
	}
	for (const workspace of subdirs(join(home, "WorkBuddy AI"))) {
		const memDir = join(home, "WorkBuddy AI", workspace, ".workbuddy-ai", "memory");
		for (const file of filesIn(memDir, ".md")) {
			out.push({ file: join(memDir, file), kind: "fact", splitter: "headings" });
		}
	}
	return out;
}

/** Cindy：`%APPDATA%/Cindy/owners/<owner>/bots/<bot>/memories/*.md`。 */
function cindyCollect(home: string): SourceFile[] {
	const root = join(home, "AppData", "Roaming", "Cindy", "owners");
	const out: SourceFile[] = [];
	for (const owner of subdirs(root)) {
		const botsDir = join(root, owner, "bots");
		for (const bot of subdirs(botsDir)) {
			const memDir = join(botsDir, bot, "memories");
			if (!existsSync(memDir)) continue;
			out.push(...collectMemoryDir(memDir, "preference", { kindByFileName: true }));
		}
	}
	return out;
}

/** Trae CN / TRAE SOLO：只收用户画像，session_memory 是会话摘要，按上一版口径不碰。 */
function traeCollect(home: string): SourceFile[] {
	const out: SourceFile[] = [];
	for (const dirName of [".trae-cn", ".trae-aicc"]) {
		const file = join(home, dirName, "memory", "user_profile.md");
		if (existsSync(file)) out.push({ file, kind: "fact", splitter: "headings" });
	}
	return out;
}

/** 千帆桌面自带的 OpenCode 记忆：`.../config/opencode/memory/*.md` 每日笔记（多一层 profile/hash）。 */
function qianfanCollect(home: string): SourceFile[] {
	const root = join(home, "AppData", "Roaming", "qianfan-desktop-app");
	const out: SourceFile[] = [];
	for (const file of walkFiles(root, { suffix: ".md", maxDepth: 5 })) {
		if (!/[\\/]config[\\/]opencode[\\/]memory[\\/]/.test(file)) continue;
		out.push({ file, kind: "fact", splitter: "headings" });
	}
	return out;
}

/** OpenClaw 系工作区：MEMORY.md / USER.md（USER 模板空着时会被占位过滤掉）。 */
function openclawWorkspaceFiles(workspaceDir: string): SourceFile[] {
	const out: SourceFile[] = [];
	for (const name of ["MEMORY.md", "USER.md"]) {
		const file = join(workspaceDir, name);
		if (!existsSync(file)) continue;
		out.push({
			file,
			kind: name === "USER.md" ? "preference" : "fact",
			splitter: "headings",
		});
	}
	return out;
}

function openclawCollect(home: string): SourceFile[] {
	return openclawWorkspaceFiles(join(home, ".openclaw", "workspace"));
}

function autoclawCollect(home: string): SourceFile[] {
	const root = join(home, ".openclaw-autoclaw", "agents");
	const out: SourceFile[] = [];
	for (const agent of subdirs(root)) {
		const workspace = join(root, agent, "workspace");
		if (!existsSync(workspace)) continue;
		out.push(...openclawWorkspaceFiles(workspace));
	}
	return out;
}

function stepclawCollect(home: string): SourceFile[] {
	const out: SourceFile[] = [];
	for (const workspace of ["workspace", "workspace-main-2"]) {
		out.push(...openclawWorkspaceFiles(join(home, ".stepclaw", workspace)));
	}
	return out;
}

/** 从 SQLite 只读取行；库/表不存在、被锁、格式不对都返回空。 */
function readSqliteRows(path: string, table: string, limit = 2000): Record<string, unknown>[] {
	if (!existsSync(path)) return [];
	let db: DatabaseSync | null = null;
	try {
		db = new DatabaseSync(path, { readOnly: true });
		const exists = db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
			.get(table) as { name?: string } | undefined;
		if (!exists) return [];
		const rows = db.prepare(`SELECT * FROM "${table}" LIMIT ${limit}`).all() as Record<string, unknown>[];
		return rows;
	} catch {
		return [];
	} finally {
		try {
			db?.close();
		} catch {
			/* 关闭失败不影响已读出的行 */
		}
	}
}

/** 行里的时间：数字按秒/毫秒都能认，字符串走 Date.parse。 */
function timeFromUnknown(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		const ms = value > 1e12 ? value : value > 1e9 ? value * 1000 : null;
		return ms ? new Date(ms).toISOString() : undefined;
	}
	if (typeof value === "string" && value.trim()) {
		const parsed = Date.parse(value);
		if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
	}
	return undefined;
}

/** 行里的正文：优先指定列，否则取前几个非 id 的字符串列。 */
function textFromRow(row: Record<string, unknown>, preferred: string[]): string {
	const parts = preferred
		.map((key) => row[key])
		.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
	if (parts.length > 0) return parts.join("\n");
	const fallback = Object.entries(row)
		.filter(([key, value]) => !/id|uuid|hash/i.test(key) && typeof value === "string" && value.trim())
		.slice(0, 4)
		.map(([key, value]) => `${key}: ${String(value)}`);
	return fallback.join("\n");
}

function kindFromRow(row: Record<string, unknown>, fallback: MemoryKind): MemoryKind {
	const raw = String(row.type ?? row.kind ?? row.category ?? "").toLowerCase();
	if (/user|feedback|preference/.test(raw)) return "preference";
	if (/episode|experience|session/.test(raw)) return "episode";
	return fallback;
}

function timeFromRow(row: Record<string, unknown>): string | undefined {
	for (const key of ["created_at", "createdAt", "updated_at", "updatedAt", "timestamp", "time"]) {
		const at = timeFromUnknown(row[key]);
		if (at) return at;
	}
	return undefined;
}

function sqliteTableEntries(
	path: string,
	table: string,
	preferred: string[],
	fallbackKind: MemoryKind,
): SourceEntry[] {
	return readSqliteRows(path, table)
		.map((row) => {
			const text = textFromRow(row, preferred).trim();
			if (!text) return null;
			return {
				text,
				kind: kindFromRow(row, fallbackKind),
				...(timeFromRow(row) ? { createdAt: timeFromRow(row) } : {}),
			} satisfies SourceEntry;
		})
		.filter((entry): entry is SourceEntry => entry !== null);
}

/** Codex CLI 的 stage1 记忆：每行是一段 roll-out 摘要，空库返回 []（前端灰态）。 */
function codexEntries(home: string): SourceEntry[] {
	const rows = readSqliteRows(join(home, ".codex", "memories_1.sqlite"), "stage1_outputs");
	const out: SourceEntry[] = [];
	for (const row of rows) {
		const raw = typeof row.raw_memory === "string" ? row.raw_memory.trim() : "";
		const summary = typeof row.rollout_summary === "string" ? row.rollout_summary.trim() : "";
		const text = [raw, summary ? `摘要：${summary}` : ""].filter(Boolean).join("\n\n");
		if (!text) continue;
		const createdAt = timeFromUnknown(row.generated_at);
		out.push({ text, kind: "episode", ...(createdAt ? { createdAt } : {}) });
	}
	return out;
}

/** CherryStudio 记忆库：`memories` 表；本机 0 行，有数据时按正文列收。 */
function cherryStudioEntries(home: string): SourceEntry[] {
	return sqliteTableEntries(
		join(home, "AppData", "Roaming", "CherryStudio", "Data", "Memory", "memories.db"),
		"memories",
		["content", "text", "memory", "value"],
		"fact",
	);
}

/** 腾讯 ima：本机没有 memory_vector.db，有库时读 memory/memories 表。 */
function imaEntries(home: string): SourceEntry[] {
	const root = join(home, "AppData", "Local", "ima.copilot");
	const db = findFile(root, "memory_vector.db", 4);
	if (!db) return [];
	const fromMemory = sqliteTableEntries(db, "memory", ["content", "text", "memory"], "fact");
	if (fromMemory.length > 0) return fromMemory;
	return sqliteTableEntries(db, "memories", ["content", "text", "memory"], "fact");
}

/** 豆包 Agent 的模式记忆：`.sessions/<id>/memory/MEMORY.md`，全空时返回 []。 */
function doubaoEntries(home: string): SourceEntry[] {
	const root = join(home, "AppData", "Local", "Doubao", "User Data");
	const out: SourceEntry[] = [];
	for (const profile of subdirs(root)) {
		const sessions = join(root, profile, ".doubao", "agent_mode", "workspace", ".sessions");
		for (const session of subdirs(sessions)) {
			const file = join(sessions, session, "memory", "MEMORY.md");
			if (!existsSync(file)) continue;
			out.push(...parseSourceFile({ file, kind: "fact", splitter: "headings" }));
		}
	}
	return out;
}

/** Antigravity 的用户记忆：只认 JSON 里的 memories 数组，设置/账号文件不算。 */
function antigravityEntries(home: string): SourceEntry[] {
	const file = join(home, ".antigravity_cockpit", "user_memory.json");
	if (!existsSync(file)) return [];
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		const list = Array.isArray(parsed)
			? parsed
			: parsed && typeof parsed === "object" && Array.isArray((parsed as { memories?: unknown }).memories)
				? (parsed as { memories: unknown[] }).memories
				: [];
		return list
			.map((item) => {
				if (typeof item === "string") return { text: item.trim(), kind: "fact" as const };
				if (item && typeof item === "object") {
					const text = textFromRow(item as Record<string, unknown>, ["content", "text", "memory", "value"]);
					if (text) return { text, kind: kindFromRow(item as Record<string, unknown>, "fact") };
				}
				return null;
			})
			.filter((entry): entry is SourceEntry => Boolean(entry && entry.text));
	} catch {
		return [];
	}
}

/** 闪电说：knowledge/memory.md + episodes/*.json；本机只有迁移标记，返回 []。 */
function shandianshuoEntries(home: string): SourceEntry[] {
	const root = join(home, "AppData", "Roaming", "Shandianshuo", "memory");
	const out: SourceEntry[] = [];
	const memoryMd = join(root, "knowledge", "memory.md");
	if (existsSync(memoryMd)) out.push(...parseSourceFile({ file: memoryMd, kind: "fact", splitter: "headings" }));
	const episodesDir = join(root, "episodes");
	for (const file of filesIn(episodesDir, ".json")) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(join(episodesDir, file), "utf8"));
			const list = Array.isArray(parsed)
				? parsed
				: parsed && typeof parsed === "object" && Array.isArray((parsed as { episodes?: unknown }).episodes)
					? (parsed as { episodes: unknown[] }).episodes
					: [];
			for (const item of list) {
				if (typeof item === "string" && item.trim()) out.push({ text: item.trim(), kind: "episode" });
			}
		} catch {
			/* 单个坏 JSON 不影响其它条目 */
		}
	}
	return out;
}

const SOURCES: ImportSourceDef[] = [
	{
		id: "qoder-cli",
		name: "Qoder CLI",
		note: "Qoder 命令行跨项目记忆",
		collect: qoderCliCollect,
	},
	{
		id: "qoder-cli-projects",
		name: "Qoder CLI（项目）",
		note: "Qoder 按项目记下的规范与流程",
		collect: qoderCliProjectsCollect,
	},
	{
		id: "qoder-ide",
		name: "Qoder IDE",
		note: "Qoder 编辑器的长期记忆",
		collect: qoderIdeCollect,
	},
	{
		id: "qoder-ide-projects",
		name: "Qoder IDE（项目）",
		note: "Qoder 编辑器按项目记下的经验",
		collect: qoderIdeProjectsCollect,
	},
	{
		id: "qoder-awareness",
		name: "Qoder Work",
		note: "Qoder Work 的 MEMORY / USER",
		collect: qoderAwarenessCollect,
	},
	{
		id: "qwen-awareness",
		name: "Qwen Work",
		note: "Qwen Work 的 MEMORY / USER",
		collect: qwenAwarenessCollect,
	},
	{
		id: "codebuddy",
		name: "CodeBuddy",
		note: "CodeBuddy 的全局记忆条目",
		collect: codebuddyCollect,
	},
	{
		id: "codebuddy-projects",
		name: "CodeBuddy（项目）",
		note: "CodeBuddy 按项目记下的口径",
		collect: codebuddyProjectsCollect,
	},
	{
		id: "zcode-projects",
		name: "ZCode（项目）",
		note: "ZCode 按项目记下的口径与反馈",
		collect: zcodeProjectsCollect,
	},
	{
		id: "claude-code",
		name: "Claude Code",
		note: "Claude Code 的项目记忆",
		collect: claudeCodeCollect,
	},
	{
		id: "copilot",
		name: "GitHub Copilot",
		note: "Copilot Chat 的 workspace 记忆",
		collect: copilotCollect,
	},
	{
		id: "workbuddy",
		name: "WorkBuddy",
		note: "WorkBuddy 工作区的长期笔记",
		collect: workbuddyCollect,
	},
	{
		id: "workbuddy-ai",
		name: "WorkBuddy AI",
		note: "WorkBuddy AI 的个人记忆",
		collect: workbuddyAiCollect,
	},
	{
		id: "cindy",
		name: "Cindy",
		note: "Cindy 的长期记忆条目",
		collect: cindyCollect,
	},
	{
		id: "trae-cn",
		name: "Trae",
		note: "Trae 自动归纳的用户画像",
		collect: traeCollect,
	},
	{
		id: "qianfan",
		name: "千帆桌面",
		note: "千帆自带 OpenCode 的每日记忆",
		collect: qianfanCollect,
	},
	{
		id: "openclaw",
		name: "OpenClaw",
		note: "OpenClaw 工作区的 MEMORY / USER",
		collect: openclawCollect,
	},
	{
		id: "autoclaw",
		name: "AutoClaw",
		note: "AutoClaw 各 agent 工作区记忆",
		collect: autoclawCollect,
	},
	{
		id: "stepclaw",
		name: "StepClaw",
		note: "StepClaw 工作区的 MEMORY / USER",
		collect: stepclawCollect,
	},
	{
		id: "codex",
		name: "Codex CLI",
		note: "Codex 本地记忆库（stage1）",
		collectEntries: codexEntries,
	},
	{
		id: "cherrystudio",
		name: "CherryStudio",
		note: "CherryStudio 的 memories 表",
		collectEntries: cherryStudioEntries,
	},
	{
		id: "ima",
		name: "腾讯 ima",
		note: "ima 的 memory_vector 库",
		collectEntries: imaEntries,
	},
	{
		id: "doubao",
		name: "豆包 Agent",
		note: "豆包 Agent 模式记忆",
		collectEntries: doubaoEntries,
	},
	{
		id: "antigravity",
		name: "Antigravity",
		note: "Antigravity 的用户记忆",
		collectEntries: antigravityEntries,
	},
	{
		id: "shandianshuo",
		name: "闪电说",
		note: "闪电说的知识 / 经历记忆",
		collectEntries: shandianshuoEntries,
	},
];

/**
 * 只列灰态的 Agent：本机没有可读记忆文件，或只有规则文件、没有记忆模块。
 * 它们不挂 POST 适配器，前端只展示、不可勾选。
 */
const GRAY_SOURCES: ImportSourceInfo[] = [
	{
		id: "gemini-cli",
		name: "Gemini CLI",
		note: "本机只有规则文件，没有记忆条目",
		count: 0,
	},
	{
		id: "cursor",
		name: "Cursor",
		note: "本机只有规则文件，没有记忆条目",
		count: 0,
	},
	{
		id: "windsurf",
		name: "Windsurf",
		note: "本机只有规则文件，没有记忆条目",
		count: 0,
	},
	{
		id: "cline",
		name: "Cline",
		note: "本机只有规则文件，没有记忆条目",
		count: 0,
	},
	{
		id: "lingma",
		name: "通义灵码",
		note: "本机没有可读的记忆文件",
		count: 0,
	},
	{
		id: "marscode",
		name: "豆包 MarsCode",
		note: "本机没有可读的记忆文件",
		count: 0,
	},
	{
		id: "iflow",
		name: "智谱 iFlow",
		note: "本机没有可读的记忆文件",
		count: 0,
	},
	{
		id: "kimi",
		name: "Kimi",
		note: "本机没有可读的记忆文件",
		count: 0,
	},
	{
		id: "zed",
		name: "Zed",
		note: "本机只有 AGENTS.md 规则文件",
		count: 0,
	},
	{
		id: "dsh",
		name: "DSH",
		note: "本机只有 AGENTS.md 规则文件",
		count: 0,
	},
	{
		id: "minimax",
		name: "MiniMax",
		note: "本机只有内置技能文档，没有用户记忆",
		count: 0,
	},
];

/** 按标题分节：每节正文前带【小节标题】，脱离文件也自含。 */
function splitHeadings(body: string): string[] {
	const lines = body.split(/\r?\n/);
	const out: string[] = [];
	let heading = "";
	let buffer: string[] = [];
	const flush = () => {
		const text = buffer.join("\n").trim();
		if (text) out.push(heading ? `【${heading}】\n${text}` : text);
		buffer = [];
	};
	for (const line of lines) {
		const match = /^#{1,3}\s+(.*)$/.exec(line);
		if (match) {
			flush();
			heading = match[1].trim();
			continue;
		}
		buffer.push(line);
	}
	flush();
	return out.length > 0 ? out : [body.trim()].filter(Boolean);
}

/** 索引行：`- [标题](文件) — 摘要`；解析不出就退回整行。 */
function splitIndex(body: string): string[] {
	const lines = body
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	const items = lines.filter((line) => /^[-*]\s+\[/.test(line));
	if (items.length === 0) return [body.trim()].filter(Boolean);
	return items
		.map((line) => {
			const match = /^[-*]\s+\[([^\]]+)\](?:\([^)]*\))?\s*(?:[—–-]\s*)?(.*)$/.exec(line);
			if (!match) return line.replace(/^[-*]\s+/, "");
			const title = match[1].trim().replace(/\.md$/i, "");
			const rest = match[2].trim();
			return rest ? `${title} — ${rest}` : title;
		})
		.filter(Boolean);
}

/** `§` 行分节（awareness 的格式）。 */
function splitSections(body: string): string[] {
	return body.split(/\r?\n/).reduce<string[]>((acc, line) => {
		if (line.trim() === "§") acc.push("");
		else if (acc.length === 0) acc.push(line);
		else acc[acc.length - 1] += `\n${line}`;
		return acc;
	}, []);
}

function isPlaceholder(text: string): boolean {
	const compact = text.replace(/\s+/g, " ").trim();
	if (compact.length < 4) return true;
	return PLACEHOLDER_MARKERS.some((marker) => compact.includes(marker));
}

/** 只有一行标题、没有正文的条目（例如 `# MEMORY.md - 长期记忆`）不是记忆。 */
function isHeadingOnly(text: string): boolean {
	const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	return lines.length === 1 && /^#{1,6}\s+/.test(lines[0] ?? "");
}

/** 解析一个别家的记忆文件。任何单文件异常都只影响这一份。 */
function parseSourceFile(item: SourceFile): SourceEntry[] {
	let raw: string;
	let mtime: string;
	try {
		const stat = statSync(item.file);
		if (stat.size === 0 || stat.size > MAX_SOURCE_BYTES) return [];
		raw = readFileSync(item.file, "utf8");
		mtime = new Date(stat.mtimeMs).toISOString();
	} catch {
		return [];
	}
	const { meta, body } = stripFrontmatter(raw);
	// CodeBuddy 的开关位：enabled: false 是人家自己关掉的条目，导入等于替人翻案
	if (meta["enabled"] === "false") return [];

	const explicit = item.metaKind === false ? null : kindFromMetaOrNull(meta);
	const kind = explicit ?? item.kind;
	const metaTime =
		[meta["updatedat"], meta["metadata.modified"], meta["modified"], meta["date"]]
			.map((value) => {
				const at = Date.parse(value ?? "");
				return Number.isNaN(at) ? null : new Date(at).toISOString();
			})
			.find((value): value is string => Boolean(value)) ?? mtime;
	const created = metaTime ?? mtime;
	const text = body.trim() || (meta["description"] ?? "").trim();
	if (!text) return [];

	const sections =
		item.splitter === "section"
			? splitSections(text)
			: item.splitter === "headings"
				? splitHeadings(text)
				: item.splitter === "index"
					? splitIndex(text)
					: [text];

	return sections
		.map((section) => section.trim())
		.filter((section) => section.length > 0 && !isPlaceholder(section) && !isHeadingOnly(section))
		.map((section) => ({
			text: section,
			kind: classifySourceKind(section, kind, { file: item.file, explicit }),
			createdAt: created,
		}));
}

/** 解析一个来源的全部条目。未知 id 返回 null（调用方 400）。 */
export function collectSourceEntries(id: string, home = homedir()): SourceEntry[] | null {
	const def = SOURCES.find((source) => source.id === id);
	if (!def) return null;
	try {
		if (def.collectEntries) return def.collectEntries(home);
		if (!def.collect) return [];
		const entries: SourceEntry[] = [];
		for (const item of def.collect(home)) {
			for (const entry of parseSourceFile(item)) {
				entries.push({
					...entry,
					...(item.projectLabel ? { projectLabel: item.projectLabel } : {}),
					...(item.projectHint ? { projectHint: item.projectHint } : {}),
				});
			}
		}
		return entries;
	} catch {
		return [];
	}
}

/** GET sources：每个来源报条目数；count=0 = 没检测到（前端灰态）。 */
export function listMemoryImportSources(home = homedir()): ImportSourceInfo[] {
	const parsed = SOURCES.map((def) => ({
		id: def.id,
		name: def.name,
		note: def.note,
		count: (collectSourceEntries(def.id, home) ?? []).length,
	}));
	return [...parsed, ...GRAY_SOURCES];
}

export interface SourceRunResult {
	ok: boolean;
	/** 只在 ok=false 时有：调用方转 HTTP 状态码 */
	status?: 400 | 404 | 503;
	error?: string;
	message?: string;
	added?: number;
	skipped?: number;
	total?: number;
}

/**
 * 项目根路径 → qoder 的 slug 形态（盘符段 + 分隔符换 -，小写）：
 * `<lifediary 手机仓>` → `d-projects-projects-lifediary`。
 * 与 qoder 的项目目录名同一约定，dash 歧义在这个对比下不存在。
 */
function pathToSlug(path: string): string | null {
	const norm = path.replace(/[\\/]+$/, "");
	const drive = /^([A-Za-z]):(.*)$/.exec(norm);
	if (!drive) return null;
	return (drive[1] + drive[2].replace(/[\\/]+/g, "-")).toLowerCase();
}

/** 项目匹配（2026-11-15 项目记忆方案）：slug 精确对比优先，目录名/项目名兜底。 */
export function matchRegisteredProject(hint: { name?: string; slug?: string } | undefined): Project | null {
	if (!hint || (!hint.slug && !hint.name)) return null;
	let projects: Project[];
	try {
		projects = projectsStore().listProjects(true);
	} catch {
		return null; // 项目库读不出来（还没建 / 迁移中）就不匹配，全部走 global 兜底
	}
	if (hint.slug) {
		const bySlug = projects.find((project) => pathToSlug(project.rootPath) === hint.slug);
		if (bySlug) return bySlug;
		const tail = `-${hint.slug.split("-").pop()}`;
		const byTail = projects.find((project) => pathToSlug(project.rootPath)?.endsWith(tail));
		if (byTail) return byTail;
	}
	if (hint.name) {
		const wanted = hint.name.toLowerCase();
		const byName = projects.find(
			(project) =>
				project.name.toLowerCase() === wanted || basename(project.rootPath).toLowerCase() === wanted,
		);
		if (byName) return byName;
	}
	return null;
}

/** POST sources/:id：解析 → 项目匹配 → 按 scope 分组 → importMemory（口径与手工导入一致）。 */
export function runMemoryImportSource(id: string, home = homedir()): SourceRunResult {
	const entries = collectSourceEntries(id, home);
	if (entries === null) {
		return { ok: false, status: 400, error: "bad_request", message: "认不出的来源 id" };
	}
	if (entries.length === 0) {
		return { ok: false, status: 404, error: "not_found", message: "这台机器上没找到这个来源的记忆" };
	}
	// 同一项目标签只匹配一次（几十条同项目的条目不去反复扫项目库）
	const resolved = new Map<string, string | null>();
	const groups = new Map<string, { text: string; kind: string; createdAt?: string; source: string }[]>();
	for (const entry of entries) {
		let scope = "global";
		let text = entry.text;
		if (entry.projectLabel) {
			if (!resolved.has(entry.projectLabel)) {
				const project = matchRegisteredProject(entry.projectHint);
				resolved.set(entry.projectLabel, project ? `project:${project.id}` : null);
			}
			const matched = resolved.get(entry.projectLabel);
			if (matched) {
				scope = matched; // 匹配上登记项目：scope 就是归属，不再带【前缀】
			} else {
				text = `【${entry.projectLabel}】${entry.text}`; // 没登记的项目：global + 前缀兜底
			}
		}
		const list = groups.get(scope) ?? [];
		list.push({ text, kind: entry.kind, ...(entry.createdAt ? { createdAt: entry.createdAt } : {}), source: `import:${id}` });
		groups.set(scope, list);
	}
	let added = 0;
	let skipped = 0;
	let total = 0;
	// 2026-11-15：来源导入把 global 与所有登记项目当成同一个"已有记忆池"去重。
	// 同一句话已经在别的 scope 里存在时不再重复落一份；只影响来源导入，手工导入仍按单 scope。
	const dedupeScopes = ["global"];
	try {
		dedupeScopes.push(...projectsStore().listProjects(true).map((project) => `project:${project.id}`));
	} catch {
		// 项目库读不到时至少把 global 和本次目标 scope 去掉重；不挡导入
	}
	for (const [scope, items] of groups) {
		const result = importMemory(scope, items, { dedupeScopes });
		if (!result.ok) {
			return { ok: false, status: result.status as 400 | 404 | 503, error: result.error, message: result.message };
		}
		added += result.added;
		skipped += result.skipped;
		total += result.total;
	}
	return { ok: true, added, skipped, total };
}
