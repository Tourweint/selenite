/**
 * openai-compat-content：兼容层 `messages[].content` 的分段解析（2026-11-16）。
 *
 * 修复的缺陷：兼容层原先用 `textOf()` 把 content 压成纯文本，OpenAI 风格的
 * `{ "type": "image_url", "image_url": { "url": "..." } }` 段被**静默丢弃且不报错**
 * ——只用兼容层的客户端发图，模型收不到图、也不会报错。现在：
 *
 *  - `data:image/*;base64,...` 内联 URL → 拆出 mimeType + 裸 base64，转成内部
 *    `ImagePartSchema` 形状（`{ type:"image", mimeType, data }`）；
 *  - 外部 `http(s)` URL → **显式 400**（兼容层不做下载转发；静默丢是这次要修的病）；
 *  - 其余形状 → 400 带可读原因；
 *  - 限制判定**复用 attachments.ts**（单图解码 ≤8MB、单条 ≤4 张、`AGENT_ATTACHMENTS=false`），
 *    不在这里另写一套。
 *
 * 纯文本口径**逐字节不变**：文本仍按旧 `textOf` 拼（字符串原样、数组取 text 段用 "" 连），
 * 只有带图的消息才多出一个 `parts`，且 content 仍是纯文本视图（给记忆 / 会话 id / 日志用）。
 * 图片只从"这条消息"落到 parts；兼容层只提交最后一条 user（§2.4.1），历史里的图与历史文本同待遇。
 */

import type { ChatMessage } from "@lifediary/shared";
import { assembleUserContent, attachmentsEnabled, type OutgoingPart } from "./attachments.ts";

/** 兼容层消息解析后的形状。`parts` 仅当这条消息带图时才有值。 */
export interface OpenAiPlainMessage {
	role: ChatMessage["role"];
	/** 纯文本口径：与改动前的 `textOf()` 逐字一致 */
	content: string;
	/** 给内核的分段（只在带图时给；纯文本仍提交字符串，老链路形状不变） */
	parts?: OutgoingPart[];
}

export type OpenAiContentFailure = {
	ok: false;
	code: "attachments_disabled" | "bad_image" | "unsupported_image_url";
	/** 人话原因；路由原样放进 400 的 error.message */
	message: string;
};

export type OpenAiContentResult = { ok: true; messages: OpenAiPlainMessage[] } | OpenAiContentFailure;

const ROLES: readonly string[] = ["user", "assistant", "system"];

const IMAGE_URL_KEYS = ["image_url", "url"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 旧口径的纯文本提取（2026-11-16 之前就这一份）：字符串原样；数组里字符串段与带
 * `text` 键的段按出现顺序用**空串**相连（不是 `\n`——那是 attachments.ts 的口径）。
 * 刻意保持逐字节不变：纯文本客户端的会话 id / 分类输入都不能因为这次改动而漂。
 */
export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				if (typeof part === "string") return part;
				if (part && typeof part === "object" && "text" in part) {
					return String((part as { text?: unknown }).text ?? "");
				}
				return "";
			})
			.join("");
	}
	return "";
}

/** `data:image/png;base64,...` 的解析结果（裸 base64，不含前缀）。 */
interface InlineImage {
	mimeType: string;
	data: string;
}

/** 从 image_url 的取值里解析内联图片；外部 URL / 非法形状一律失败（不静默丢）。 */
function parseImageUrl(value: unknown): { ok: true; image: InlineImage } | OpenAiContentFailure {
	if (typeof value === "string") {
		return parseImageUrlString(value);
	}
	if (isRecord(value)) {
		for (const key of IMAGE_URL_KEYS) {
			const candidate = value[key];
			if (typeof candidate === "string") return parseImageUrlString(candidate);
		}
		// `{ "image_url": { "url": 123 } }` 这类形状：有壳没内容
		return {
			ok: false,
			code: "bad_image",
			message: "image_url.url 必须是字符串",
		};
	}
	return {
		ok: false,
		code: "bad_image",
		message: "image_url 必须是 { url } 对象或字符串",
	};
}

function parseImageUrlString(raw: string): { ok: true; image: InlineImage } | OpenAiContentFailure {
	const url = raw.trim();
	if (url.length === 0) {
		return { ok: false, code: "bad_image", message: "image_url.url 不能为空" };
	}
	if (/^https?:\/\//i.test(url)) {
		// 兼容层不下载转发（要拉取、要防 SSRF、要落临时文件，都是另一件事）；
		// 但**必须报错**：静默丢图正是这次要修的缺陷。
		return {
			ok: false,
			code: "unsupported_image_url",
			message:
				"暂不支持外部图片 URL（http/https）：请由客户端下载后以 data:image/<类型>;base64,<数据> 内联发送",
		};
	}
	if (!/^data:/i.test(url)) {
		return {
			ok: false,
			code: "unsupported_image_url",
			message: "不支持的 image_url：只接受 data:image/*;base64,... 内联图片",
		};
	}
	const match = /^data:([^,]*),([\s\S]*)$/i.exec(url);
	if (!match) {
		return {
			ok: false,
			code: "bad_image",
			message: "图片 data URL 形状不合法（应为 data:image/<类型>;base64,<数据>）",
		};
	}
	const meta = match[1] ?? "";
	const payload = match[2] ?? "";
	if (!/;base64$/i.test(meta)) {
		return {
			ok: false,
			code: "bad_image",
			message: "图片 data URL 必须用 base64 编码（data:image/<类型>;base64,<数据>）",
		};
	}
	const mimeType = (meta.slice(0, -";base64".length).split(";")[0] ?? "").trim().toLowerCase();
	if (!mimeType.startsWith("image/")) {
		return {
			ok: false,
			code: "bad_image",
			message: `图片 data URL 的 MIME 需要是 image/*（收到 ${mimeType || "空"}）`,
		};
	}
	// base64 里的换行/空白不承载信息（JSON 里常被转义），先删掉再交给 attachments 校验形状。
	const data = payload.replace(/\s+/g, "");
	if (data.length === 0) {
		return { ok: false, code: "bad_image", message: "图片 data URL 里没有数据" };
	}
	return { ok: true, image: { mimeType, data } };
}

/** 这个分段是不是 OpenAI 的图片段（`type:"image_url"`；老客户端可能不带 type）。 */
function isImagePart(part: unknown): boolean {
	if (!isRecord(part)) return false;
	if (part.type === "image_url") return true;
	return part.type === undefined && "image_url" in part;
}

/**
 * 解析整份 `messages`：过滤角色、保持原有"空白消息丢掉"的口径，图片转成 parts。
 *
 * 失败（开关关 / 形状非法 / 超限 / 外部 URL）一律返回带 code 的失败结果，由路由回 400——
 * **不再静默丢**。`env` 只为单测注入，生产走 `process.env`。
 */
export function parseOpenAiMessages(
	raw: unknown,
	env: NodeJS.ProcessEnv = process.env,
): OpenAiContentResult {
	const list = Array.isArray(raw) ? raw : [];
	const messages: OpenAiPlainMessage[] = [];
	for (const item of list) {
		if (!isRecord(item)) continue;
		const role = typeof item.role === "string" ? item.role : "";
		if (!ROLES.includes(role)) continue;
		const content = item.content;
		const text = textOf(content);

		const images: InlineImage[] = [];
		if (Array.isArray(content)) {
			for (const part of content) {
				if (!isImagePart(part)) continue;
				if (!attachmentsEnabled(env)) {
					return {
						ok: false,
						code: "attachments_disabled",
						message: "附件已关闭（AGENT_ATTACHMENTS=false），请只发文字",
					};
				}
				const parsed = parseImageUrl((part as Record<string, unknown>).image_url);
				if (!parsed.ok) return parsed;
				images.push(parsed.image);
			}
		}

		if (images.length === 0) {
			// 改动前的老行为：空白消息直接丢（纯图消息不在此列）
			if (text.trim().length === 0) continue;
			messages.push({ role: role as ChatMessage["role"], content: text });
			continue;
		}

		// 上限 / base64 形状 / 体积全部复用 attachments.ts 那一套，免得两处口径漂移。
		const assembled = assembleUserContent([
			{ type: "text", text },
			...images.map((image) => ({ type: "image" as const, ...image })),
		]);
		if (!assembled.ok) {
			return { ok: false, code: "bad_image", message: assembled.message };
		}
		messages.push({
			role: role as ChatMessage["role"],
			content: assembled.value.text,
			...(assembled.value.parts ? { parts: assembled.value.parts } : {}),
		});
	}
	return { ok: true, messages };
}

/**
 * 会话 id 的种子（纯图消息没有正文）：取图片数据前 64 字符做指纹。
 *
 * 为什么需要：图片消息的 content 是空串，若仍按"首条 user 文本"哈希，
 * 所有纯图新会话都会落到同一个 `oa-<空串哈希>` 上，互相串历史。
 */
export function conversationSeedOf(message: OpenAiPlainMessage): string {
	if (message.content.trim().length > 0) return message.content;
	const images = (message.parts ?? []).filter((part) => part.type === "image");
	return images.map((part) => `${part.mimeType}:${part.data.slice(0, 64)}`).join("|");
}
