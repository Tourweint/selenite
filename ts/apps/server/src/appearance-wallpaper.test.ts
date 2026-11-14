import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { test } from "node:test";
import {
	WALLPAPER_MAX_BYTES,
	mountAppearanceWallpaper,
	readWallpaperState,
	removeWallpaper,
	saveWallpaper,
	wallpaperEnabled,
} from "./appearance-wallpaper.ts";

/** 1×1 透明 PNG；测试只关心"能不能认、能不能存、能不能回传" */
const PNG_1PX = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
	"base64",
);

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "lifediary-wallpaper-"));
}

async function withEnvAsync(key: string, value: string, run: () => Promise<void>): Promise<void> {
	const previous = process.env[key];
	process.env[key] = value;
	try {
		await run();
	} finally {
		if (previous === undefined) delete process.env[key];
		else process.env[key] = previous;
	}
}

/* ── 存盘 / 读回（纯函数）──────────────────────────────────── */

test("saveWallpaper：写图 + 记 meta，换扩展名时清掉旧图", () => {
	const dir = tempDir();
	try {
		const first = saveWallpaper(PNG_1PX, "image/png", dir);
		assert.equal(first.present, true);
		assert.equal(first.mime, "image/png");
		assert.equal(first.bytes, PNG_1PX.byteLength);
		assert.ok(first.etag && first.etag.length >= 8);
		assert.deepEqual(readWallpaperState(dir), first);

		// 同一个目录再存一张 webp：png 必须被删掉，不能留两份
		const second = saveWallpaper(Buffer.from("RIFF0000WEBPVP8 ", "utf8"), "image/webp", dir);
		assert.equal(second.mime, "image/webp");
		assert.equal(readWallpaperState(dir).mime, "image/webp");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("saveWallpaper：空文件拒绝；超大拒绝", () => {
	const dir = tempDir();
	try {
		assert.throws(() => saveWallpaper(Buffer.alloc(0), "image/png", dir), /空文件/);
		const tooBig = Buffer.concat([PNG_1PX, Buffer.alloc(WALLPAPER_MAX_BYTES)]);
		assert.throws(() => saveWallpaper(tooBig, "image/png", dir), /不能超过/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("readWallpaperState：meta 没了 / 图没了都报 false，不留孤儿", () => {
	const dir = tempDir();
	try {
		assert.deepEqual(readWallpaperState(dir), { present: false });
		saveWallpaper(PNG_1PX, "image/png", dir);
		rmSync(join(dir, "wallpaper.png"), { force: true });
		assert.deepEqual(readWallpaperState(dir), { present: false });
		removeWallpaper(dir);
		assert.deepEqual(readWallpaperState(dir), { present: false });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("wallpaperEnabled：只有显式 false / 0 / off 才关", () => {
	assert.equal(wallpaperEnabled({}), true);
	assert.equal(wallpaperEnabled({ AGENT_APPEARANCE_WALLPAPER: "" }), true);
	assert.equal(wallpaperEnabled({ AGENT_APPEARANCE_WALLPAPER: "0" }), false);
	assert.equal(wallpaperEnabled({ AGENT_APPEARANCE_WALLPAPER: "off" }), false);
	assert.equal(wallpaperEnabled({ AGENT_APPEARANCE_WALLPAPER: "FALSE" }), false);
});

/* ── HTTP 三个端点 ───────────────────────────────────────── */

test("端点：POST 存 → GET 图与 meta → DELETE 清空；非图片 415、超大 413", async () => {
	const dir = tempDir();
	try {
		await withEnvAsync("AGENT_WALLPAPER_DIR", dir, async () => {
			const app = new Hono();
			mountAppearanceWallpaper(app);

			// 一开始什么都没有
			const meta0 = await app.request("/api/v1/appearance/wallpaper/meta");
			assert.equal(meta0.status, 200);
			assert.deepEqual(await meta0.json(), { present: false });
			const get0 = await app.request("/api/v1/appearance/wallpaper");
			assert.equal(get0.status, 404);

			// 上传一张真 PNG
			const form = new FormData();
			form.set("file", new File([PNG_1PX], "a.png", { type: "image/png" }));
			const post = await app.request("/api/v1/appearance/wallpaper", { method: "POST", body: form });
			assert.equal(post.status, 200);
			const saved = (await post.json()) as { present: boolean; etag: string; mime: string };
			assert.equal(saved.present, true);
			assert.equal(saved.mime, "image/png");

			// meta 认得出，GET 回的是图本体（按内容嗅探的 mime，不信客户端 type）
			const meta1 = await app.request("/api/v1/appearance/wallpaper/meta");
			const meta = (await meta1.json()) as { present: boolean; etag: string };
			assert.equal(meta.present, true);
			assert.equal(meta.etag, saved.etag);
			const get1 = await app.request("/api/v1/appearance/wallpaper");
			assert.equal(get1.status, 200);
			assert.equal(get1.headers.get("content-type"), "image/png");
			assert.equal((await get1.arrayBuffer()).byteLength, PNG_1PX.byteLength);

			// 不是图就拒（扩展名骗不过内容嗅探）
			const fakeForm = new FormData();
			fakeForm.set("file", new File(["not an image at all"], "a.png", { type: "image/png" }));
			const fake = await app.request("/api/v1/appearance/wallpaper", { method: "POST", body: fakeForm });
			assert.equal(fake.status, 415);

			// 超过 20MB 拒
			const bigForm = new FormData();
			bigForm.set(
				"file",
				new File([Buffer.concat([PNG_1PX, Buffer.alloc(WALLPAPER_MAX_BYTES)])], "big.png", {
					type: "image/png",
				}),
			);
			const big = await app.request("/api/v1/appearance/wallpaper", { method: "POST", body: bigForm });
			assert.equal(big.status, 413);

			// 删掉之后两个 GET 都回到"没有"
			const del = await app.request("/api/v1/appearance/wallpaper", { method: "DELETE" });
			assert.equal(del.status, 200);
			const meta2 = await app.request("/api/v1/appearance/wallpaper/meta");
			assert.deepEqual(await meta2.json(), { present: false });
			const get2 = await app.request("/api/v1/appearance/wallpaper");
			assert.equal(get2.status, 404);
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("端点：目录被占成文件（写不进去）时不炸服务，报 500", async () => {
	const base = tempDir();
	try {
		const blocked = join(base, "not-a-dir");
		writeFileSync(blocked, "x");
		await withEnvAsync("AGENT_WALLPAPER_DIR", blocked, async () => {
			const app = new Hono();
			mountAppearanceWallpaper(app);
			const form = new FormData();
			form.set("file", new File([PNG_1PX], "a.png", { type: "image/png" }));
			const post = await app.request("/api/v1/appearance/wallpaper", { method: "POST", body: form });
			assert.equal(post.status, 500);
		});
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});
