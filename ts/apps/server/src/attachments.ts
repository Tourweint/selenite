import type { ContentPart } from "@lifediary/shared";

/**
 * 附件（图片）能力（2026-11-08 扫尾批 4a，方案 §一）。
 *
 * 两件事刻意放在这里、而不是散在路由里：
 *  - **限制判定**是纯函数：单图解码后 ≤8MB、单条 ≤4 张、纯图无文本允许；
 *  - **拼装**是纯函数：把上行的 `string | ContentPart[]` 变成
 *    "{给记忆/日志用的文本} + {给内核的 pi-ai parts}"，两件事同源、不会漂移。
 *
 * 不做 blob 存储：图片 base64 直接进 durable 条目（会话库随之变大是登记过的已知边界）。
 */

/** 单条消息最多几张图 */
export const MAX_IMAGES_PER_MESSAGE = 4;
/** 单张图解码后的字节上限（8MB） */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** 传给内核 `submit({content})` 的分段形状（对齐 pi-ai 的 TextContent / ImageContent）。 */
export type OutgoingPart =
	| { type: "text"; text: string }
	| { type: "image"; mimeType: string; data: string };

/** `AGENT_ATTACHMENTS=false` → 上行分段请求 400、前端不渲染附件按钮；纯字符串不受影响。 */
export function attachmentsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return (env.AGENT_ATTACHMENTS ?? "").trim().toLowerCase() !== "false";
}

/** `AGENT_EDIT_RESEND=false` → 编辑重发端点 404、前端不渲染编辑入口。 */
export function editResendEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return (env.AGENT_EDIT_RESEND ?? "").trim().toLowerCase() !== "false";
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
	/** 纯文本口径：多段用 `\n` 连（与 pi-ai `contentText` 一致）；纯图消息是空串 */
	text: string;
	/**
	 * 传给内核的分段。**只有带图时才给**：纯文本仍提交 `text` 字符串，
	 * 老链路逐字节不变（durable 对两种形态都认，但没必要多包一层）。
	 */
	parts?: OutgoingPart[];
	/** 图片张数（日志只记这个数，不记内容） */
	imageCount: number;
}

export type AssembleResult =
	| { ok: true; value: AssembledContent }
	| { ok: false; message: string };

/**
 * 把一条用户消息的内容变成「文本 + 可选 parts」，顺带做限制校验。
 *
 * 纯字符串原样返回（不 trim：老行为里客户端自己 trim，服务端不再二次加工）。
 * 分段数组：
 *  - 文本部分按出现顺序用 `\n` 连；全空白视同没有文本（纯图消息允许）；
 *  - 图片部分逐张复核 mimeType 前缀、base64 形状、解码后体积；
 *  - 超过 4 张 / 单张超 8MB / 既无文本又无图 → 失败，由路由回 400 带说明。
 */
export function assembleUserContent(content: string | ContentPart[]): AssembleResult {
	if (typeof content === "string") {
		return { ok: true, value: { text: content, imageCount: 0 } };
	}

	const texts: string[] = [];
	const images: OutgoingPart[] = [];
	for (const part of content) {
		if (part.type === "text") {
			texts.push(part.text);
			continue;
		}
		if (!part.mimeType.startsWith("image/")) {
			return { ok: false, message: "附件只接受图片（mimeType 需以 image/ 开头）" };
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
	if (text.length === 0 && images.length === 0) {
		return { ok: false, message: "消息内容为空" };
	}
	if (images.length === 0) {
		// 只有文本分段：与纯字符串等价，别多包一层
		return { ok: true, value: { text, imageCount: 0 } };
	}
	return {
		ok: true,
		value: {
			text,
			parts: [...(text ? [{ type: "text" as const, text }] : []), ...images],
			imageCount: images.length,
		},
	};
}
