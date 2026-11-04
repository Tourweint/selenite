import { readFile } from "node:fs/promises";
import type { Hono } from "hono";
import { attachLocalCredential } from "./auth.ts";

/**
 * 界面（`web/`）由服务自己发。
 *
 * 为什么不做成单独的静态服务 / 塞进桌面壳里：界面和 API 同源，就没有 CORS、
 * 没有跨域 cookie、没有第二份部署。浏览器、桌面壳、（以后）手机 WebView
 * 打开的是同一个地址，看到的是同一份代码。
 *
 * 没有打包步骤：三个文件，改完刷新就见效。真要上框架了再引构建链，
 * 现在这一层不值得。
 */
const WEB_DIR = new URL("../web/", import.meta.url);

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
};

export function mountWeb(app: Hono): void {
	// 每次都读盘：这是本地单人服务，省掉热更新的同时也就省掉了"改了没生效"的困惑。
	app.get("/", async (c) => {
		const html = await readFile(new URL("index.html", WEB_DIR), "utf8");
		// 本机打开时顺手发一枚本地凭据，后续 /api/v1 请求自动带上，不用手填令牌。
		attachLocalCredential(c);
		return c.html(html, 200, { "cache-control": "no-store" });
	});

	app.get("/assets/:file", async (c) => {
		const name = c.req.param("file");
		// 只允许白名单形状的文件名，挡掉 `..` 一类的路径穿越
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return c.notFound();
		const ext = name.slice(name.lastIndexOf("."));
		const type = CONTENT_TYPES[ext];
		if (!type) return c.notFound();
		try {
			// 二进制读：.png 这类资源不能按 utf8 解码；文本资源发原始 UTF-8 字节也一样
			const body = await readFile(new URL(name, WEB_DIR));
			return c.body(body, 200, { "content-type": type, "cache-control": "no-store" });
		} catch {
			return c.notFound();
		}
	});
}
