/**
 * export-bundle-compose-bundle
 *
 * 2026-11-14 从 export-bundle.ts 的 L35–L474 整段切出；正文原文搬运，未改一行实现。
 * 内含：EXPORT_PART_IDS / ExportPartId / EXPORT_PART_LABELS / EXPORT_MESSAGE_LIMIT …
 */

import type { ChatIndexEntry, TranscriptMessage } from "./agent.ts";
import type { ZipEntry } from "./zip.ts";
import { buildZip } from "./zip.ts";
import { flagEnabled } from "./flags.ts";

export const EXPORT_PART_IDS = ["conversations", "memory", "library", "team", "config"] as const;

export type ExportPartId = (typeof EXPORT_PART_IDS)[number];

export const EXPORT_PART_LABELS: Record<ExportPartId, string> = {
	conversations: "会话与消息",
	memory: "记忆",
	library: "内容（项目/课题/日记/例行）",
	team: "团队（执事/群组）",
	config: "配置与用量",
};

export const EXPORT_MESSAGE_LIMIT = 500;

export const MEMORY_SCOPE_LIMIT = 2000;

export const EXPORT_MAX_BYTES = (() => {
	const raw = Number(process.env.EXPORT_MAX_BYTES ?? 0);
	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 256 * 1024 * 1024;
})();

export function exportBundleEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return flagEnabled("EXPORT_BUNDLE", env);
}

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

export function parseExportImages(raw: string | undefined): boolean | null {
	if (raw === undefined) return true;
	const value = raw.trim();
	if (value === "1") return true;
	if (value === "0") return false;
	return null;
}

const pad = (value: number): string => String(value).padStart(2, "0");

export function localStamp(value: number | string, withSeconds = false): string {
	const date = typeof value === "string" ? new Date(value) : new Date(value);
	if (Number.isNaN(date.getTime())) return "";
	const head = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
	return withSeconds ? `${head}:${pad(date.getSeconds())}` : head;
}

export function exportStamp(at: Date): string {
	return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`;
}

export function isoOrNull(value: number | string | null | undefined): string | null {
	if (value === null || value === undefined) return null;
	const date = typeof value === "number" ? new Date(value) : new Date(value);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

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

export { decodeBase64, emptyPart, escapeCell, fileBytes, formatBytes, imageExtension, jsonFile, jsonlFile, pad, projectOf, shortError };
