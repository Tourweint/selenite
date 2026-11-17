import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * web/*.js 的静态导入护栏（2026-11-17 批2 复核补）。
 *
 * 起因：partner-sessions-ui.js 曾从 partners-status.js 导入一个并不存在的命名导出
 * （renderRoster），node --check 查不出，浏览器直接整页白屏。这里只用 node 内置模块
 * 扫一遍相对命名导入，名字对不上就红，且一次列全所有缺口。
 */

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../web");

/** 去掉注释，避免注释里的示例代码被当成真实 import / export。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** 收集一个模块的命名导出（声明式 + `export { ... }` + `export { ... } from "./x"` 转出）。 */
function collectExports(src) {
  const names = new Set();
  const decl = /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g;
  let match;
  while ((match = decl.exec(src))) {
    if (match[1] !== "default") names.add(match[1]);
  }
  const braces = /\bexport\s*\{([^}]*)\}/g;
  while ((match = braces.exec(src))) {
    for (const part of match[1].split(",")) {
      const spec = part.trim();
      if (!spec || spec === "default") continue;
      const as = /\bas\s+([A-Za-z_$][\w$]*)/.exec(spec);
      const exported = as ? as[1] : spec.replace(/^type\s+/, "").trim();
      if (/^[A-Za-z_$][\w$]*$/.test(exported)) names.add(exported);
    }
  }
  return names;
}

/** 收集 `import { ... } from "./x.js"`：只要相对路径、只要命名导入，忽略 default / type。 */
function collectImports(src) {
  const found = [];
  const re = /\bimport\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  let match;
  while ((match = re.exec(src))) {
    const spec = match[2];
    if (!spec.startsWith(".")) continue;
    for (const part of match[1].split(",")) {
      const specifier = part.trim();
      if (!specifier || specifier === "default") continue;
      const as = /^([A-Za-z_$][\w$]*)\s+as\s+/.exec(specifier);
      const name = as ? as[1] : specifier.replace(/^type\s+/, "").trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) found.push({ spec, name });
    }
  }
  return found;
}

function resolveTarget(fromFile, spec) {
  const path = resolve(dirname(fromFile), spec);
  return path.endsWith(".js") ? path : `${path}.js`;
}

test("web/*.js 的相对命名导入都能在目标模块的命名导出里找到", () => {
  const files = readdirSync(WEB_DIR)
    .filter((name) => name.endsWith(".js"))
    .map((name) => join(WEB_DIR, name));
  assert.ok(files.length > 0, "没扫到 web/*.js");

  const exportsByFile = new Map();
  const sources = new Map();
  for (const file of files) {
    const src = stripComments(readFileSync(file, "utf8"));
    sources.set(file, src);
    exportsByFile.set(file, collectExports(src));
  }

  const missing = [];
  for (const file of files) {
    for (const { spec, name } of collectImports(sources.get(file))) {
      const target = resolveTarget(file, spec);
      const targetExports = exportsByFile.get(target);
      // 目标不在 web/*.js（本仓目前没有这种相对导入）：无从判定，跳过而不是误报。
      if (!targetExports) continue;
      if (!targetExports.has(name)) missing.push(`${basename(file)} → ${spec} → ${name}`);
    }
  }
  assert.deepEqual(missing, [], `命名导入不存在（一次列全）：\n${missing.join("\n")}`);
});
