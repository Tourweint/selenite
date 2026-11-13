/**
 * 领域概览
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { el } from "./dom.js";
import { esc } from "./markdown.js";
import { request } from "./net.js";
import { go } from "./route.js";
import { autoSyncTick } from "./tasks-live.js";
import { STATE_ICON, statusError } from "./tasks-model.js";

/* ── 领域概览（E2 #3）───────────────────────────────────────
 * 侧栏「领域负责人」占位点亮为 #/domains。只读：GET /api/v1/domains。
 * 每行 领域 · 活跃单数(activeTickets) · 状态；error 行标红并给出错误文案；
 * 行点击跳 #/tasks?domain=<domain>（任务中心已有 domain 筛选）。 */

function showDomainsState(kind, title, text, action) {
  el.domainsState.hidden = false;
  el.domainsState.dataset.kind = kind;
  el.domainsState.replaceChildren();
  const icon = document.createElement("div");
  icon.className = "tasks-state-icon";
  icon.innerHTML = STATE_ICON[kind] || STATE_ICON.empty;
  const heading = document.createElement("h2");
  heading.textContent = title;
  const body = document.createElement("p");
  body.textContent = text;
  el.domainsState.append(icon, heading, body);
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ghost";
    button.textContent = action.label;
    button.addEventListener("click", action.run);
    el.domainsState.append(button);
  }
  el.domainsBody.hidden = true;
}

function hideDomainsState() {
  el.domainsState.hidden = true;
  el.domainsBody.hidden = false;
}

function renderDomains(rows) {
  el.domainsTitleSub.textContent = rows.length ? `${rows.length} 个领域` : "";
  if (!rows.length) {
    showDomainsState("empty", "还没有领域", "派活给某个领域后，这里会列出各领域的活跃单数与状态。");
    return;
  }
  hideDomainsState();
  const card = document.createElement("div");
  card.className = "card td-dom-list";
  card.innerHTML = rows
    .map((row, index) => {
      const domain = String(row.domain || "").trim();
      const error = String(row.error || "").trim();
      const active = Number(row.activeTickets) || 0;
      return `${index ? '<div class="divider"></div>' : ""}
        <div class="row td-dom-row" data-domain="${esc(domain)}"${error ? ' data-tone="fail"' : ""}
             role="link" tabindex="0" title="看「${esc(domain)}」的任务单">
          <div class="row-main">
            <div class="row-label">${esc(domain || "未命名领域")}</div>
            <div class="row-hint">${error ? esc(error) : `活跃 ${active} 单`}</div>
          </div>
          <div class="row-control">
            <span class="kv">活跃 ${active}</span>
            <span class="pill-tag ${error ? "warn" : "ok"}">${error ? "异常" : "正常"}</span>
          </div>
        </div>`;
    })
    .join("");
  el.domainsBody.replaceChildren(card);
}

async function loadDomains() {
  showDomainsState("loading", "读取中…", "正在读取领域清单");
  try {
    const response = await request("/api/v1/domains", { cache: "no-store" });
    if (!response.ok) throw statusError(response.status);
    const data = await response.json();
    renderDomains(Array.isArray(data.domains) ? data.domains : []);
  } catch (error) {
    // 照「当前项目 pill」的降级先例：读不到不白屏、不把错误吞掉，给一句说明 + 手动重试。
    showDomainsState(
      "error",
      "领域清单读不出来",
      `服务可能还没就绪，或接口暂时不可达（${error.message || ""}）。`,
      { label: "重试", run: () => void loadDomains() },
    );
  }
}

function openDomains() {
  void loadDomains();
}

el.domainsBack.addEventListener("click", () => go("chat"));
el.domainsRefresh.addEventListener("click", () => void loadDomains());
el.domainsBody.addEventListener("click", (event) => {
  const row = event.target.closest(".td-dom-row");
  if (!row || !row.dataset.domain) return;
  // 直接落 #/tasks?domain=<domain>：openTasks 会从 hash 恢复筛选，衔接任务中心既有 domain 筛选。
  location.hash = `#/tasks?domain=${encodeURIComponent(row.dataset.domain)}`;
});
el.domainsBody.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const row = event.target.closest(".td-dom-row");
  if (!row || !row.dataset.domain) return;
  event.preventDefault();
  location.hash = `#/tasks?domain=${encodeURIComponent(row.dataset.domain)}`;
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) autoSyncTick();
});

export { hideDomainsState, loadDomains, openDomains, renderDomains, showDomainsState };
