import assert from "node:assert/strict";
import { test } from "node:test";
import { inflateRawSync } from "node:zlib";
import { buildZip, crc32 } from "./zip.ts";

/**
 * zip 写入器的单测：**自己解一遍**再断言。
 * 只看"有 PK 头"等于什么都没验——压缩流对不对、中央目录偏移对不对、
 * 中文名有没有按 UTF-8 记，都得靠解包回来才看得见。
 */

interface Parsed {
	name: string;
	method: number;
	flag: number;
	bytes: Buffer;
	text: string;
}

function unzip(buffer: Buffer): Parsed[] {
	const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
	assert.notEqual(eocd, -1, "找不到 EOCD");
	const count = buffer.readUInt16LE(eocd + 10);
	const centralOffset = buffer.readUInt32LE(eocd + 16);
	const out: Parsed[] = [];
	let cursor = centralOffset;

	for (let index = 0; index < count; index += 1) {
		assert.equal(buffer.readUInt32LE(cursor), 0x02014b50, "中央目录头签名不对");
		const flag = buffer.readUInt16LE(cursor + 8);
		const method = buffer.readUInt16LE(cursor + 10);
		const crc = buffer.readUInt32LE(cursor + 16);
		const compressed = buffer.readUInt32LE(cursor + 20);
		const raw = buffer.readUInt32LE(cursor + 24);
		const nameLength = buffer.readUInt16LE(cursor + 28);
		const extraLength = buffer.readUInt16LE(cursor + 30);
		const commentLength = buffer.readUInt16LE(cursor + 32);
		const localOffset = buffer.readUInt32LE(cursor + 42);
		const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");

		const localNameLength = buffer.readUInt16LE(localOffset + 26);
		const localExtraLength = buffer.readUInt16LE(localOffset + 28);
		const start = localOffset + 30 + localNameLength + localExtraLength;
		const body = buffer.subarray(start, start + compressed);
		const data = method === 8 ? inflateRawSync(body) : body;
		assert.equal(data.length, raw, `${name} 解出来的长度不对`);
		assert.equal(crc32(data), crc, `${name} 的 CRC 对不上`);
		out.push({ name, method, flag, bytes: data, text: data.toString("utf8") });

		cursor += 46 + nameLength + extraLength + commentLength;
	}
	return out;
}

test("CRC32 对标准向量", () => {
	assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
	assert.equal(crc32(Buffer.alloc(0)), 0);
});

test("往返：中文名 + 文本压缩 + 二进制 STORE", () => {
	const blob = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
	const zip = buildZip([
		{ name: "会话/你好.md", data: "你好，这是导出说明。".repeat(50) },
		{ name: "images/0001.png", data: blob, compress: false },
	]);
	const entries = unzip(zip);
	assert.deepEqual(entries.map((entry) => entry.name), ["会话/你好.md", "images/0001.png"]);
	assert.equal(entries[0]!.method, 8, "长文本应该走 deflate");
	assert.equal(entries[0]!.text, "你好，这是导出说明。".repeat(50));
	assert.equal(entries[0]!.flag & 0x0800, 0x0800, "文件名要标 UTF-8");
	assert.equal(entries[1]!.method, 0, "图片应按 STORE 写入");
	assert.deepEqual(entries[1]!.bytes, blob, "二进制必须逐字节还原，不能过一遍 UTF-8");
});

test("短内容压不小就退回 STORE（不把包压大）", () => {
	const zip = buildZip([{ name: "a.txt", data: "hi" }]);
	assert.equal(unzip(zip)[0]!.method, 0);
});

test("空包也是合法的（只有 EOCD）", () => {
	const zip = buildZip([]);
	assert.equal(zip.length, 22);
	assert.equal(zip.readUInt32LE(0), 0x06054b50);
	assert.equal(zip.readUInt16LE(10), 0);
});
