/**
 * 服务端单文件构建（2026-11-08 扫尾批 4b，方案 §三a）。
 *
 * 目标：`pnpm --filter @lifediary/server build` → `dist/` 一份**自足**的产物，
 * `node dist/index.js` 就能起服务。源码一行不动：三处资源读盘都是
 * `new URL("../web|skills|prompts/", import.meta.url)`，靠"产物放在哪一层"满足。
 *
 *   src/web.ts   → `../web/`    → 源码态 <server>/web      dist 态 <dist>/web
 *   src/tasks.ts → `../prompts/`→ 源码态 <server>/prompts  dist 态 <dist>/prompts
 *   src/agent.ts → `../skills`  → 源码态 <server>/skills   dist 态 <dist>/skills
 *
 * 注意相对位（任务书写成"dist/index.js + dist/web"是对不上的一环）：
 * `../web` 只跟**文件所在目录**有关，与文件名无关。`dist/index.js` 上一级是
 * `<server>/`，不是 `dist/`——那样 dist 根本不自足。所以真正的 bundle 落
 * `dist/src/index.js`（与源码 src/ 同深度），`dist/index.js` 只是一行入口壳：
 *
 *   dist/index.js      → import "./src/index.js"（入口，满足 `node dist/index.js`）
 *   dist/src/index.js  → esbuild bundle（import.meta.url 指向它自己）
 *   dist/web|skills|prompts/ → 与 src/ 同一层的资源，`../` 正好命中
 *
 * 不打包的东西：
 *   - node 内置模块（含 `node:sqlite`）——esbuild platform=node 自动外置；
 *   - 第三方依赖——全部打进 bundle（产物不再需要 node_modules）；
 *   - `.data/` 与 `.env`——运行时数据/密钥，照旧落在 **cwd**，不跟产物走。
 *
 * 不做 SEA（方案 §三e 登记观望）：这里只保证"能起、能服务"。
 */
import { cp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/** apps/server（scripts/ 的上一级） */
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(ROOT, "dist");
/** bundle 落点：必须与源码 src/ 同深度，`../<资源>` 才对得上 dist/<资源> */
const BUNDLE = join(DIST, "src", "index.js");
/** 按 import.meta.url 相对位复制的资源目录（源码里就这三处） */
const RESOURCES = ["web", "skills", "prompts"];

const nodeTarget = `node${process.versions.node.split(".")[0]}`;

async function assertCopy(src, dst) {
	const info = await stat(dst).catch(() => null);
	if (!info?.isDirectory()) throw new Error(`资源没复制成功：${dst}（来自 ${src}）`);
}

await rm(DIST, { recursive: true, force: true });
await mkdir(join(DIST, "src"), { recursive: true });

await build({
	entryPoints: [join(ROOT, "src", "index.ts")],
	outfile: BUNDLE,
	bundle: true,
	platform: "node",
	format: "esm",
	target: nodeTarget,
	// 让 `.ts` 相对导入（含 workspace 的 @lifediary/*）按 TS 规则解析
	resolveExtensions: [".ts", ".tsx", ".mjs", ".js", ".json"],
	logLevel: "info",
	// CJS 依赖（qrcode 等）转成 ESM 后若留下 require，给它一个真 require；
	// 否则 esbuild 的 `__require` 在 ESM 里一调就抛 "Dynamic require ... not supported"。
	banner: {
		js: "import { createRequire as __lifediaryCreateRequire } from 'node:module';\nconst require = __lifediaryCreateRequire(import.meta.url);",
	},
});

// 插件清单是运行期输入（flags.ts 用 import.meta.url 相对读）：必须跟着 bundle 落到同一层
await cp(join(ROOT, "src", "plugins.json"), join(DIST, "src", "plugins.json"));
const manifest = await stat(join(DIST, "src", "plugins.json")).catch(() => null);
if (!manifest?.isFile()) throw new Error("插件清单没复制成功：dist/src/plugins.json");

// 入口壳：`node dist/index.js` 与文档/探针口径一致，真正执行的是 src/index.js
await writeFile(
	join(DIST, "index.js"),
	'// 生成物（scripts/build.mjs）。真正的 bundle 在 ./src/index.js，' +
		"分这一层是为了让 `../web` 之类的相对资源落在 dist/ 里。\n" +
		'import "./src/index.js";\n',
	"utf8",
);

for (const dir of RESOURCES) {
	const from = join(ROOT, dir);
	const to = join(DIST, dir);
	await cp(from, to, { recursive: true });
	await assertCopy(from, to);
}

const size = (await stat(BUNDLE)).size;
console.log(
	`build: ${BUNDLE} (${(size / 1024 / 1024).toFixed(1)} MiB, target ${nodeTarget})`,
);
console.log(`build: 资源已按相对位复制 → ${RESOURCES.map((d) => `dist/${d}`).join("、")}`);
console.log("build: 插件清单已复制 → dist/src/plugins.json");
