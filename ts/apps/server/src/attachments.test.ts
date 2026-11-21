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
import { conversationSeedOf, parseOpenAiMessages } from "./openai-compat-content.ts";

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
	assert.equal(attachmentsEnabled({ AGENT_ATTACHMENTS: "off" }), false);

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

/* ── OpenAI 兼容层图片输入（2026-11-16，修复"静默丢弃 image_url"）──── */

/**
 * 兼容层 `messages[].content` 的分段解析：`data:image/*;base64,` 内联图转成内部
 * image parts；超限 / 非法 / 外部 URL 一律返回 400 口径的原因（不再静默丢）；
 * 纯文本解析口径与改动前的 `textOf()` 逐字一致。
 */

const imageUrl = (url: string) => ({ type: "image_url", image_url: { url } });
const dataUrl = (mime: string, data: string) => `data:${mime};base64,${data}`;

test("兼容层：纯文本口径逐字不变（字符串原样、分段仍空串连、空白消息仍丢）", () => {
	const result = parseOpenAiMessages(
		[
			{ role: "system", content: "系统提示" },
			{ role: "user", content: "第一句" },
			// 旧 textOf 对数组用 "" 连（不是 attachments 的 "\n"）
			{ role: "assistant", content: [{ type: "text", text: "上" }, { type: "text", text: "半句" }] },
			{ role: "user", content: "   \n " },
			{ role: "tool", content: "角色不认识，丢掉" },
		],
		{},
	);
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.deepEqual(result.messages, [
		{ role: "system", content: "系统提示" },
		{ role: "user", content: "第一句" },
		{ role: "assistant", content: "上半句" },
	]);
	assert.equal(result.messages[1]?.parts, undefined, "纯文本不带 parts（老链路形状不变）");
});

test("兼容层：data URL 拆出 mime + 裸 base64，文本在前、图片进 parts", () => {
	const result = parseOpenAiMessages(
		[
			{
				role: "user",
				content: [
					{ type: "text", text: "看看这张" },
					{ type: "image_url", image_url: { url: dataUrl("image/png", PNG_1X1), detail: "low" } },
				],
			},
		],
		{},
	);
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.messages[0]?.content, "看看这张");
	assert.deepEqual(result.messages[0]?.parts, [
		{ type: "text", text: "看看这张" },
		{ type: "image", mimeType: "image/png", data: PNG_1X1 },
	]);
});

test("兼容层：data URL 大小写 / 内嵌换行都认；纯图消息不被丢", () => {
	const wrapped = `${PNG_1X1.slice(0, 20)}\n${PNG_1X1.slice(20)}`;
	const result = parseOpenAiMessages(
		[{ role: "user", content: [imageUrl(`DATA:IMAGE/PNG;BASE64,${wrapped}`)] }],
		{},
	);
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.messages.length, 1, "纯图消息没有正文，也不能被当空消息丢掉");
	assert.equal(result.messages[0]?.content, "");
	assert.deepEqual(result.messages[0]?.parts, [
		{ type: "image", mimeType: "image/png", data: PNG_1X1 },
	]);
});

test("兼容层：超过 4 张图 → 400 口径的失败", () => {
	const parts = Array.from({ length: MAX_IMAGES_PER_MESSAGE + 1 }, () =>
		imageUrl(dataUrl("image/png", PNG_1X1)),
	);
	const result = parseOpenAiMessages([{ role: "user", content: parts }], {});
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.code, "bad_image");
	assert.match(result.message, /最多 4 张/);
});

test("兼容层：单图解码后超过 8MB → 400 口径的失败", () => {
	const chars = Math.ceil((MAX_IMAGE_BYTES + 1) / 3) * 4;
	const huge = "A".repeat(chars);
	const result = parseOpenAiMessages([{ role: "user", content: [imageUrl(dataUrl("image/png", huge))] }], {});
	assert.equal(result.ok, false);
	assert.match(result.ok === false ? result.message : "", /8MB/);
});

test("兼容层：AGENT_ATTACHMENTS=false → 400 口径的失败", () => {
	const result = parseOpenAiMessages(
		[{ role: "user", content: [imageUrl(dataUrl("image/png", PNG_1X1))] }],
		{ AGENT_ATTACHMENTS: "false" },
	);
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.code, "attachments_disabled");
	assert.match(result.message, /AGENT_ATTACHMENTS=false/);

	// 纯文本请求不受这个开关影响（改动前就如此）
	const textOnly = parseOpenAiMessages([{ role: "user", content: "只发文字" }], {
		AGENT_ATTACHMENTS: "false",
	});
	assert.equal(textOnly.ok, true);
});

test("兼容层：外部 http(s) URL 显式报错（不转发、也不静默丢）", () => {
	const result = parseOpenAiMessages(
		[{ role: "user", content: [imageUrl("https://example.com/cat.png")] }],
		{},
	);
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.code, "unsupported_image_url");
	assert.match(result.message, /外部图片 URL/);
	assert.match(result.message, /data:image/);
});

test("兼容层：非法 image_url 形状一律 400 带可读原因", () => {
	const cases: Array<{ part: unknown; expect: RegExp }> = [
		{ part: { type: "image_url", image_url: {} }, expect: /url 必须是字符串/ },
		{ part: { type: "image_url", image_url: { url: "  " } }, expect: /不能为空/ },
		{ part: { type: "image_url", image_url: { url: "cat.png" } }, expect: /只接受 data:image/ },
		{ part: imageUrl("data:text/plain;base64,aGk="), expect: /MIME 需要是 image/ },
		{ part: imageUrl("data:image/png,abc"), expect: /必须用 base64 编码/ },
		{ part: imageUrl("data:image/png;base64,"), expect: /没有数据/ },
		{ part: imageUrl("data:image/png;base64,不是base64"), expect: /不是合法的 base64/ },
	];
	for (const { part, expect } of cases) {
		const result = parseOpenAiMessages([{ role: "user", content: [part] }], {});
		assert.equal(result.ok, false, `应拒绝：${JSON.stringify(part)}`);
		assert.match(result.ok === false ? result.message : "", expect);
	}
});

test("兼容层：纯图消息的会话种子按图片指纹（不与空正文共用 id）", () => {
	const imageOnly = parseOpenAiMessages(
		[{ role: "user", content: [imageUrl(dataUrl("image/png", PNG_1X1))] }],
		{},
	);
	assert.equal(imageOnly.ok, true);
	if (!imageOnly.ok) return;
	const seed = conversationSeedOf(imageOnly.messages[0]!);
	assert.notEqual(seed, "", "纯图消息不能落成空种子");
	assert.match(seed, /^image\/png:/);

	const withText = parseOpenAiMessages([{ role: "user", content: "你好" }], {});
	assert.equal(withText.ok, true);
	assert.equal(withText.ok && conversationSeedOf(withText.messages[0]!), "你好");
});
