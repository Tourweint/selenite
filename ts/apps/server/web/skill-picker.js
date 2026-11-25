/**
 * 技能斜杠选择器（输入 / 出技能单）
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { el } from "./dom.js";
import { esc } from "./markdown.js";
import { request } from "./net.js";
import { popAnimateIn, popAnimateOut } from "./pop-anim.js";

/* ── 技能斜杠选择器（2026-11-09 用户口径：对话输入「/」出技能单，回车/点击补全）──
 * 只列**开着**的技能（全关时输入 / 不弹单，打字不受任何干扰）。
 * 补全成「/名字 」后继续打指令；发送后服务端把手册整份注入那一轮（lifecycle beforeRequest）。 */

const skillSuggest = { el: null, items: [], index: 0, cacheAt: 0 };

/* 进出场动画（2026-11-25）：收起跑 140ms 才把 display 置 none，
 * 这段窗口里 display 还是 "block"，不能拿它当"开没开"的判据——否则键盘监听会继续
 * 截 Enter（刚按 Esc 收掉，紧接着的 Enter 会把旧候选补进去）。逻辑态单独记。 */
let seq = 0;
let skillSuggestShown = false;

function skillSuggestNode() {
  if (!skillSuggest.el) {
    const node = document.createElement("div");
    node.id = "skill-suggest";
    node.setAttribute("role", "listbox");
    node.setAttribute("aria-label", "技能补全");
    // 建出来就先藏住：空壳（min-width 300px）在屏上闪一下比没有更难看
    node.style.display = "none";
    document.body.append(node);
    skillSuggest.el = node;
  }
  return skillSuggest.el;
}

/** 输入框整串是「/xxx」才算（打完空格开始写指令就不弹了） */
function skillSuggestPrefix(text) {
  return /^\/([a-z0-9][a-z0-9-_]*)$/i.exec(String(text || "").trimStart());
}

async function skillSuggestItems() {
  if (Date.now() - skillSuggest.cacheAt < 30_000 && skillSuggest.items) return skillSuggest.items;
  try {
    const response = await request("/api/v1/agent/skills", { cache: "no-store" });
    if (!response.ok) return [];
    const data = await response.json().catch(() => ({}));
    skillSuggest.items = (Array.isArray(data.items) ? data.items : []).filter((item) => item.enabled);
    skillSuggest.cacheAt = Date.now();
  } catch {
    skillSuggest.items = [];
  }
  return skillSuggest.items;
}

async function refreshSkillSuggest() {
  const input = el.input;
  const node = skillSuggestNode();
  const match = input ? skillSuggestPrefix(input.value) : null;
  if (!match) {
    closeSkillSuggest();
    return;
  }
  const all = await skillSuggestItems();
  const prefix = match[1].toLowerCase();
  const items = all.filter((item) => String(item.name || "").startsWith(prefix));
  if (!items.length) {
    closeSkillSuggest();
    return;
  }
  skillSuggest.items = items;
  skillSuggest.index = Math.min(skillSuggest.index, items.length - 1);
  node.replaceChildren(
    ...items.map((item, index) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "skill-suggest-item" + (index === skillSuggest.index ? " is-active" : "");
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(index === skillSuggest.index));
      row.innerHTML = `<span class="s-name">/${esc(item.name)}</span><span class="s-sum">${esc(String(item.summary || ""))}</span>`;
      row.addEventListener("click", () => applySkillSuggest(item.name));
      row.addEventListener("mousemove", () => {
        if (skillSuggest.index === index) return;
        skillSuggest.index = index;
        paintSkillSuggest();
      });
      return row;
    }),
  );
  const rect = input.getBoundingClientRect();
  node.style.display = "block";
  const box = node.getBoundingClientRect();
  let top = rect.top - box.height - 6;
  if (top < 8) top = rect.bottom + 6;
  node.style.left = `${Math.round(Math.max(8, rect.left))}px`;
  node.style.top = `${Math.round(top)}px`;
  // 入场（2026-11-25）：只有「隐藏 → 显示」那一下播；已经显示时只换候选内容，
  // 不然输入每个字符都放一遍 160ms 动画，整张单子一直在抖。
  seq += 1; // 让还在跑的关闭回调失效
  if (skillSuggestShown) return;
  skillSuggestShown = true;
  popAnimateIn(node);
}

function paintSkillSuggest() {
  const node = skillSuggest.el;
  if (!node) return;
  node.querySelectorAll(".skill-suggest-item").forEach((row, index) => {
    row.classList.toggle("is-active", index === skillSuggest.index);
    row.setAttribute("aria-selected", String(index === skillSuggest.index));
  });
}

function applySkillSuggest(name) {
  const input = el.input;
  if (input) {
    input.value = `/${name} `;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
  }
  closeSkillSuggest();
}

function closeSkillSuggest() {
  skillSuggest.index = 0;
  const node = skillSuggest.el;
  // 从未显示过（只是建了个空壳）或已经关掉：直接按死，不跑动画
  if (!node || node.style.display === "none") return;
  // 逻辑态已关但 display 还是 block = 收起动画正在跑，别起第二遍
  if (!skillSuggestShown) return;
  skillSuggestShown = false;
  const mine = ++seq;
  popAnimateOut(node).then(() => {
    if (mine !== seq) return; // 已被重新打开，别藏
    node.style.display = "none";
  });
}

// 挂在 document 捕获段：抢在 composer 的 Enter 发送之前处理补全键
document.addEventListener(
  "keydown",
  (event) => {
    const node = skillSuggest.el;
    if (!node || !skillSuggestShown || !node.firstElementChild) return;
    if (event.target !== el.input) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopImmediatePropagation();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      skillSuggest.index = (skillSuggest.index + delta + skillSuggest.items.length) % skillSuggest.items.length;
      paintSkillSuggest();
    } else if (event.key === "Enter" || event.key === "Tab") {
      const picked = skillSuggest.items[skillSuggest.index];
      if (picked) {
        event.preventDefault();
        event.stopImmediatePropagation();
        applySkillSuggest(picked.name);
      }
    } else if (event.key === "Escape") {
      event.stopImmediatePropagation();
      closeSkillSuggest();
    }
  },
  true,
);

export { applySkillSuggest, closeSkillSuggest, paintSkillSuggest, refreshSkillSuggest, skillSuggest, skillSuggestItems, skillSuggestNode, skillSuggestPrefix };
