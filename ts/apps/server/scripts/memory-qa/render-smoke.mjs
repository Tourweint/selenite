// 轻量 DOM 冒烟：不引浏览器，用最小假 DOM 跑 memorySettingsMarkup 的纯模板部分，
// 断言我新增的节点与 id 都存在、且 renderMemoryList 的分组顺序正确。
import { readFileSync } from "node:fs";
// 2026-11-13：记忆页从 web/app.js 拆出后落在 settings-memory.js。
// 取的是旧版 A 页模板（函数已改名 memorySettingsMarkupLegacy；新版 A/B 页的
// memorySettingsMarkup 在 memory-page.js，字段口径不同，不是这份断言的对象）。
const js = readFileSync(new URL("../../web/settings-memory.js", import.meta.url), "utf8");

function extract(name, kind = "function") {
  const start = js.indexOf(`${kind} ${name}(`);
  if (start < 0) throw new Error(`not found: ${name}`);
  let depth = 0, i = js.indexOf("{", start);
  const from = i;
  for (; i < js.length; i++) {
    if (js[i] === "{") depth++;
    else if (js[i] === "}") { depth--; if (depth === 0) break; }
  }
  return js.slice(start, i + 1);
}

const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
// 与 web/markdown.js 里的 attr 同义：属性值转义（记忆页的 data-tip 用）
const attr = (text) => esc(String(text ?? "")).replace(/"/g, "&quot;");
const sectionMarkup = (title, body) => `<section class="set-sec"><h2>${title}</h2>${body}</section>`;
const rowMarkup = (label, hint, control) => `<div class="row"><div class="row-main"><div class="row-label">${label}</div><div class="row-hint">${hint || ""}</div></div><div class="row-control">${control}</div></div>`;

const consts = js.slice(js.indexOf("const MEMORY_KIND_LABEL"), js.indexOf("function memorySettingsMarkup"));
const markupSrc = extract("memorySettingsMarkupLegacy");
const renderSrc = extract("renderMemoryList");
const itemSrc = extract("memoryItemMarkup");

const factory = new Function(
  "sectionMarkup", "rowMarkup", "esc", "attr", "wireMemoryActions",
  `${consts}\n${markupSrc}\n${renderSrc}\n${itemSrc}\nreturn { memorySettingsMarkupLegacy, renderMemoryList };`
);
const api = factory(sectionMarkup, rowMarkup, esc, attr, () => {});

const page = api.memorySettingsMarkupLegacy();
for (const id of ["mem-status", "mem-extract", "mem-list", "mem-empty"]) {
  if (!page.includes(`id="${id}"`)) throw new Error(`记忆页缺节点 ${id}`);
}
console.log("✓ 记忆页四个节点都在");

// renderMemoryList：给一个假 box，收集 innerHTML
const items = [
  { id: "a", kind: "episode", content: "一段经历", createdAt: "2026-11-01T00:00:00Z", recallCount: 0 },
  { id: "b", kind: "preference", content: "不喜欢被追问\nWhy: 会累\nHow: 一次一个", createdAt: "2026-11-02T00:00:00Z", recallCount: 3 },
  { id: "c", kind: "fact", content: "住在上海", createdAt: "2026-11-03T00:00:00Z", recallCount: 0 },
];
const box = { innerHTML: "", querySelectorAll: () => [] };
api.renderMemoryList(box, items);
const html = box.innerHTML;
const order = ["偏好", "事实", "经历"].map((label) => html.indexOf(`>${label}<`));
if (order.some((v) => v < 0) || !(order[0] < order[1] && order[1] < order[2])) {
  throw new Error(`分组顺序不对：${JSON.stringify(order)}`);
}
if (!html.includes("Why: 会累")) throw new Error("Why 段丢了");
if (!html.includes("想起 3 次")) throw new Error("召回次数丢了");
if ((html.match(/data-mem-forget=/g) || []).length !== 3) throw new Error("删除按钮数量不对");
if ((html.match(/data-mem-supersede=/g) || []).length !== 3) throw new Error("标过时按钮数量不对");
if (!html.includes("标过时")) throw new Error("标过时按钮文案丢了");
if (!html.includes("&gt;") && html.includes("<script")) throw new Error("未转义");
console.log("✓ 列表分组顺序 / Why 段 / 召回次数 / 删除按钮 全部正确");
