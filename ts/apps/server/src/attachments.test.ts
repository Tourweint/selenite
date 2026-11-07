import assert from "node:assert/strict";
import { test } from "node:test";
import {
	MAX_IMAGE_BYTES,
	MAX_IMAGES_PER_MESSAGE,
	assembleUserContent,
	attachmentsEnabled,
	base64Bytes,
	editResendEnabled,
} from "./attachments.ts";

/**
 * 附件限制与拼装的纯函数测试（2026-11-08 扫尾批 4a）。
 * 探针验"真起服务 + 真 HTTP"，这里只钉住规则本身：体积口径、张数、纯图允许、
 * 文本拼接口径，以及两个回滚开关的默认值。
 */

/** 1×1 透明 PNG 的裸 base64（真实可解码，不是占位串） */
const PNG_1X1 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("纯字符串：原样通过，不包 parts（老链路形状不变）", () => {
	const result = assembleUserContent("我养了一只叫团子的猫");
	assert.equal(result.ok, true);
	assert.deepEqual(result.ok && result.value, { text: "我养了一只叫团子的猫", imageCount: 0 });
});

test("文本 + 图片：文本拼接、图片进 parts、文本在前", () => {
	const result = assembleUserContent([
		{ type: "text", text: "看看这张" },
		{ type: "image", mimeType: "image/png", data: PNG_1X1 },
	]);
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.value.text, "看看这张");
	assert.equal(result.value.imageCount, 1);
	assert.deepEqual(result.value.parts, [
		{ type: "text", text: "看看这张" },
		{ type: "image", mimeType: "image/png", data: PNG_1X1 },
	]);
});

test("多段文本用 \\n 连（与 pi-ai contentText 同口径）", () => {
	const result = assembleUserContent([
		{ type: "text", text: "第一段" },
		{ type: "text", text: "第二段" },
	]);
	assert.equal(result.ok, true);
	assert.equal(result.ok && result.value.text, "第一段\n第二段");
	// 纯文本分段与纯字符串等价：不带 parts
	assert.equal(result.ok && result.value.parts, undefined);
});

test("纯图无文本：允许，text 为空串", () => {
	const result = assembleUserContent([{ type: "image", mimeType: "image/jpeg", data: PNG_1X1 }]);
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.value.text, "");
	assert.equal(result.value.parts?.length, 1);
});

test("全空白文本 + 无图 → 400 口径的失败", () => {
	const result = assembleUserContent([{ type: "text", text: "   \n " }]);
	assert.equal(result.ok, false);
	assert.equal(result.ok === false && result.message, "消息内容为空");
});

test(`超过 ${MAX_IMAGES_PER_MESSAGE} 张图 → 失败`, () => {
	const parts = Array.from({ length: MAX_IMAGES_PER_MESSAGE + 1 }, () => ({
		type: "image" as const,
		mimeType: "image/png",
		data: PNG_1X1,
	}));
	const result = assembleUserContent(parts);
	assert.equal(result.ok, false);
	assert.match(result.ok === false ? result.message : "", /最多 4 张/);
});

test("单张解码后超过 8MB → 失败", () => {
	// 只构造长度：解码字节 = len/4*3，凑到 8MB + 1 字节即可
	const chars = Math.ceil((MAX_IMAGE_BYTES + 1) / 3) * 4;
	const huge = "A".repeat(chars);
	const bytes = base64Bytes(huge);
	assert.ok(bytes !== null && bytes > MAX_IMAGE_BYTES, `解码字节 ${bytes}`);
	const result = assembleUserContent([{ type: "image", mimeType: "image/png", data: huge }]);
	assert.equal(result.ok, false);
	assert.match(result.ok === false ? result.message : "", /8MB/);
});

test("非法 base64 / 非图片 mime → 失败", () => {
	const bad = assembleUserContent([
		{ type: "image", mimeType: "image/png", data: "不是base64" },
	]);
	assert.equal(bad.ok, false);
	assert.match(bad.ok === false ? bad.message : "", /base64/);

	const notImage = assembleUserContent([
		{ type: "image", mimeType: "application/pdf", data: PNG_1X1 },
	]);
	assert.equal(notImage.ok, false);
	assert.match(notImage.ok === false ? notImage.message : "", /图片/);
});

test("base64Bytes：形状判定与解码字节数", () => {
	assert.equal(base64Bytes(PNG_1X1), 70);
	assert.equal(base64Bytes("abc"), null); // 长度不是 4 的倍数
	assert.equal(base64Bytes("!!!!"), null); // 非法字符
	assert.equal(base64Bytes(""), null);
});

test("两个回滚开关：默认开，只有显式 false 才关", () => {
	assert.equal(attachmentsEnabled({}), true);
	assert.equal(attachmentsEnabled({ AGENT_ATTACHMENTS: "false" }), false);
	assert.equal(attachmentsEnabled({ AGENT_ATTACHMENTS: "FALSE" }), false);
	assert.equal(attachmentsEnabled({ AGENT_ATTACHMENTS: "off" }), true);

	assert.equal(editResendEnabled({}), true);
	assert.equal(editResendEnabled({ AGENT_EDIT_RESEND: "false" }), false);
});
