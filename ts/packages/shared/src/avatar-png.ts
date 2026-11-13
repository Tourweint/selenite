/**
 * 头像 PNG 字节校验（base64 / CRC32 / chunk 遍历）
 *
 * 2026-11-13 从 packages/shared/src/index.ts（契约单文件）按行区间 L991–L1191 整段切出；正文原文搬运，未改一行。
 * index.ts 变成纯桶，继续对外提供同样的符号；环由构建期依赖图检查保证为无环。
 */
import { z } from "zod";
import { B64_ALPHABET, PARTNER_AVATAR_MAX_BYTES, PARTNER_AVATAR_MAX_CHARS, PARTNER_AVATAR_MAX_DIMENSION, PARTNER_AVATAR_PREFIX } from "./relay-schemas.ts";

function base64Decode(b64: string): Uint8Array | null {
	if (b64.length === 0 || b64.length % 4 !== 0) return null;
	const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
	const byteLength = (b64.length / 4) * 3 - padding;
	const out = new Uint8Array(byteLength);
	let cursor = 0;
	for (let i = 0; i < b64.length; i += 4) {
		const a = B64_ALPHABET.indexOf(b64[i]);
		const b = B64_ALPHABET.indexOf(b64[i + 1]);
		const c = b64[i + 2] === "=" ? 0 : B64_ALPHABET.indexOf(b64[i + 2]);
		const d = b64[i + 3] === "=" ? 0 : B64_ALPHABET.indexOf(b64[i + 3]);
		if (a < 0 || b < 0 || c < 0 || d < 0) return null;
		const n = (a << 18) | (b << 12) | (c << 6) | d;
		out[cursor++] = (n >> 16) & 0xff;
		if (cursor < byteLength) out[cursor++] = (n >> 8) & 0xff;
		if (cursor < byteLength) out[cursor++] = n & 0xff;
	}
	return cursor === byteLength ? out : null;
}

const CRC32_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n += 1) {
		let c = n;
		for (let k = 0; k < 8; k += 1) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[n] = c >>> 0;
	}
	return table;
})();

function pngCrc32(bytes: Uint8Array, start: number, end: number): number {
	let c = 0xffffffff;
	for (let i = start; i < end; i += 1) {
		c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
	}
	return (c ^ 0xffffffff) >>> 0;
}

function be32(bytes: Uint8Array, offset: number): number {
	return (
		(bytes[offset] << 24) |
		(bytes[offset + 1] << 16) |
		(bytes[offset + 2] << 8) |
		bytes[offset + 3]
	) >>> 0;
}

function isChunkType(bytes: Uint8Array, offset: number): boolean {
	for (let i = 0; i < 4; i += 1) {
		const byte = bytes[offset + i];
		if (!((byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a))) return false;
	}
	return true;
}

function pngProblem(bytes: Uint8Array): string | null {
	const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	if (bytes.length < 45) return "头像不是完整的 PNG";
	if (signature.some((byte, index) => bytes[index] !== byte)) return "头像不是 PNG";

	let offset = 8;
	let seenIhdr = false;
	let seenIdat = false;
	let idatClosed = false;
	let seenIend = false;
	let seenPlte = false;
	let colorType = -1;

	while (offset < bytes.length) {
		if (bytes.length - offset < 12) return "PNG 数据不完整";
		const length = be32(bytes, offset);
		const typeStart = offset + 4;
		const dataStart = offset + 8;
		const crcStart = dataStart + length;
		if (length > bytes.length || crcStart + 4 > bytes.length) return "PNG 数据不完整";
		if (!isChunkType(bytes, typeStart)) return "PNG 块类型不合法";
		const type = String.fromCharCode(
			bytes[typeStart],
			bytes[typeStart + 1],
			bytes[typeStart + 2],
			bytes[typeStart + 3],
		);
		if (be32(bytes, crcStart) !== pngCrc32(bytes, typeStart, crcStart)) {
			return "PNG 数据校验失败（CRC）";
		}

		if (!seenIhdr) {
			if (type !== "IHDR") return "PNG 缺少 IHDR 块";
			if (length !== 13) return "PNG IHDR 长度不合法";
			const width = be32(bytes, dataStart);
			const height = be32(bytes, dataStart + 4);
			const bitDepth = bytes[dataStart + 8];
			colorType = bytes[dataStart + 9];
			const compression = bytes[dataStart + 10];
			const filter = bytes[dataStart + 11];
			const interlace = bytes[dataStart + 12];
			if (
				width < 1 ||
				height < 1 ||
				width > PARTNER_AVATAR_MAX_DIMENSION ||
				height > PARTNER_AVATAR_MAX_DIMENSION
			) {
				return `头像尺寸需在 1–${PARTNER_AVATAR_MAX_DIMENSION}px 之间（当前 ${width}×${height}）`;
			}
			const depthsByColor: Record<number, number[]> = {
				0: [1, 2, 4, 8, 16],
				2: [8, 16],
				3: [1, 2, 4, 8],
				4: [8, 16],
				6: [8, 16],
			};
			if (!depthsByColor[colorType]?.includes(bitDepth)) {
				return "PNG IHDR 参数不合法（颜色类型 / 位深）";
			}
			if (compression !== 0 || filter !== 0 || interlace > 1) {
				return "PNG IHDR 参数不合法（压缩 / 过滤 / 隔行）";
			}
			seenIhdr = true;
		} else {
			if (type === "IHDR") return "PNG 包含多个 IHDR 块";
			if (type === "IDAT") {
				if (idatClosed) return "PNG IDAT 块不连续";
				if (colorType === 3 && !seenPlte) return "PNG 缺少调色板（PLTE）";
				seenIdat = true;
			} else {
				if (seenIdat) idatClosed = true;
				if (type === "PLTE") {
					if (seenIdat) return "PNG PLTE 必须位于 IDAT 之前";
					seenPlte = true;
				}
				if (type === "IEND") {
					if (length !== 0) return "PNG IEND 长度不合法";
					if (crcStart + 4 !== bytes.length) return "PNG IEND 之后有多余数据";
					seenIend = true;
				}
			}
		}

		offset = crcStart + 4;
		if (seenIend) break;
	}

	if (!seenIhdr) return "PNG 缺少 IHDR 块";
	if (!seenIdat) return "PNG 缺少 IDAT 块";
	if (!seenIend) return "PNG 数据不完整（缺少 IEND）";
	return null;
}

export function partnerAvatarProblem(value: string): string | null {
	if (!value.startsWith(PARTNER_AVATAR_PREFIX)) {
		return "头像只接受 PNG（data:image/png;base64,...）";
	}
	if (value.length > PARTNER_AVATAR_MAX_CHARS) {
		return `头像字符串超过 ${PARTNER_AVATAR_MAX_CHARS} 字符上限`;
	}
	const b64 = value.slice(PARTNER_AVATAR_PREFIX.length);
	if (b64.length === 0) return "头像内容为空";
	if (b64.length % 4 !== 0) return "头像 base64 长度不合法";
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return "头像 base64 含非法字符";

	const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
	const byteLength = (b64.length / 4) * 3 - padding;
	if (byteLength > PARTNER_AVATAR_MAX_BYTES) {
		return `头像解码后超过 ${PARTNER_AVATAR_MAX_BYTES / 1024}KiB 上限`;
	}
	if (byteLength < 45) return "头像不是完整的 PNG";

	const bytes = base64Decode(b64);
	if (!bytes) return "头像 base64 无法解码";
	return pngProblem(bytes);
}

export const PartnerAvatarSchema = z
	.string()
	.max(PARTNER_AVATAR_MAX_CHARS, { message: `头像字符串超过 ${PARTNER_AVATAR_MAX_CHARS} 字符上限` })
	.superRefine((value, ctx) => {
		const problem = partnerAvatarProblem(value);
		if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
	});

export type PartnerAvatar = z.infer<typeof PartnerAvatarSchema>;

export const PartnerAvatarPatchSchema = PartnerAvatarSchema.nullable();

export type PartnerAvatarPatch = z.infer<typeof PartnerAvatarPatchSchema>;

export { CRC32_TABLE, base64Decode, be32, isChunkType, pngCrc32, pngProblem };
