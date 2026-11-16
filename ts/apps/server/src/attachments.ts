import { statSync } from "node:fs";
import {
	MAX_FILES_PER_MESSAGE,
	renderFileManifest,
	type ContentPart,
	type TranscriptFile,
} from "@lifediary/shared";
import { flagEnabled } from "./flags.ts";

/**
 * 附件能力（2026-11-08 扫尾批 4a 图片；2026-11-13 附件走路径）。
 *
 * 三件事刻意放在这里、而不是散在路由里：
 *  - **限制判定**是纯函数：单图解码后 ≤8MB、单条 ≤4 张、单条 ≤8 个文件、纯附件无文本允许；
 *  - **拼装**是纯函数：把上行的 `string | ContentPart[]` 变成
 *    "{给记忆/日志用的文本} + {给内核的 pi-ai parts}"，两件事同源、不会漂移；
 *  - **文件只认路径**：服务端只 `stat`，不读内容；清单写进正文第一行（shared 的
 *    `renderFileManifest`），模型自己决定要不要 `read`。
 *
 * 图片仍内联 base64（粘贴截图没有路径，且模型直接看最快）；文件字节不入 durable。
 */

/** 单条消息最多几张图 */
export const MAX_IMAGES_PER_MESSAGE = 4;
/** 单张图解码后的字节上限（8MB） */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** 一条消息最多几个文件（shared 的同一份常量，这里只做转出，避免两处漂移） */
export { MAX_FILES_PER_MESSAGE };

/** 传给内核 `submit({content})` 的分段形状（对齐 pi-ai 的 TextContent / ImageContent）。 */
export type OutgoingPart =
	| { type: "text"; text: string }
	| { type: "image"; mimeType: string; data: string };

/** `AGENT_ATTACHMENTS=false` → 上行分段请求 400、前端不渲染附件按钮；纯字符串不受影响。 */
export function attachmentsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return flagEnabled("AGENT_ATTACHMENTS", env);
}

/** `AGENT_FILE_ATTACHMENTS=false` → 上传端点 404、前端不渲染「任意文件」入口。 */
export function fileAttachmentsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return (env.AGENT_FILE_ATTACHMENTS ?? "").trim().toLowerCase() !== "false";
}

/** `AGENT_EDIT_RESEND=false` → 编辑重发端点 404、前端不渲染编辑入口。 */
export function editResendEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return flagEnabled("AGENT_EDIT_RESEND", env);
}

/**
 * 裸 base64 解码后的字节数；形状不合法（空串 / 非法字符 / 长度不是 4 的倍数）→ null。
 * 只算长度、真解码交给上游：这里要的是"够不够小"，不需要把 8MB 字节搬到内存里。
 */
export function base64Bytes(data: string): number | null {
	const b64 = data.trim();
	if (b64.length === 0) return null;
	if (b64.length % 4 !== 0) return null;
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
	const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
	return (b64.length / 4) * 3 - padding;
}

export interface AssembledContent {
	/** 纯文本口径：多段用 `\n` 连（与 pi-ai `contentText` 一致）；纯附件消息是空串 */
	text: string;
	/**
	 * 传给内核的分段。**只有带图或文件时才给**：纯文本仍提交 `text` 字符串，
	 * 老链路逐字节不变（durable 对两种形态都认，但没必要多包一层）。
	 * 文件不占独立 part：清单行折进第一段 text（pi-ai 没有文件类型的 Content）。
	 */
	parts?: OutgoingPart[];
	/** 图片张数（日志只记这个数，不记内容） */
	imageCount: number;
	/** 文件个数（日志只记这个数，不记文件名与路径） */
	fileCount: number;
	/** 文件清单（回读/测试用；不进 `text`，避免路径写进记忆） */
	files?: TranscriptFile[];
}

export type AssembleResult =
	| { ok: true; value: AssembledContent }
	| { ok: false; message: string };

/** 文件路径的 `stat` 校验结果；单测可注入假实现，不碰真磁盘。 */
export type FileStatResult =
	| { ok: true; bytes: number }
	| { ok: false; message: string };

/** 默认的 stat 校验：必须是已存在的普通文件；读不到/是目录一律失败（400 带文件名）。 */
export function statFilePart(path: string): FileStatResult {
	try {
		const stat = statSync(path);
		if (!stat.isFile()) return { ok: false, message: "不是普通文件" };
		return { ok: true, bytes: stat.size };
	} catch {
		return { ok: false, message: "路径不存在或读不到" };
	}
}

/** 绝对路径：Windows 盘符 / UNC / POSIX 根，三种都认。 */
function isAbsolutePath(path: string): boolean {
	return /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(path);
}

/** 展示名只留 basename、去控制字符；空名退回 `attachment`。 */
function cleanFileName(name: string): string {
	const base = name.split(/[\\/]/).pop() || "";
	const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
	return cleaned.slice(0, 255) || "attachment";
}

export interface AssembleOptions {
	/** 路径校验（默认真 stat；单测注入假实现，不必落真文件） */
	statFile?: (path: string) => FileStatResult;
}

/**
 * 把一条用户消息的内容变成「文本 + 可选 parts」，顺带做限制校验。
 *
 * 纯字符串原样返回（不 trim：老行为里客户端自己 trim，服务端不再二次加工）。
 * 分段数组：
 *  - 文本部分按出现顺序用 `\n` 连；全空白视同没有文本（纯附件消息允许）；
 *  - 图片部分逐张复核 mimeType 前缀、base64 形状、解码后体积；
 *  - 文件部分只认**绝对路径**，逐条 `stat`；清单写进正文第一行（模型看到路径，
 *    记忆只收用户原话）；
 *  - 超过 4 张图 / 超过 8 个文件 / 单图超 8MB / 路径不存在 / 既无文本又无附件 → 失败，
 *    由路由回 400 带说明。
 */
export function assembleUserContent(
	content: string | ContentPart[],
	options: AssembleOptions = {},
): AssembleResult {
	if (typeof content === "string") {
		return { ok: true, value: { text: content, imageCount: 0, fileCount: 0 } };
	}

	const statFile = options.statFile ?? statFilePart;
	const texts: string[] = [];
	const images: OutgoingPart[] = [];
	const files: TranscriptFile[] = [];
	for (const part of content) {
		if (part.type === "text") {
			texts.push(part.text);
			continue;
		}
		if (part.type === "file") {
			if (files.length >= MAX_FILES_PER_MESSAGE) {
				return { ok: false, message: `一条消息最多 ${MAX_FILES_PER_MESSAGE} 个文件` };
			}
			const path = part.path.trim();
			if (!isAbsolutePath(path) || path.includes("\0")) {
				return { ok: false, message: `附件路径需要是绝对路径：${cleanFileName(part.name)}` };
			}
			const name = cleanFileName(part.name);
			const stat = statFile(path);
			if (!stat.ok) {
				return { ok: false, message: `附件「${name}」${stat.message}` };
			}
			files.push({
				path,
				name,
				...(part.mimeType ? { mimeType: part.mimeType.slice(0, 100) } : {}),
				bytes: typeof part.bytes === "number" ? part.bytes : stat.bytes,
			});
			continue;
		}
		if (!part.mimeType.startsWith("image/")) {
			return { ok: false, message: "图片附件的 mimeType 需以 image/ 开头" };
		}
		if (images.length >= MAX_IMAGES_PER_MESSAGE) {
			return { ok: false, message: `一条消息最多 ${MAX_IMAGES_PER_MESSAGE} 张图片` };
		}
		const bytes = base64Bytes(part.data);
		if (bytes === null) {
			return { ok: false, message: "图片数据不是合法的 base64" };
		}
		if (bytes > MAX_IMAGE_BYTES) {
			return {
				ok: false,
				message: `单张图片不能超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB（解码后）`,
			};
		}
		images.push({ type: "image", mimeType: part.mimeType, data: part.data.trim() });
	}

	const joined = texts.join("\n");
	const text = joined.trim().length > 0 ? joined : "";
	if (text.length === 0 && images.length === 0 && files.length === 0) {
		return { ok: false, message: "消息内容为空" };
	}
	if (images.length === 0 && files.length === 0) {
		// 只有文本分段：与纯字符串等价，别多包一层
		return { ok: true, value: { text, imageCount: 0, fileCount: 0 } };
	}
	// 文件清单放在正文最前面（与 UI 里「附件在文字上方」同一观感），空一行再接正文
	const body = files.length
		? `${renderFileManifest(files)}${text ? `\n\n${text}` : ""}`
		: text;
	return {
		ok: true,
		value: {
			text,
			parts: [...(body ? [{ type: "text" as const, text: body }] : []), ...images],
			imageCount: images.length,
			fileCount: files.length,
			...(files.length ? { files } : {}),
		},
	};
}
