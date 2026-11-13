import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { base64Bytes, fileAttachmentsEnabled } from "./attachments.ts";

/**
 * 浏览器上传的附件落盘（2026-11-13 附件走路径）。
 *
 * 浏览器出于安全拿不到用户选文件的真实路径，所以走这里：收字节 → 落 `.data/attachments/`
 * → 回一个服务端绝对路径，消息里只带这个路径。壳里选了文件不经过这里（原生选择器直接
 * 给绝对路径，零拷贝）。
 *
 * 存储口径：
 *  - 文件名只取 basename、去控制字符；落盘名 = `<内容 sha256 前 16 位>-<安全名>`，
 *    同内容不重复占空间；
 *  - 单文件解码后 ≤ 32MB；超过 8 个文件由上行 schema 拦（这里只做单文件）；
 *  - 目录总量超过 `ATTACHMENTS_MAX_MB`（缺省 512）时按 mtime 从旧到新删，只删这个目录；
 *  - 日志只记张数/字节/耗时，不记文件名与完整路径（路径可能带用户名）。
 */

/** 单文件解码后的字节上限（32MB） */
export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
/** 目录总量上限（缺省 512MB） */
export function attachmentsMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
	const raw = Number.parseInt((env.ATTACHMENTS_MAX_MB ?? "").trim(), 10);
	const mb = Number.isFinite(raw) && raw > 0 ? raw : 512;
	return mb * 1024 * 1024;
}

export function attachmentsDir(env: NodeJS.ProcessEnv = process.env): string {
	const custom = (env.ATTACHMENTS_DIR ?? "").trim();
	return resolve(custom || join(".data", "attachments"));
}

/** 展示名：basename + 去控制字符 + 截断；空名退回 attachment。 */
export function safeAttachmentName(name: string): string {
	const base = basename(String(name || "").replaceAll("\\", "/"));
	const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
	return cleaned.slice(0, 200) || "attachment";
}

/** 落盘名：内容 hash 前 16 位 + 安全名（磁盘名单独截到 120，给 Windows 260 路径留余量）。 */
function diskName(hash: string, name: string): string {
	return `${hash.slice(0, 16)}-${name.slice(0, 120)}`;
}

export interface SavedAttachment {
	path: string;
	name: string;
	mimeType?: string;
	bytes: number;
}

export type SaveUploadResult =
	| { ok: true; file: SavedAttachment }
	| { ok: false; status: 400 | 404; error: string; message: string };

/** 目录总量修剪：只删 attachments 目录里的普通文件，按 mtime 从旧到新。 */
export function pruneAttachments(
	dir: string,
	maxBytes = attachmentsMaxBytes(),
): { removed: number; freed: number } {
	let entries: { path: string; bytes: number; mtime: number }[] = [];
	try {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isFile()) continue;
			const path = join(dir, entry.name);
			try {
				const stat = statSync(path);
				entries.push({ path, bytes: stat.size, mtime: stat.mtimeMs });
			} catch {
				// 单个文件读不到（被占用/已删）：跳过，不挡上传
			}
		}
	} catch {
		return { removed: 0, freed: 0 };
	}
	let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
	if (total <= maxBytes) return { removed: 0, freed: 0 };
	entries = entries.sort((a, b) => a.mtime - b.mtime);
	let removed = 0;
	let freed = 0;
	for (const entry of entries) {
		if (total <= maxBytes) break;
		try {
			unlinkSync(entry.path);
			total -= entry.bytes;
			freed += entry.bytes;
			removed += 1;
		} catch {
			// 删不掉就留着：空间问题不该把这一次上传变成失败
		}
	}
	return { removed, freed };
}

/**
 * 收一份上传：校验 → 落盘 → 回路径。纯同步、无网络依赖，路由只负责解析 body。
 */
export function saveUploadedAttachment(
	input: { name?: unknown; mimeType?: unknown; data?: unknown },
	env: NodeJS.ProcessEnv = process.env,
): SaveUploadResult {
	if (!fileAttachmentsEnabled(env)) {
		return {
			ok: false,
			status: 404,
			error: "not_found",
			message: "文件附件未启用（AGENT_FILE_ATTACHMENTS=false）",
		};
	}
	const data = typeof input.data === "string" ? input.data.trim() : "";
	if (!data) {
		return { ok: false, status: 400, error: "bad_request", message: "data 需要是 base64 字符串" };
	}
	const bytes = base64Bytes(data);
	if (bytes === null) {
		return { ok: false, status: 400, error: "bad_request", message: "文件数据不是合法的 base64" };
	}
	if (bytes > MAX_UPLOAD_BYTES) {
		return {
			ok: false,
			status: 400,
			error: "bad_request",
			message: `单文件不能超过 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB`,
		};
	}
	const name = safeAttachmentName(typeof input.name === "string" ? input.name : "");
	const mimeType =
		typeof input.mimeType === "string" && input.mimeType.trim()
			? input.mimeType.trim().slice(0, 100)
			: undefined;
	const dir = attachmentsDir(env);
	mkdirSync(dir, { recursive: true });
	const hash = createHash("sha256").update(data).digest("hex");
	const path = join(dir, diskName(hash, name));
	if (!existsSync(path)) {
		// 同内容同名的第二次上传直接复用已有文件（hash 就是内容地址）
		writeFileSync(path, Buffer.from(data, "base64"), { flag: "wx" });
	}
	pruneAttachments(dir, attachmentsMaxBytes(env));
	return {
		ok: true,
		file: {
			path,
			name,
			...(mimeType ? { mimeType } : {}),
			bytes,
		},
	};
}
