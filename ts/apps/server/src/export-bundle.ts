import { createHash } from "node:crypto";
import type { MemoryRecord } from "@lifediary/memory";
import {
	listChatsForExport,
	memoryEngine,
	openChat,
	readTranscript,
	usageSummary,
	type ChatIndexEntry,
	type TranscriptMessage,
} from "./agent.ts";
import { diaryStore } from "./diary.ts";
import { listFlags } from "./flags.ts";
import { COMPANIONS_ENABLED, partnersStore } from "./partners.ts";
import { projectsStore } from "./projects.ts";
import { modelCatalog, readLlmConfig } from "./provider.ts";
import { topicsStore } from "./topics.ts";
import { buildZip, type ZipEntry } from "./zip.ts";

/**
 * 导出数据打包（2026-11-13）。
 *
 * 老形态是一个巨大 JSON（`format=json`，仍原样保留）；这里做的是 `format=zip`：
 * 按用户勾选的块分别收集，落成"一会话一文件夹 + 记忆/内容/团队/配置四类目录"，
 * 根上再放 `README.md`（人读）与 `manifest.json`（机读，逐块记条数/上限/失败原因）。
 *
 * 三条口径（与批 20 立的「状态如实」一致）：
 *   - 少了什么都写下来：归档会话算进来、任务专线/提醒/密钥明确列在 excluded；
 *   - 截断要标：单会话消息上限、记忆每作用域上限都进 manifest 与 README；
 *   - 逐块隔离：一块读失败只标 failed，其余照常出包，整体状态靠 X-Export-Partial 曝光。
 *
 * 仍然是**一次性响应体、不落服务端磁盘**：选保存位置由壳或浏览器负责。
 */

export const EXPORT_PART_IDS = ["conversations", "memory", "library", "team", "config"] as const;
export type ExportPartId = (typeof EXPORT_PART_IDS)[number];

export const EXPORT_PART_LABELS: Record<ExportPartId, string> = {
	conversations: "会话与消息",
	memory: "记忆",
	library: "内容（项目/课题/日记/例行）",
	team: "团队（执事/群组）",
	config: "配置与用量",
};

/** 单会话最多导多少条消息（老 JSON 也是 500；现在会把"被截了"写进 manifest）。 */
export const EXPORT_MESSAGE_LIMIT = 500;
/** 记忆每个作用域最多导多少条（store 单次检索的硬顶是 2000）。 */
export const MEMORY_SCOPE_LIMIT = 2000;
/** 未压缩总字节上限；超了直接 413，不悄悄丢数据。 */
export const EXPORT_MAX_BYTES = (() => {
	const raw = Number(process.env.EXPORT_MAX_BYTES ?? 0);
	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 256 * 1024 * 1024;
})();

/** 回滚开关：默认开，只有显式 false 才关（关 = zip 404，json 形态不动）。 */
export function exportBundleEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return (env.EXPORT_BUNDLE ?? "").trim().toLowerCase() !== "false";
}

// ── 参数解析（非法一律 null，端点回 400）──────────────────

/** `parts=a,b`：缺省 = 全选；未知值 / 空值 / 重复 → null。 */
export function parseExportParts(raw: string | undefined): ExportPartId[] | null {
	if (raw === undefined) return [...EXPORT_PART_IDS];
	const seen = new Set<ExportPartId>();
	for (const piece of raw.split(",")) {
		const id = piece.trim();
		if (!id) return null;
		if (!(EXPORT_PART_IDS as readonly string[]).includes(id)) return null;
		if (seen.has(id as ExportPartId)) return null;
		seen.add(id as ExportPartId);
	}
	return seen.size > 0 ? [...EXPORT_PART_IDS].filter((id) => seen.has(id)) : null;
}

/** `images=0|1`：缺省 true；别的值 → null。 */
export function parseExportImages(raw: string | undefined): boolean | null {
	if (raw === undefined) return true;
	const value = raw.trim();
	if (value === "1") return true;
	if (value === "0") return false;
	return null;
}

// ── 时间 / 文件名 ────────────────────────────────────────

const pad = (value: number): string => String(value).padStart(2, "0");

/** 本地时间戳（人读用）：`2026-11-13 14:30`。 */
export function localStamp(value: number | string, withSeconds = false): string {
	const date = typeof value === "string" ? new Date(value) : new Date(value);
	if (Number.isNaN(date.getTime())) return "";
	const head = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
	return withSeconds ? `${head}:${pad(date.getSeconds())}` : head;
}

/** 文件名 / 目录名用的时间戳：`2026-11-13-1430`。 */
export function exportStamp(at: Date): string {
	return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`;
}

/** ISO 8601（UTC）；空值 / 非法时间给 null，不编造。 */
export function isoOrNull(value: number | string | null | undefined): string | null {
	if (value === null || value === undefined) return null;
	const date = typeof value === "number" ? new Date(value) : new Date(value);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * 标题 → 目录名的一段。中文保留，去掉文件系统不认的字符与控制符，
 * 折成单段、截 40 字（按 code point，不把 emoji 劈成两半）。
 */
export function slugifyTitle(title: string): string {
	const cleaned = Array.from(title.normalize("NFKC"))
		.map((char) => {
			if (/[\u0000-\u001f\u007f]/.test(char)) return "";
			if (/[\\/:*?"<>|]/.test(char)) return "";
			if (/\s/.test(char)) return "-";
			return char;
		})
		.join("")
		.replace(/-+/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "");
	return Array.from(cleaned).slice(0, 40).join("") || "chat";
}

// ── 结构 ────────────────────────────────────────────────

export interface BundleFile {
	/** 包内相对路径（用 `/`），根目录前缀由 compose 统一加 */
	path: string;
	text?: string;
	bytes?: Buffer;
	/** false = STORE（图片等已压缩内容） */
	compress?: boolean;
}

export type BundlePartStatus = "ok" | "empty" | "failed";

export interface BundlePart {
	id: ExportPartId;
	label: string;
	status: BundlePartStatus;
	files: BundleFile[];
	counts: Record<string, number>;
	limits?: Record<string, unknown>;
	notes: string[];
	/** 失败时的一句原因（不含对话正文） */
	error?: string;
}

export interface BundleBuildResult {
	buffer: Buffer;
	fileName: string;
	files: number;
	/** 未压缩字节数 */
	bytes: number;
	manifest: Record<string, unknown>;
	readme: string;
	partial: boolean;
}

function fileBytes(file: BundleFile): number {
	return file.bytes ? file.bytes.length : Buffer.byteLength(file.text ?? "", "utf8");
}

// ── 渲染（纯函数，单测直接钉）────────────────────────────

/** 消息进 `messages.json` 的形状：时间统一 ISO，图片只留文件引用。 */
export interface ExportMessageImage {
	mimeType: string;
	/** 没带图片文件时（`images=0`）没有它 */
	path?: string;
	bytes: number;
	sha256: string;
}

export interface ExportMessage {
	role: "user" | "assistant";
	at: string | null;
	text: string;
	id?: string;
	images?: ExportMessageImage[];
	/** 用户消息带的文件（2026-11-13 附件走路径）：只有路径，没有内容 */
	files?: { path: string; name: string; mimeType?: string; bytes?: number }[];
	steps?: TranscriptMessage["steps"];
	workMs?: number;
}

/** `messages.json`：单会话自包含（不依赖 index.json 也能读）。 */
export function renderMessagesJson(
	entry: ChatIndexEntry,
	dir: string,
	messages: ExportMessage[],
	truncated: boolean,
): string {
	return `${JSON.stringify(
		{
			id: entry.conversationId,
			title: chatTitleOf(entry),
			chatKind: entry.chatKind,
			createdAt: isoOrNull(entry.createdAt),
			lastAt: isoOrNull(entry.lastAt),
			turns: entry.turns,
			pinned: Boolean(entry.pinned),
			archived: Boolean(entry.archived),
			archivedAt: isoOrNull(entry.archivedAt ?? null),
			project: projectOf(entry),
			dir,
			truncated,
			messages,
		},
		null,
		2,
	)}\n`;
}

export function chatTitleOf(entry: ChatIndexEntry): string {
	const title = (entry.title ?? "").trim() || (entry.firstText ?? "").trim();
	return title || "未命名会话";
}

function projectOf(entry: ChatIndexEntry): { id: string; name: string } | null {
	return entry.projectId && entry.projectName
		? { id: entry.projectId, name: entry.projectName }
		: null;
}

/**
 * `transcript.md`：给人看的那一份。
 *
 * 不重复 `messages.json` 的全部内容：步骤只留"名字 + 耗时"，不留工具输出全文
 * （输出里可能是被读过的文件正文，几百 KB 会把可读性彻底埋掉）。
 * 图片用相对路径引用，解压后直接能点开。
 */
export function renderTranscriptMarkdown(
	entry: ChatIndexEntry,
	messages: ExportMessage[],
	truncated: boolean,
): string {
	const head = [
		`# ${chatTitleOf(entry)}`,
		"",
		`- 会话 id：\`${entry.conversationId}\``,
		`- 时间：${localStamp(entry.createdAt)} — ${localStamp(entry.lastAt)}`,
		`- 轮数：${entry.turns}　条数：${messages.length}${truncated ? `（只保留最近 ${EXPORT_MESSAGE_LIMIT} 条，更早的没进来）` : ""}`,
		entry.archived ? `- 状态：已归档（${localStamp(entry.archivedAt ?? entry.lastAt)}）` : "- 状态：活跃",
		projectOf(entry) ? `- 项目：${projectOf(entry)!.name}` : "",
		"",
	];
	const body: string[] = [];
	for (const message of messages) {
		const who = message.role === "user" ? "你" : "助手";
		body.push(`## ${who} · ${message.at ? localStamp(message.at) : "时间未知"}`, "");
		if (message.text.trim()) body.push(message.text.trim(), "");
		for (const image of message.images ?? []) {
			body.push(image.path ? `![图片](${image.path})` : `（图片 ${image.mimeType}，${image.bytes} 字节，本次未导出文件）`, "");
		}
		for (const file of message.files ?? []) {
			body.push(`（附件 ${file.name}：\`${file.path}\`，只记路径，未复制文件）`, "");
		}
		const steps = (message.steps ?? []).filter((step) => step.name !== "say");
		if (steps.length > 0) {
			const line = steps
				.map((step) => `${step.name}${step.ok ? "" : "（失败）"}${step.ms !== undefined ? ` ${Math.round(step.ms / 1000 * 10) / 10}s` : ""}`)
				.join(" · ");
			body.push(`> 工具：${line}`, "");
		}
	}
	return `${head.filter((line) => line !== undefined).join("\n")}\n${body.join("\n")}`.trimEnd() + "\n";
}

function escapeCell(text: string): string {
	return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/**
 * `README.md`：包根上的那一页。先讲"这是什么"，再逐块讲状态，
 * 最后讲"刻意没带什么 / 这不是备份"，避免半年后自己都认不出这份包。
 */
export function renderReadme(
	parts: readonly BundlePart[],
	meta: { exportedAt: Date; files: number; bytes: number; images: boolean | null },
): string {
	const statusText: Record<BundlePartStatus, string> = {
		ok: "已导出",
		empty: "没有数据",
		failed: "失败",
	};
	const rows = parts.map(
		(part) =>
			`| ${part.label} | ${statusText[part.status]} | ${part.files.length} | ${part.counts["items"] ?? part.counts["messages"] ?? part.counts["records"] ?? "-"} | ${escapeCell(part.notes.concat(part.error ? [`失败原因：${part.error}`] : []).join("；") || "-")} |`,
	);
	return `# 导出说明

- 导出时间：${localStamp(meta.exportedAt.getTime(), true)}（本机时间）
- 文件数：${meta.files}　解开后约 ${formatBytes(meta.bytes)}
- 图片：${meta.images === null ? "这次没选会话块" : meta.images ? "已带上（在各自会话的 images/ 里）" : "按你的选择没有带"}

## 这份包怎么读

- **人读**：打开 \`conversations/<日期>-<标题>-<id>/transcript.md\`，就是那段对话的正文；
  \`README.md\` 就是你现在看的这页。
- **程序读**：\`manifest.json\` 是清单（每块多少条、哪块失败、哪里被截断）；
  \`*.jsonl\` 一行一条（记忆 / 日记 / 群消息），\`*.json\` 是整份结构。
- **时间口径**：JSON 里是 ISO 8601（UTC），正文（md）里是本机时间。
- **图片**：\`messages.json\` 里只存文件引用（\`path\` + \`sha256\`），真实图片在
  同一目录的 \`images/\` 下。

## 这次导出了什么

| 块 | 状态 | 文件 | 条数 | 备注 |
|---|---|---|---|---|
${rows.join("\n")}

## 刻意没有带的

- **任务专线会话**（\`task-\` 开头的那些）：首句是机器指令，不是你说过的话，侧栏里本来也不列。
- **供应商密钥、配对码、设备令牌、服务端日志**：这些不该躺在压缩包里。
- **提醒（reminder）**：那是运行中的排程，会随执行自然结束，不当档案。
- **记忆没有排除任何作用域**：按作用域全量导出，含被取代的旧记录（保留演化链）。

## 这不是备份

这份包是"存档 + 可以给程序读"，**不是可一键恢复的备份格式**：图片是独立文件、
群消息是 jsonl、时间做了 ISO 化。要恢复得另做导入器（本版没做）。

## 发出去之前想一想

包里没有密钥，但**有你的全部对话正文、记忆、执事设定，以及项目工作区的本机路径**。
要发给别人（比如让另一个 AI 接着聊），先只勾需要的块，别整包发。

## 被截断的地方

- 单个会话最多 ${EXPORT_MESSAGE_LIMIT} 条消息（取最近的那些）；\`manifest.json\` 里
  \`counts.truncatedChats\` 与每个会话的 \`truncated\` 都标了。
- 记忆每个作用域最多 ${MEMORY_SCOPE_LIMIT} 条；超了看 \`memory/index.json\` 的 \`truncated\`。
- 工具步骤的输出在上游就按 2000 字符截断（\`limits.stepOutputChars\`），历史里看到多长，包里就多长。
`;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ── 拼包（纯：给一组块结果 → zip + 清单 + 说明）──────────

/**
 * 把各块的产出拼成最终包。
 *
 * 单独拆出来是为了能单测：不给真实数据库、只喂几条假块结果，
 * 就能验清单形状、README 表格、文件名与 zip 合法性。
 */
export function composeBundle(
	parts: readonly BundlePart[],
	at: Date = new Date(),
): BundleBuildResult {
	const root = `selenite-export-${exportStamp(at)}`;
	const exportedAt = at.toISOString();
	const totalFiles = parts.reduce((sum, part) => sum + part.files.length, 0);
	const totalBytes = parts.reduce(
		(sum, part) => sum + part.files.reduce((inner, file) => inner + fileBytes(file), 0),
		0,
	);
	const conversationPart = parts.find((part) => part.id === "conversations");
	const images: boolean | null = conversationPart
		? conversationPart.limits?.["images"] === true
		: null;

	const readme = renderReadme(parts, { exportedAt: at, files: totalFiles + 2, bytes: totalBytes, images });
	const manifest = {
		format: "lifediary-export",
		formatVersion: 1,
		exportedAt,
		root,
		parts: parts.map((part) => ({
			id: part.id,
			label: part.label,
			status: part.status,
			files: part.files.length,
			bytes: part.files.reduce((sum, file) => sum + fileBytes(file), 0),
			counts: part.counts,
			...(part.limits ? { limits: part.limits } : {}),
			notes: part.notes,
			...(part.error ? { error: part.error } : {}),
		})),
		totals: { files: totalFiles + 2, bytes: totalBytes },
		limits: {
			messagesPerChat: EXPORT_MESSAGE_LIMIT,
			memoryPerScope: MEMORY_SCOPE_LIMIT,
			stepOutputChars: 2000,
		},
		excluded: [
			{ what: "任务专线会话（task- 前缀）", why: "首句是机器指令，不是用户说过的话（与侧栏口径一致）" },
			{ what: "供应商密钥 / 配对码 / 设备令牌 / 服务端日志", why: "不该随档案外流" },
			{ what: "提醒（reminder）", why: "运行中的排程，不是档案" },
			{ what: "课题的待确认提案", why: "只是还没接受的卡片，48 小时后自然过期" },
		],
		redactions: ["provider keyEnv 之外的任何密钥值", "配对码", "设备令牌", "日志"],
	};

	const entries: ZipEntry[] = parts.flatMap((part) =>
		part.files.map((file) => ({
			name: `${root}/${file.path}`,
			data: file.bytes ?? file.text ?? "",
			// 文本压缩；二进制（图片 / 头像）默认 STORE，只有显式要压的才压
			compress: file.bytes ? file.compress === true : true,
		})),
	);
	entries.push({ name: `${root}/README.md`, data: readme });
	entries.push({ name: `${root}/manifest.json`, data: `${JSON.stringify(manifest, null, 2)}\n` });

	return {
		buffer: buildZip(entries, at),
		fileName: `${root}.zip`,
		files: entries.length,
		bytes: entries.reduce(
			(sum, entry) =>
				sum +
				(typeof entry.data === "string" ? Buffer.byteLength(entry.data, "utf8") : entry.data.length),
			0,
		),
		manifest,
		readme,
		partial: parts.some((part) => part.status === "failed"),
	};
}

// ── 采集 ────────────────────────────────────────────────

function shortError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}

function emptyPart(id: ExportPartId, note: string): BundlePart {
	return {
		id,
		label: EXPORT_PART_LABELS[id],
		status: "empty",
		files: [],
		counts: {},
		notes: [note],
	};
}

function jsonFile(path: string, value: unknown): BundleFile {
	return { path, text: `${JSON.stringify(value, null, 2)}\n` };
}

function jsonlFile(path: string, rows: readonly unknown[]): BundleFile {
	return {
		path,
		text: rows.length === 0 ? "" : `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
	};
}

function imageExtension(mimeType: string): string {
	const base = mimeType.toLowerCase().split(";")[0]!.trim();
	if (base === "image/png") return "png";
	if (base === "image/jpeg" || base === "image/jpg") return "jpg";
	if (base === "image/webp") return "webp";
	if (base === "image/gif") return "gif";
	if (base === "image/heic") return "heic";
	return "bin";
}

function decodeBase64(data: string): Buffer {
	const clean = data.includes(",") && data.startsWith("data:") ? data.slice(data.indexOf(",") + 1) : data;
	return Buffer.from(clean, "base64");
}

/** 会话块：含归档会话；任务专线仍然排除（与侧栏口径一致）。 */
async function collectConversations(withImages: boolean): Promise<BundlePart> {
	const chats = await listChatsForExport();
	if (!readLlmConfig()) {
		return emptyPart("conversations", "模型没配置，durable 会话读不出来（配好模型后再导）");
	}
	const files: BundleFile[] = [];
	const index: Record<string, unknown>[] = [];
	const counts = { conversations: 0, messages: 0, images: 0, archived: 0, truncatedChats: 0, failedChats: 0 };
	const notes: string[] = [];
	const usedDirs = new Set<string>();

	for (const entry of chats) {
		try {
			const resolved = await openChat(entry.conversationId);
			if (!resolved) throw new Error("会话打不开");
			const raw = await readTranscript(resolved, EXPORT_MESSAGE_LIMIT + 1);
			const truncated = raw.length > EXPORT_MESSAGE_LIMIT;
			const messages = truncated ? raw.slice(-EXPORT_MESSAGE_LIMIT) : raw;

			const dir = uniqueDir(chatDirName(entry), usedDirs);
			/** 包内路径（zip 里的相对路径），index 与 messages.json 用同一份 */
			const dirPath = `conversations/${dir}`;
			const chatFiles: BundleFile[] = [];
			const exported: ExportMessage[] = [];
			let imageSeq = 0;

			for (const message of messages) {
				const images: ExportMessageImage[] = [];
				for (const image of message.images ?? []) {
					const bytes = decodeBase64(image.data);
					const sha256 = createHash("sha256").update(bytes).digest("hex");
					imageSeq += 1;
					const base = `${String(imageSeq).padStart(4, "0")}-${sha256.slice(0, 8)}.${imageExtension(image.mimeType)}`;
					if (withImages) {
						chatFiles.push({ path: `${dirPath}/images/${base}`, bytes, compress: false });
						images.push({ mimeType: image.mimeType, path: `images/${base}`, bytes: bytes.length, sha256 });
						counts.images += 1;
					} else {
						images.push({ mimeType: image.mimeType, bytes: bytes.length, sha256 });
					}
				}
				exported.push({
					role: message.role,
					at: isoOrNull(message.at || null),
					text: message.text,
					...(message.id ? { id: message.id } : {}),
					...(images.length > 0 ? { images } : {}),
					...(message.files && message.files.length > 0 ? { files: message.files } : {}),
					...(message.steps ? { steps: message.steps } : {}),
					...(message.workMs !== undefined ? { workMs: message.workMs } : {}),
				});
			}

			chatFiles.push({ path: `${dirPath}/messages.json`, text: renderMessagesJson(entry, dirPath, exported, truncated) });
			chatFiles.push({ path: `${dirPath}/transcript.md`, text: renderTranscriptMarkdown(entry, exported, truncated) });
			files.push(...chatFiles);

			counts.conversations += 1;
			counts.messages += exported.length;
			if (entry.archived) counts.archived += 1;
			if (truncated) counts.truncatedChats += 1;
			index.push({
				id: entry.conversationId,
				title: chatTitleOf(entry),
				chatKind: entry.chatKind,
				createdAt: isoOrNull(entry.createdAt),
				lastAt: isoOrNull(entry.lastAt),
				turns: entry.turns,
				pinned: Boolean(entry.pinned),
				archived: Boolean(entry.archived),
				archivedAt: isoOrNull(entry.archivedAt ?? null),
				project: projectOf(entry),
				dir: dirPath,
				messages: exported.length,
				truncated,
				images: exported.reduce((sum, message) => sum + (message.images?.filter((one) => one.path).length ?? 0), 0),
			});
		} catch (error) {
			counts.failedChats += 1;
			notes.push(`会话 ${entry.conversationId} 没导出：${shortError(error)}`);
		}
	}

	if (chats.length === 0) return emptyPart("conversations", "还没有会话");

	files.push(
		jsonFile("conversations/index.json", {
			total: counts.conversations,
			archived: counts.archived,
			entries: index,
		}),
	);
	if (counts.conversations === 0 && counts.failedChats > 0) {
		return {
			id: "conversations",
			label: EXPORT_PART_LABELS.conversations,
			status: "failed",
			files,
			counts,
			limits: { messagesPerChat: EXPORT_MESSAGE_LIMIT, images: withImages },
			notes,
			error: `${counts.failedChats} 段会话都读不出来`,
		};
	}
	return {
		id: "conversations",
		label: EXPORT_PART_LABELS.conversations,
		status: "ok",
		files,
		counts,
		limits: { messagesPerChat: EXPORT_MESSAGE_LIMIT, images: withImages },
		notes,
	};
}

/** 目录名：日期 + 标题 + id 前 8 位；重名追加 -2、-3。 */
function chatDirName(entry: ChatIndexEntry): string {
	const date = localStamp(entry.createdAt).slice(0, 10) || "0000-00-00";
	return `${date}-${slugifyTitle(chatTitleOf(entry))}-${entry.conversationId.slice(0, 8)}`;
}

function uniqueDir(base: string, used: Set<string>): string {
	let candidate = base;
	let index = 2;
	while (used.has(candidate)) {
		candidate = `${base}-${index}`;
		index += 1;
	}
	used.add(candidate);
	return candidate;
}

/** 记忆块：按作用域全量（含被取代的记录，保留演化链）。 */
function collectMemory(): BundlePart {
	if (!memoryEngine) {
		return emptyPart("memory", "记忆没启用（MEMORY_ENABLED=false）");
	}
	const stats = memoryEngine.stats();
	const byScope: Record<string, number> = {};
	const byKind: Record<string, number> = {};
	const rows: MemoryRecord[] = [];

	for (const scope of Object.keys(stats.byScope).sort()) {
		const records = memoryEngine.list({ scopes: [scope], limit: MEMORY_SCOPE_LIMIT, includeSuperseded: true });
		byScope[scope] = records.length;
		for (const record of records) {
			byKind[record.kind] = (byKind[record.kind] ?? 0) + 1;
			rows.push(record);
		}
	}

	const exported = rows.length;
	const truncated = stats.total > exported;
	const files: BundleFile[] = [
		jsonlFile("memory/records.jsonl", rows),
		jsonFile("memory/index.json", {
			total: stats.total,
			exported,
			truncated,
			byScope,
			byKind,
		}),
	];
	return {
		id: "memory",
		label: EXPORT_PART_LABELS.memory,
		status: exported > 0 ? "ok" : "empty",
		files,
		counts: { records: exported, scopes: Object.keys(byScope).length },
		limits: { perScope: MEMORY_SCOPE_LIMIT },
		notes: truncated ? [`记忆共 ${stats.total} 条，导出 ${exported} 条（每作用域上限 ${MEMORY_SCOPE_LIMIT}）`] : [],
	};
}

/** 内容块：项目 / 课题 / 日记 / 例行。 */
function collectLibrary(): BundlePart {
	const files: BundleFile[] = [];
	const counts: Record<string, number> = {};
	const notes: string[] = [];

	try {
		const store = projectsStore();
		const projects = store.listProjects(true);
		files.push(
			jsonFile("library/projects.json", {
				workspace: store.getWorkspace(),
				projects,
				proposals: store.listProposals("all"),
			}),
		);
		counts.projects = projects.length;
	} catch (error) {
		notes.push(`项目库读失败：${shortError(error)}`);
	}

	try {
		const topics = topicsStore().list();
		files.push(jsonFile("library/topics.json", { topics }));
		counts.topics = topics.length;
	} catch (error) {
		notes.push(`课题读失败：${shortError(error)}`);
	}

	try {
		const diary = diaryStore();
		const total = diary.count();
		const entries = diary.list(total + 1);
		files.push(jsonlFile("library/diary.jsonl", entries));
		counts.diary = entries.length;
	} catch (error) {
		notes.push(`日记读失败：${shortError(error)}`);
	}

	try {
		const routines = partnersStore().listRoutines();
		files.push(jsonFile("library/routines.json", { routines }));
		counts.routines = routines.length;
	} catch (error) {
		notes.push(`例行读失败：${shortError(error)}`);
	}

	const hasAny = (counts.projects ?? 0) + (counts.topics ?? 0) + (counts.diary ?? 0) + (counts.routines ?? 0) > 0;
	return {
		id: "library",
		label: EXPORT_PART_LABELS.library,
		status: hasAny ? "ok" : "empty",
		files,
		counts,
		notes,
	};
}

/** 团队块：名册 / 群 / 群消息 / SOUL / 契约 / 头像。 */
function collectTeam(): BundlePart {
	if (!COMPANIONS_ENABLED) return emptyPart("team", "执事没启用（COMPANIONS_ENABLED=false）");

	const store = partnersStore();
	const partners = store.list();
	const files: BundleFile[] = [];
	const counts: Record<string, number> = { partners: partners.length };
	const notes: string[] = [];

	const roster: Record<string, unknown>[] = [];
	/** partnerId → 头像在包里的路径（群成员复用同一份，不重复落文件） */
	const avatarPaths = new Map<string, string>();
	for (const partner of partners) {
		let avatarPath: string | null = null;
		if (partner.avatar) {
			const match = /^data:([^;,]+);base64,(.*)$/.exec(partner.avatar);
			if (match) {
				const bytes = decodeBase64(match[2]!);
				const ext = imageExtension(match[1]!);
				avatarPath = `team/avatars/${partner.id}.${ext}`;
				files.push({ path: avatarPath, bytes, compress: false });
				avatarPaths.set(partner.id, avatarPath);
			}
		}
		const soul = store.readSoulFromHome(partner.id);
		if (soul) files.push({ path: `team/souls/${partner.id}.md`, text: soul });
		const contract = store.readContractFromHome(partner.id);
		if (contract) files.push({ path: `team/contracts/${partner.id}.md`, text: contract });
		roster.push({
			id: partner.id,
			name: partner.name,
			status: partner.status,
			currentVersion: partner.currentVersion,
			domain: partner.domain,
			dispatchAuthority: partner.dispatchAuthority,
			currentGoal: partner.currentGoal,
			tagline: partner.tagline,
			diary: partner.diary,
			createdAt: partner.createdAt,
			updatedAt: partner.updatedAt,
			avatarPath,
			soulPath: soul ? `team/souls/${partner.id}.md` : null,
			contractPath: contract ? `team/contracts/${partner.id}.md` : null,
		});
	}
	files.push(jsonFile("team/partners.json", { partners: roster }));

	const groups = store.listGroups();
	counts.groups = groups.length;
	files.push(
		jsonFile(
			"team/groups.json",
			{
				groups: groups.map((group) => ({
					id: group.id,
					name: group.name,
					notice: group.notice,
					responderKind: group.responderKind,
					responderPartnerId: group.responderPartnerId,
					createdAt: group.createdAt,
					updatedAt: group.updatedAt,
					members: group.members.map((member) => ({
						partnerId: member.partnerId,
						name: member.name,
						position: member.position,
						status: member.status,
						domain: member.domain,
						avatarPath: avatarPaths.get(member.partnerId) ?? null,
					})),
				})),
			},
		),
	);

	const messages: unknown[] = [];
	for (const group of groups) {
		let cursor = 0;
		// 每页 500（store 的硬顶），翻到没有新行为止
		for (;;) {
			const page = store.listGroupMessages(group.id, { afterSeq: cursor, limit: 500 });
			if (page.length === 0) break;
			for (const message of page) {
				// 行里本来就带 groupId（群消息表主键含它），不重复拼
				messages.push(message);
			}
			cursor = page[page.length - 1]!.seq;
			if (page.length < 500) break;
		}
	}
	counts.groupMessages = messages.length;
	files.push(jsonlFile("team/group-messages.jsonl", messages));

	const hasAny = partners.length > 0 || groups.length > 0;
	return {
		id: "team",
		label: EXPORT_PART_LABELS.team,
		status: hasAny ? "ok" : "empty",
		files,
		counts,
		notes,
	};
}

/** 配置块：供应商投影 / 模型选择 / 用量 / 开关现值。 */
async function collectConfig(): Promise<BundlePart> {
	const files: BundleFile[] = [];
	const counts: Record<string, number> = {};
	const notes: string[] = [];

	try {
		const catalog = modelCatalog();
		files.push(jsonFile("config/providers.json", catalog));
		counts.providers = catalog.providers.length;
	} catch (error) {
		notes.push(`供应商目录读失败：${shortError(error)}`);
	}

	try {
		const usage = readLlmConfig() ? await usageSummary() : { models: [] };
		files.push(jsonFile("config/usage.json", usage));
		counts.models = usage.models.length;
	} catch (error) {
		notes.push(`用量读失败：${shortError(error)}`);
	}

	try {
		const flags = listFlags();
		files.push(jsonFile("config/flags.json", flags));
		counts.flags = flags.flags.length;
	} catch (error) {
		notes.push(`开关读失败：${shortError(error)}`);
	}

	return {
		id: "config",
		label: EXPORT_PART_LABELS.config,
		status: "ok",
		files,
		counts,
		notes,
	};
}

const COLLECTORS: Record<ExportPartId, (withImages: boolean) => Promise<BundlePart> | BundlePart> = {
	conversations: (withImages) => collectConversations(withImages),
	memory: () => collectMemory(),
	library: () => collectLibrary(),
	team: () => collectTeam(),
	config: () => collectConfig(),
};

export class ExportTooLargeError extends Error {}

/**
 * 采集 + 拼包。端点只负责参数解析、头与响应。
 * 逐块隔离：一块抛错 → 该块 `failed`（带一句原因），其余继续。
 */
export async function buildExportBundle(options: {
	parts: readonly ExportPartId[];
	images: boolean;
	now?: Date;
}): Promise<BundleBuildResult> {
	const at = options.now ?? new Date();
	const parts: BundlePart[] = [];

	for (const id of options.parts) {
		try {
			parts.push(await COLLECTORS[id](options.images));
		} catch (error) {
			parts.push({
				id,
				label: EXPORT_PART_LABELS[id],
				status: "failed",
				files: [],
				counts: {},
				notes: [],
				error: shortError(error),
			});
		}
	}

	const result = composeBundle(parts, at);
	if (result.bytes > EXPORT_MAX_BYTES) {
		throw new ExportTooLargeError(
			`导出内容约 ${formatBytes(result.bytes)}，超过上限 ${formatBytes(EXPORT_MAX_BYTES)}；` +
				"可以关掉图片再试（parts 里去掉会话也行）",
		);
	}
	return result;
}
