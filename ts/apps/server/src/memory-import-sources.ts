import { homedir } from "node:os";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { MemoryKind } from "@lifediary/memory";
import { importMemory } from "./memory-consolidate.ts";

/**
 * 记忆导入的**本机来源**（2026-11-15，方案 docs/设计方案/2026-11-15-记忆导入（接入别家AI的记忆）.md）。
 *
 * 别家 AI 在这台机器上已经积累的记忆条目，解析成 {text, kind, createdAt} 交给
 * `importMemory`（2026-11-08 的导入管线：只增不改、规范化等价去重、落库自动打码）。
 * 本模块只补"来源发现 + 解析适配"，不碰记忆四层任何策略。
 *
 * 三条硬口径：
 *  - **路径是白名单常量**：客户端只能报来源 id，不能传路径——否则这就是任意文件读取。
 *    盘点结论（哪些家有货、哪些家刻意不接）见方案文档，这里只登记有货的。
 *  - **只读**：解析绝不写别家的目录。
 *  - **不重复做下游校验**：长度上限、去重、kind 白名单、时间裁剪都在 importMemory，
 *    解析器产什么就交什么，skipped 计数保持单一口径。
 */

/** 来源开关：默认开；`MEMORY_IMPORT_SOURCES=false/0/off` 时两端点 404、按钮不渲染。 */
export function memoryImportSourcesEnabled(): boolean {
	const value = (process.env.MEMORY_IMPORT_SOURCES ?? "").trim().toLowerCase();
	return value !== "false" && value !== "0" && value !== "off";
}

/** 解析器产出：交给 importMemory 的最小形状。 */
export interface SourceEntry {
	text: string;
	kind: MemoryKind;
	/** 文件 mtime / frontmatter 时间；空着则 importMemory 落 now */
	createdAt?: string;
}

export interface ImportSourceInfo {
	id: string;
	name: string;
	note: string;
	/** 条目数；0 = 没检测到（前端灰态） */
	count: number;
}

/** 一份待解析的文件：kind 由来源定义定死，section 表示按 `§` 行分节。 */
interface SourceFile {
	file: string;
	kind: MemoryKind;
	splitter?: "section";
}

/** 来源定义：collect 找文件清单，parse 把文件变成条目。id 同时是 POST 路径参数。 */
interface ImportSourceDef {
	id: string;
	name: string;
	note: string;
	collect(home: string): SourceFile[];
}

/**
 * 剥 YAML frontmatter，返回（meta 键值对, 正文）。只在首行是 `---` 时剥；
 * 没有或残缺就整个当正文——别家的格式残缺不是咱们的错，能拿多少拿多少。
 */
function stripFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
	const lines = raw.split(/\r?\n/);
	if ((lines[0] ?? "").trim() !== "---") {
		return { meta: {}, body: raw };
	}
	const meta: Record<string, string> = {};
	let end = -1;
	for (let i = 1; i < lines.length; i += 1) {
		const line = lines[i];
		if (line.trim() === "---") {
			end = i;
			break;
		}
		const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
		if (m) meta[m[1].toLowerCase()] = m[2].trim().replace(/^["']|["']$/g, "");
	}
	if (end < 0) return { meta: {}, body: raw };
	return { meta, body: lines.slice(end + 1).join("\n") };
}

/** qoder 分类 → kind：用户自己的分类是偏好与爱好，其余是项目事实。 */
function qoderCategoryKind(category: string): MemoryKind {
	return category.startsWith("user_") ? "preference" : "fact";
}

/** Qoder CLI：`~/.qoder/memories/<hash>/global/<分类>/*.md`，projects/ 子树刻意不碰（方案§不接）。 */
function qoderCliCollect(home: string): SourceFile[] {
	const root = join(home, ".qoder", "memories");
	const out: SourceFile[] = [];
	if (!existsSync(root)) return out;
	for (const hash of readdirSync(root, { withFileTypes: true })) {
		const globalDir = join(root, hash.name, "global");
		if (!hash.isDirectory() || !existsSync(globalDir)) continue;
		for (const category of readdirSync(globalDir, { withFileTypes: true })) {
			if (!category.isDirectory()) continue;
			for (const file of readdirSync(join(globalDir, category.name))) {
				if (file.endsWith(".md")) {
					out.push({ file: join(globalDir, category.name, file), kind: qoderCategoryKind(category.name) });
				}
			}
		}
	}
	return out;
}

/** Qoder Work awareness：MEMORY.md（事实）+ USER.md（偏好），条目按 `§` 行分节。 */
function awarenessFiles(home: string, dirName: string): string[] {
	const dir = join(home, dirName, "awareness", "main");
	return ["MEMORY.md", "USER.md"].map((name) => join(dir, name)).filter((f) => existsSync(f));
}

function awarenessCollect(home: string): SourceFile[] {
	// .qoderworkcn 是国行装机的家；.qoderwork 变体同构，存在才收（2026-11-15 本机只有 cn 有货）
	return [
		...awarenessFiles(home, ".qoderworkcn"),
		...awarenessFiles(home, ".qoderwork"),
	].map((file) => ({
		file,
		kind: (file.endsWith("USER.md") ? "preference" : "fact") as MemoryKind,
		splitter: "section" as const,
	}));
}

/** CodeBuddy 全局记忆：`%LOCALAPPDATA%/CodeBuddyExtension/Data/Public/.memories/*.mdc`。 */
function codebuddyCollect(home: string): SourceFile[] {
	const root = join(home, "AppData", "Local", "CodeBuddyExtension", "Data", "Public", ".memories");
	const out: SourceFile[] = [];
	if (!existsSync(root)) return out;
	for (const file of readdirSync(root)) {
		if (file.endsWith(".mdc") && !file.startsWith(".")) {
			out.push({ file: join(root, file), kind: "fact" });
		}
	}
	return out;
}

const SOURCES: ImportSourceDef[] = [
	{
		id: "qoder-cli",
		name: "Qoder CLI",
		note: "Qoder 命令行工具在项目之外记下的偏好与事实",
		collect: qoderCliCollect,
	},
	{
		id: "qoder-awareness",
		name: "Qoder Work（感知记忆）",
		note: "Qoder Work 的 MEMORY.md / USER.md：跨项目的偏好与约定",
		collect: awarenessCollect,
	},
	{
		id: "codebuddy",
		name: "CodeBuddy",
		note: "CodeBuddy 的全局记忆条目",
		collect: codebuddyCollect,
	},
];

/** 解析一个别家的记忆文件。`section` = 按 `§` 行分节（Qoder awareness 的格式）。 */
function parseSourceFile(file: string, kind: MemoryKind, splitter?: "section"): SourceEntry[] {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return []; // 读不到就跳过：导入是尽力而为，别让一个锁着的文件拖死整批
	}
	const at = new Date(statSync(file).mtimeMs).toISOString();
	const { meta, body } = stripFrontmatter(raw);
	// CodeBuddy 的开关位：enabled: false 是人家自己关掉的条目，导入等于替人翻案
	if (meta["enabled"] === "false") return [];
	const frontAt = Date.parse(meta["updatedat"] ?? "");
	const createdAt = Number.isNaN(frontAt) ? at : new Date(frontAt).toISOString();

	const sections = splitter === "section"
		? body.split(/\r?\n/).reduce<string[]>((acc, line) => {
				if (line.trim() === "§") acc.push("");
				else if (acc.length === 0) acc.push(line);
				else acc[acc.length - 1] += `\n${line}`;
				return acc;
			}, [])
		: [body];

	return sections
		.map((section) => section.trim())
		.filter((text) => text.length > 0)
		.map((text) => ({ text, kind, createdAt }));
}

/** 解析一个来源的全部条目。未知 id 返回 null（调用方 400）。 */
export function collectSourceEntries(id: string, home = homedir()): SourceEntry[] | null {
	const def = SOURCES.find((source) => source.id === id);
	if (!def) return null;
	const entries: SourceEntry[] = [];
	for (const item of def.collect(home)) {
		entries.push(...parseSourceFile(item.file, item.kind, item.splitter));
	}
	return entries;
}

/** GET sources：每个来源报条目数；count=0 = 没检测到（前端灰态）。 */
export function listMemoryImportSources(home = homedir()): ImportSourceInfo[] {
	return SOURCES.map((def) => ({
		id: def.id,
		name: def.name,
		note: def.note,
		count: (collectSourceEntries(def.id, home) ?? []).length,
	}));
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

/** POST sources/:id：解析 → importMemory（scope=global），口径与手工导入完全一致。 */
export function runMemoryImportSource(id: string, home = homedir()): SourceRunResult {
	const entries = collectSourceEntries(id, home);
	if (entries === null) {
		return { ok: false, status: 400, error: "bad_request", message: "认不出的来源 id" };
	}
	if (entries.length === 0) {
		return { ok: false, status: 404, error: "not_found", message: "这台机器上没找到这个来源的记忆" };
	}
	const result = importMemory("global", entries);
	if (!result.ok) {
		return { ok: false, status: result.status as 400 | 404 | 503, error: result.error, message: result.message };
	}
	return { ok: true, added: result.added, skipped: result.skipped, total: result.total };
}
