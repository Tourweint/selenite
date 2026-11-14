import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Hono } from "hono";

/**
 * 壁纸（2026-11-14 外观页扩展）：把一张图存成本地文件，界面按 `--wallpaper-image` 铺在主区那张纸上。
 *
 * 为什么要有这一层：界面是浏览器/WebView 打开的 http 页面，`file://` 背景图会被同源策略挡掉，
 * 所以图片必须由服务自己回传——一个存盘目录 + 一个 GET，最省事，也不需要壳侧配合。
 *
 * 位置：`.data/appearance/`（AGENT_WALLPAPER_DIR 可改）；`wallpaper.<ext>` 是图本体，
 * `wallpaper.json` 记 mime / 体积 / etag。单张覆盖写，不留历史版本（本地单人用不上）。
 *
 * 只有图和 mime 在服务端；「可见度 / 模糊 / 用哪张」都在前端 localStorage
 * （跟着主题、强调色一样是这台设备的外观偏好，不是账号级配置）。
 *
 * 回滚：AGENT_APPEARANCE_WALLPAPER=0 → 整组路由不挂（404 = 未启用），界面那块也自己藏掉。
 */

export const WALLPAPER_MAX_BYTES = 20 * 1024 * 1024;

type AllowedMime = "image/png" | "image/jpeg" | "image/webp";

const EXT_OF: Record<AllowedMime, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/webp": ".webp",
};

export interface WallpaperState {
	present: boolean;
	mime?: AllowedMime;
	bytes?: number;
	etag?: string;
	savedAt?: number;
}

export function wallpaperEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env.AGENT_APPEARANCE_WALLPAPER ?? "").trim().toLowerCase();
	if (!raw) return true;
	return raw !== "false" && raw !== "0" && raw !== "off";
}

export function wallpaperDir(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(env.AGENT_WALLPAPER_DIR?.trim() || ".data/appearance");
}

function metaPath(dir: string): string {
	return join(dir, "wallpaper.json");
}

function readMeta(dir: string): (Omit<WallpaperState, "present"> & { mime: AllowedMime }) | null {
	try {
		const parsed = JSON.parse(readFileSync(metaPath(dir), "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object") return null;
		const value = parsed as Record<string, unknown>;
		const mime = value.mime;
		if (mime !== "image/png" && mime !== "image/jpeg" && mime !== "image/webp") return null;
		if (typeof value.bytes !== "number" || typeof value.etag !== "string") return null;
		return {
			mime,
			bytes: value.bytes,
			etag: value.etag,
			savedAt: typeof value.savedAt === "number" ? value.savedAt : undefined,
		};
	} catch {
		/* 文件不存在 / 坏 JSON：当作没设壁纸 */
	}
	return null;
}

/** 当前状态；meta 不在了但图还在（手删了 json）也当没有，避免回传孤儿文件。 */
export function readWallpaperState(dir = wallpaperDir()): WallpaperState {
	const meta = readMeta(dir);
	if (!meta) return { present: false };
	const path = join(dir, `wallpaper${EXT_OF[meta.mime]}`);
	if (!existsSync(path)) return { present: false };
	try {
		const size = statSync(path).size;
		return { present: true, mime: meta.mime, bytes: size, etag: meta.etag, savedAt: meta.savedAt };
	} catch {
		return { present: false };
	}
}

function atomicWrite(path: string, content: Buffer | string): void {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
	try {
		writeFileSync(temp, content);
		renameSync(temp, path);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

/** 落盘 + 清掉别的扩展名的旧图（png 换 jpg 时不留两份）。返回新状态。 */
export function saveWallpaper(buffer: Buffer, mime: AllowedMime, dir = wallpaperDir()): WallpaperState {
	if (buffer.byteLength > WALLPAPER_MAX_BYTES) throw new Error(`壁纸不能超过 ${WALLPAPER_MAX_BYTES} 字节`);
	if (buffer.byteLength === 0) throw new Error("壁纸是空文件");
	const ext = EXT_OF[mime];
	const etag = createHash("sha1").update(buffer).digest("hex").slice(0, 12);
	for (const other of Object.values(EXT_OF)) {
		if (other === ext) continue;
		rmSync(join(dir, `wallpaper${other}`), { force: true });
	}
	atomicWrite(join(dir, `wallpaper${ext}`), buffer);
	atomicWrite(
		metaPath(dir),
		JSON.stringify({ mime, bytes: buffer.byteLength, etag, savedAt: Date.now() }, null, 2),
	);
	// 回读一遍：返回值的形状要和 GET meta 完全一致（含 savedAt），前端才不会两处对不上
	return readWallpaperState(dir);
}

export function removeWallpaper(dir = wallpaperDir()): void {
	for (const ext of Object.values(EXT_OF)) rmSync(join(dir, `wallpaper${ext}`), { force: true });
	rmSync(metaPath(dir), { force: true });
}

/** 上传时按内容嗅探，不信客户端给的 filename/type（本地仓已经这么办，见 attachments 一侧）。 */
function sniffImage(buffer: Buffer): AllowedMime | null {
	if (buffer.byteLength < 12) return null;
	if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "image/png";
	if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
	// RIFF....WEBP
	if (
		buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
		buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
	) return "image/webp";
	return null;
}

export function mountAppearanceWallpaper(app: Hono): void {
	app.get("/api/v1/appearance/wallpaper/meta", (c) => {
		return c.json(readWallpaperState(), 200, { "cache-control": "no-store" });
	});

	app.get("/api/v1/appearance/wallpaper", (c) => {
		const state = readWallpaperState();
		if (!state.present || !state.mime || !state.etag) return c.notFound();
		const path = join(wallpaperDir(), `wallpaper${EXT_OF[state.mime]}`);
		let body: Buffer;
		try {
			body = readFileSync(path);
		} catch {
			return c.notFound();
		}
		// Hono 的 Data 只收 Uint8Array<ArrayBuffer>：Buffer 的 buffer 可能是 SharedArrayBuffer，
		// 直接传过不了类型（运行时没问题，编译期不收），拷一份换成普通 Uint8Array。
		const bytes = new Uint8Array(body.byteLength);
		bytes.set(body);
		return c.body(bytes, 200, {
			"content-type": state.mime,
			// 带上 ?v=<etag> 才命中缓存；换图即换 etag，所以可以直接长期缓存
			"cache-control": "public, max-age=31536000, immutable",
			etag: `"${state.etag}"`,
		});
	});

	app.post("/api/v1/appearance/wallpaper", async (c) => {
		let file: File | null = null;
		try {
			const form = await c.req.formData();
			const candidate = form.get("file");
			file = typeof candidate === "object" && candidate !== null && "arrayBuffer" in candidate
				? (candidate as File)
				: null;
		} catch {
			return c.json({ error: "要按 multipart 传一张图（字段名 file）" }, 400);
		}
		if (!file) return c.json({ error: "没有收到文件（字段名 file）" }, 400);
		if (file.size > WALLPAPER_MAX_BYTES) {
			return c.json({ error: `壁纸不能超过 ${Math.round(WALLPAPER_MAX_BYTES / 1024 / 1024)} MB` }, 413);
		}
		const buffer = Buffer.from(await file.arrayBuffer());
		const mime = sniffImage(buffer);
		if (!mime) return c.json({ error: "只收 PNG / JPEG / WebP" }, 415);
		try {
			return c.json(saveWallpaper(buffer, mime), 200, { "cache-control": "no-store" });
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : "存盘失败" }, 500);
		}
	});

	app.delete("/api/v1/appearance/wallpaper", (c) => {
		try {
			removeWallpaper();
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : "删除失败" }, 500);
		}
		return c.json({ present: false }, 200, { "cache-control": "no-store" });
	});
}
