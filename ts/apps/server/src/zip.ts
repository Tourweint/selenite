import { deflateRawSync } from "node:zlib";

/**
 * 极简 zip 写入器（2026-11-13 导出数据升级）。
 *
 * 为什么自己写：包里只有文本 + 图片，需求就是"存进一个 zip"，为这点事引一个
 * 打包依赖不划算（也违背"换实现只换适配层"的最小改动口径）。用 Node 自带
 * `deflateRawSync` 做压缩、自己算 CRC32，写标准 local header + 中央目录 + EOCD，
 * 100 行内可审计，Windows 资源管理器 / macOS 归档工具 / `unzip` 都认。
 *
 * 刻意不做的事：zip64（>4GB 不接）、加密、分卷、目录项（空目录不会出现，
 * 每个目录至少有一个文件——导出模块保证这一点）。文件名一律 UTF-8
 * （general purpose bit 11），否则中文标题解压出来是乱码。
 */

/** 一条待写入的文件。`raw` 为真用 STORE（图片已是压缩格式，再压没意义还会变大）。 */
export interface ZipEntry {
	/** 包内路径，用 `/` 分隔，不带前导斜杠 */
	name: string;
	data: Buffer | string;
	/** false = 不压缩（STORE）。默认按文本压缩 */
	compress?: boolean;
}

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let index = 0; index < 256; index += 1) {
		let value = index;
		for (let bit = 0; bit < 8; bit += 1) {
			value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
		}
		table[index] = value >>> 0;
	}
	return table;
})();

/** 标准 CRC32（zip 用的多项式 0xEDB88320），返回无符号 32 位。 */
export function crc32(buffer: Buffer): number {
	let crc = 0xffffffff;
	for (let index = 0; index < buffer.length; index += 1) {
		crc = CRC_TABLE[(crc ^ buffer[index]!) & 0xff]! ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

/** DOS 时间（2 秒精度，1980 起算；越界夹到范围内，解压工具才不会报"时间非法"）。 */
function dosDateTime(at: Date): { time: number; date: number } {
	const year = Math.min(Math.max(at.getFullYear(), 1980), 2107);
	const month = at.getMonth() + 1;
	const day = at.getDate();
	const hour = at.getHours();
	const minute = at.getMinutes();
	const second = Math.floor(at.getSeconds() / 2);
	return {
		time: (hour << 11) | (minute << 5) | second,
		date: ((year - 1980) << 9) | (month << 5) | day,
	};
}

/** 同一份内容压缩后没变小就退回 STORE：小文件 / 已压缩格式不该被"压大"。 */
function packOne(data: Buffer, compress: boolean): { method: number; body: Buffer } {
	if (!compress) return { method: 0, body: data };
	const deflated = deflateRawSync(data, { level: 6 });
	// 压缩收益不足 12%（含少量文本也能省一点）就走 STORE，避免"压完更大"
	if (deflated.length >= data.length * 0.88) return { method: 0, body: data };
	return { method: 8, body: deflated };
}

/**
 * 拼一个 zip 包。`at` 只决定 DOS 时间（默认现在），不影响内容。
 * 空 entries 也会产出合法的空包（22 字节 EOCD），调用方不必特判。
 */
export function buildZip(entries: readonly ZipEntry[], at: Date = new Date()): Buffer {
	const { time, date } = dosDateTime(at);
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;

	for (const entry of entries) {
		const data = typeof entry.data === "string" ? Buffer.from(entry.data, "utf8") : entry.data;
		const name = Buffer.from(entry.name, "utf8");
		const crc = crc32(data);
		const { method, body } = packOne(data, entry.compress !== false);

		const local = Buffer.alloc(30 + name.length);
		local.writeUInt32LE(0x04034b50, 0); // local file header
		local.writeUInt16LE(20, 4); // version needed
		local.writeUInt16LE(0x0800, 6); // flag: 文件名 UTF-8
		local.writeUInt16LE(method, 8);
		local.writeUInt16LE(time, 10);
		local.writeUInt16LE(date, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(name.length, 26);
		local.writeUInt16LE(0, 28); // extra 长度
		name.copy(local, 30);

		const central = Buffer.alloc(46 + name.length);
		central.writeUInt32LE(0x02014b50, 0); // central directory header
		central.writeUInt16LE(20, 4); // version made by
		central.writeUInt16LE(20, 6); // version needed
		central.writeUInt16LE(0x0800, 8);
		central.writeUInt16LE(method, 10);
		central.writeUInt16LE(time, 12);
		central.writeUInt16LE(date, 14);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(body.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt16LE(0, 30); // extra
		central.writeUInt16LE(0, 32); // comment
		central.writeUInt16LE(0, 34); // disk number
		central.writeUInt16LE(0, 36); // internal attrs
		central.writeUInt32LE(0, 38); // external attrs
		central.writeUInt32LE(offset, 42); // local header 偏移
		name.copy(central, 46);

		locals.push(local, body);
		centrals.push(central);
		offset += local.length + body.length;
	}

	const centralSize = centrals.reduce((sum, one) => sum + one.length, 0);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(0, 4); // 本磁盘号
	eocd.writeUInt16LE(0, 6); // 中央目录起始磁盘
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(centralSize, 12);
	eocd.writeUInt32LE(offset, 16);
	eocd.writeUInt16LE(0, 20); // 注释长度

	return Buffer.concat([...locals, ...centrals, eocd]);
}
