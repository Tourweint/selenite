import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	FILE_MANIFEST_HINT,
	FILE_MANIFEST_PREFIX,
	MAX_FILES_PER_MESSAGE,
	parseFileManifest,
	renderFileManifest,
} from "@lifediary/shared";
import {
	MAX_IMAGE_BYTES,
	MAX_IMAGES_PER_MESSAGE,
	assembleUserContent,
	attachmentsEnabled,
	base64Bytes,
	editResendEnabled,
} from "./attachments.ts";
import { saveUploadedAttachment } from "./attachment-files.ts";

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
	assert.deepEqual(result.ok && result.value, {
		text: "我养了一只叫团子的猫",
		imageCount: 0,
		fileCount: 0,
	});
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

/* ── 文件附件（2026-11-13 附件走路径）──────────────────── */

/** 假 stat：只认白名单里的路径，别的当不存在 */
const fakeStat = (known: Record<string, number>) => (path: string) =>
	path in known
		? ({ ok: true as const, bytes: known[path] })
		: ({ ok: false as const, message: "路径不存在或读不到" });

const FILE_A = { type: "file" as const, path: "D:\\docs\\报告.pdf", name: "报告.pdf", mimeType: "application/pdf", bytes: 1234 };
const FILE_B = { type: "file" as const, path: "/tmp/notes.md", name: "notes.md" };

test("文本 + 文件：清单进正文第一行，text 只留用户原话", () => {
	const result = assembleUserContent(
		[{ type: "text", text: "看看这两个" }, FILE_A, FILE_B],
		{ statFile: fakeStat({ "D:\\docs\\报告.pdf": 1234, "/tmp/notes.md": 88 }) },
	);
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.value.text, "看看这两个");
	assert.equal(result.value.fileCount, 2);
	assert.deepEqual(
		result.value.files?.map((file) => file.name),
		["报告.pdf", "notes.md"],
	);
	const first = result.value.parts?.[0];
	assert.equal(first?.type, "text");
	const body = first && first.type === "text" ? first.text : "";
	assert.ok(body.startsWith(FILE_MANIFEST_PREFIX + FILE_MANIFEST_HINT), "清单是正文第一行");
	assert.ok(body.endsWith("\n\n看看这两个"), "清单与正文之间空一行");
});

test("纯文件消息：允许，text 为空串", () => {
	const result = assembleUserContent([FILE_A], {
		statFile: fakeStat({ "D:\\docs\\报告.pdf": 1234 }),
	});
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.value.text, "");
	assert.equal(result.value.fileCount, 1);
	assert.equal(result.value.parts?.length, 1);
});

test("文件 + 图片：清单在前、图片照旧进 parts", () => {
	const result = assembleUserContent([FILE_A, { type: "image", mimeType: "image/png", data: PNG_1X1 }], {
		statFile: fakeStat({ "D:\\docs\\报告.pdf": 1234 }),
	});
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.value.imageCount, 1);
	assert.equal(result.value.fileCount, 1);
	assert.deepEqual(result.value.parts?.map((part) => part.type), ["text", "image"]);
});

test("非绝对路径 / 路径不存在 / 是目录 → 400 带文件名", () => {
	const relative = assembleUserContent([{ ...FILE_A, path: "docs/a.pdf" }], {
		statFile: fakeStat({ "docs/a.pdf": 1 }),
	});
	assert.equal(relative.ok, false);
	assert.match(relative.ok === false ? relative.message : "", /绝对路径/);

	const missing = assembleUserContent([FILE_A], { statFile: fakeStat({}) });
	assert.equal(missing.ok, false);
	assert.match(missing.ok === false ? missing.message : "", /报告\.pdf.*不存在/);

	const dir = assembleUserContent([FILE_A], {
		statFile: () => ({ ok: false, message: "不是普通文件" }),
	});
	assert.equal(dir.ok, false);
	assert.match(dir.ok === false ? dir.message : "", /报告\.pdf.*不是普通文件/);
});

test(`超过 ${MAX_FILES_PER_MESSAGE} 个文件 → 失败`, () => {
	const parts = Array.from({ length: MAX_FILES_PER_MESSAGE + 1 }, (_, index) => ({
		type: "file" as const,
		path: `D:\\docs\\${index}.txt`,
		name: `${index}.txt`,
	}));
	const result = assembleUserContent(parts, {
		statFile: () => ({ ok: true, bytes: 1 }),
	});
	assert.equal(result.ok, false);
	assert.match(result.ok === false ? result.message : "", /最多 8 个文件/);
});

test("清单回读：往返一致；用户手打前缀解析失败就原样当正文", () => {
	const files = [{ path: "D:\\x\\a.pdf", name: "a.pdf", mimeType: "application/pdf", bytes: 9 }];
	const rendered = `${renderFileManifest(files)}\n\n正文`;
	const parsed = parseFileManifest(rendered);
	assert.deepEqual(parsed.files, files);
	assert.equal(parsed.text, "正文");

	// 纯文件：没有正文，剥完是空串
	assert.deepEqual(parseFileManifest(renderFileManifest(files)), { files, text: "" });

	// 用户手打同款前缀但后面不是 JSON：不猜，原样返回
	const spoof = `${FILE_MANIFEST_PREFIX}${FILE_MANIFEST_HINT}不是 JSON`;
	assert.deepEqual(parseFileManifest(spoof), { files: [], text: spoof });
});

test("上传落盘：内容 hash 命名、同内容复用、开关关闭 404", () => {
	const dir = mkdtempSync(join(tmpdir(), "lifediary-att-"));
	try {
		const env = { ATTACHMENTS_DIR: dir } as NodeJS.ProcessEnv;
		const first = saveUploadedAttachment({ name: "样例.txt", data: Buffer.from("hi").toString("base64") }, env);
		assert.equal(first.ok, true);
		if (!first.ok) return;
		assert.equal(first.file.name, "样例.txt");
		assert.equal(first.file.bytes, 2);
		assert.ok(first.file.path.startsWith(dir));
		const second = saveUploadedAttachment({ name: "样例.txt", data: Buffer.from("hi").toString("base64") }, env);
		assert.equal(second.ok, true);
		if (!second.ok) return;
		assert.equal(second.file.path, first.file.path, "同内容同名的第二次上传复用同一个路径");
		assert.equal(readdirSync(dir).length, 1);

		const off = saveUploadedAttachment(
			{ name: "a.txt", data: Buffer.from("hi").toString("base64") },
			{ ATTACHMENTS_DIR: dir, AGENT_FILE_ATTACHMENTS: "false" } as NodeJS.ProcessEnv,
		);
		assert.equal(off.ok, false);
		assert.equal(off.ok === false && off.status, 404);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

