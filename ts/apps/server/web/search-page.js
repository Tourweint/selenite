/**
 * 搜索独立页
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { openConversation } from "./chat-open.js";
import { chatLabel } from "./chats-list.js";
import { el } from "./dom.js";
import { esc } from "./markdown.js";
import { request } from "./net.js";
import { go } from "./route.js";
import { markQuery } from "./settings-base.js";
import { state } from "./state.js";

/* ── 搜索页（2026-11-12）───────────────────────────────
 * 界面上唯一的搜索。一次输入同时匹配标题与原文，结果**按对话分组**：
 * 旧版把「标题命中」和「正文命中」排成上下两组，而会话标题通常就是第一句——同一句
 * 于是出现两遍（用户实测："一搜搜出两句话来"）。现在同一段话只出现一次：
 * 有正文命中的会话走正文片段；只在标题里命中的会话补一条"标题命中"。
 *
 * 数据：标题 = 本地 state.chats 即时筛（可见会话，零等待）；
 *      原文 = GET /agent/sessions/search（默认最近一年、单页 20 条；全部会话、整段历史，
 *             含任务专线/已归档，和总管在对话里用的 recall_sessions 同源）。
 * 点片段 = 回原会话并定位到那一句（jumpToAnchor）；点组头 = 只打开会话。
 * 结果多时底部「查看更多」按 offset 翻页；默认一年，底部另有「搜索更早的历史」。
 * 刻意不做：筛选器 / 排序 / 搜索历史——先把"一处搜、点得到"做对。 */
const SEARCH_DAYS_DEFAULT = 365; // 默认窗口：一年
const SEARCH_DAYS_ALL = 36_500; // 约一百年 = 不设实际下限（服务端上限同口径）
const SEARCH_PAGE_SIZE = 20; // 单页 20（服务端上限），翻页靠 offset
const searchView = {
  timer: 0,
  seq: 0,
  query: "",
  days: SEARCH_DAYS_DEFAULT,
  hits: [],
  total: 0,
  /** 服务端是否回 total（新版本才支持分页/放宽窗口）；老服务端只出结果、不出翻页入口 */
  hasTotal: true,
};

/** 新查询/清空时把窗口与累计结果归位（默认回到一年） */
function resetSearchState(query) {
  searchView.query = String(query || "").trim();
  searchView.days = SEARCH_DAYS_DEFAULT;
  searchView.hits = [];
  searchView.total = 0;
}

function wireSearchPage() {
  if (!el.searchInput) return;
  el.searchInput.addEventListener("input", () => {
    clearTimeout(searchView.timer);
    const query = el.searchInput.value.trim();
    if (query.length < 2) {
      // 1 个字先给标题命中，别让人对着空屏等防抖
      searchView.seq += 1; // 作废还在飞的请求
      resetSearchState(query);
      renderSearchGroups(query, []);
      return;
    }
    searchView.timer = window.setTimeout(() => void runSearchPage(query), 300);
  });
  el.searchInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    clearTimeout(searchView.timer);
    void runSearchPage(el.searchInput.value.trim());
  });
  el.searchBack?.addEventListener("click", () => go("chat"));
  el.searchEntry?.addEventListener("click", () => go("search"));
  // 首次进页：把空态说明画上（列表区不是模板里写死的）
  renderSearchGroups("", []);
}

/**
 * 查询词 → 请求 → 渲染。seq 防抖：慢请求回来时用户已经改了字就丢掉。
 * mode：
 *   - "new"   新查询：窗口回一年、清空累计；
 *   - "more"  翻页：沿用窗口与累计，offset = 已加载条数；
 *   - "widen" 查看更多历史：窗口放到一百年，从第一页重来。
 */
async function runSearchPage(query, { mode = "new" } = {}) {
  if (!el.searchResults) return;
  const q = String(query || "").trim();
  if (q.length < 2) {
    resetSearchState(q);
    renderSearchGroups(q, []);
    return;
  }
  if (mode === "new") {
    resetSearchState(q);
  } else if (mode === "widen") {
    searchView.query = q;
    searchView.days = SEARCH_DAYS_ALL;
    searchView.hits = [];
    searchView.total = 0;
  } else if (searchView.query !== q) {
    // 防误用：翻页必须延续同一个查询，否则当新查询处理
    resetSearchState(q);
    mode = "new";
  }
  const seq = ++searchView.seq;
  const offset = mode === "more" ? searchView.hits.length : 0;
  if (el.searchHint) {
    el.searchHint.hidden = false;
    el.searchHint.textContent = mode === "more" ? "读取更多…" : "查找中…";
    el.searchHint.classList.remove("is-error");
  }
  let pageHits = [];
  let total = searchView.total;
  let errorText = "";
  try {
    const response = await request(
      `/api/v1/agent/sessions/search?q=${encodeURIComponent(q)}&days=${searchView.days}&limit=${SEARCH_PAGE_SIZE}&offset=${offset}`,
      { cache: "no-store" },
    );
    if (seq !== searchView.seq) return;
    if (response.status === 404) {
      errorText = "原文检索未启用（服务端 AGENT_SESSIONS_SEARCH=false），现在只能按标题找。";
    } else if (!response.ok) {
      errorText = `原文检索失败（${response.status}），现在只能按标题找。`;
    } else {
      const data = await response.json().catch(() => ({}));
      pageHits = Array.isArray(data.hits) ? data.hits : [];
      // 老服务端没有 total：退化成"已加载条数"，并且不显示翻页/放宽窗口入口
      searchView.hasTotal = Number.isFinite(Number(data.total));
      total = searchView.hasTotal ? Number(data.total) : null;
    }
  } catch (error) {
    if (seq !== searchView.seq) return;
    if (error.message !== "forbidden") errorText = `原文检索失败：${error.message}`;
  }
  if (seq !== searchView.seq) return;
  searchView.hits = mode === "more" ? searchView.hits.concat(pageHits) : pageHits;
  searchView.total = total === null ? searchView.hits.length : total;
  renderSearchGroups(searchView.query, searchView.hits, { errorText });
}

/** 查询词是否命中一个会话的标题 / 首句（与旧版设置页搜索同一判据） */
function chatMatchesQuery(chat, query) {
  return `${chat.title || ""} ${chat.firstText || ""}`.toLowerCase().includes(query.toLowerCase());
}

/**
 * 把「正文命中 + 标题命中」合成同一份分组。
 * - 同一 conversationId = 一组（标题只用来补正文没命中的会话，绝不重复出行）；
 * - 组内按 at + 片段去重（服务端本来就是一条消息一个 hit，这里只是兜底）；
 * - 按"最近命中/最近活动"倒序，最近聊过的浮上来。
 */
function groupSearchHits(query, hits) {
  const groups = new Map();
  for (const hit of hits) {
    if (!hit || !hit.conversationId) continue;
    let group = groups.get(hit.conversationId);
    if (!group) {
      group = { conversationId: hit.conversationId, title: hit.title || "", hits: [], lastAt: 0, turns: 0, seen: new Set() };
      groups.set(hit.conversationId, group);
    }
    const key = `${hit.at}|${hit.snippet || ""}`;
    if (group.seen.has(key)) continue;
    group.seen.add(key);
    group.hits.push(hit);
    group.lastAt = Math.max(group.lastAt, Number(hit.at) || 0);
  }
  for (const chat of state.chats) {
    if (!chatMatchesQuery(chat, query)) continue;
    const existing = groups.get(chat.conversationId);
    if (existing) {
      existing.turns = Number(chat.turns) || 0;
      continue;
    }
    groups.set(chat.conversationId, {
      conversationId: chat.conversationId,
      title: chatLabel(chat),
      hits: [],
      lastAt: Number(chat.lastAt) || 0,
      turns: Number(chat.turns) || 0,
      titleOnly: true,
    });
  }
  // 组内命中按时间倒序；组之间按最近活动倒序
  for (const group of groups.values()) {
    group.hits.sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
  }
  return [...groups.values()].sort((a, b) => b.lastAt - a.lastAt);
}

/** 搜索页的时间说法：今天只给时分，今年省掉年份。 */
function searchTimeText(at) {
  const value = Number(at);
  if (!Number.isFinite(value) || value <= 0) return "";
  const date = new Date(value);
  const now = new Date();
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (date.toDateString() === now.toDateString()) return `今天 ${time}`;
  const md = `${date.getMonth() + 1}/${date.getDate()} ${time}`;
  return date.getFullYear() === now.getFullYear() ? md : `${date.getFullYear()}/${md}`;
}

function renderSearchGroups(query, hits, { errorText = "" } = {}) {
  const box = el.searchResults;
  if (!box) return;
  const q = String(query || "").trim();

  if (!q) {
    if (el.searchTitleSub) el.searchTitleSub.textContent = "";
    if (el.searchHint) {
      el.searchHint.hidden = false;
      el.searchHint.textContent = "至少 2 个字。会翻最近一年的全部旧对话（含任务专线与已归档的）。";
    }
    box.innerHTML = `<div class="sr-empty">在旧对话里搜一句话。标题和原文一起搜，点结果回到当时那句。</div>`;
    return;
  }

  const groups = groupSearchHits(q, hits);
  const loaded = hits.length;
  const total = Math.max(Number(searchView.total) || 0, loaded);
  const countText = loaded
    ? loaded < total
      ? `已显示 ${loaded}/${total} 处`
      : `${loaded} 处命中`
    : "标题命中";
  if (el.searchTitleSub) {
    el.searchTitleSub.textContent = groups.length ? `${groups.length} 个对话 · ${countText}` : "";
  }
  if (el.searchHint) {
    // 1 个字只筛标题：别让人以为"没有找到"，直说还差一个字
    const message = errorText || (q.length < 2 ? "再输一个字就能搜原文。" : groups.length ? "" : "没有找到。换个词试试。");
    el.searchHint.hidden = !message;
    el.searchHint.textContent = message;
    el.searchHint.classList.toggle("is-error", Boolean(errorText));
  }
  box.replaceChildren();
  for (const group of groups) box.append(searchGroupNode(group, q));
  // 底部两件事（2026-11-12）：同一窗口还有更多 → 翻页；默认一年 → 可扩到更早。
  // 无结果时也留着"更早的历史"：很可能只是这一年里没说过。
  if (q.length >= 2 && !errorText) {
    const foot = document.createElement("div");
    foot.className = "sr-foot";
    if (!searchView.hasTotal) {
      // 服务端还是旧版本（没有 total/offset）：直说，别摆一个点了没用的按钮
      const note = document.createElement("span");
      note.className = "sr-scope-note";
      note.textContent = "服务端是旧版本：重启服务后才能查看更多、搜更早的历史";
      foot.append(note);
    } else {
      if (loaded < total) {
        const more = document.createElement("button");
        more.type = "button";
        more.className = "sr-foot-btn";
        more.textContent = `查看更多（还有 ${total - loaded} 处）`;
        more.addEventListener("click", () => void runSearchPage(searchView.query, { mode: "more" }));
        foot.append(more);
      }
      if (searchView.days < SEARCH_DAYS_ALL) {
        const older = document.createElement("button");
        older.type = "button";
        older.className = "sr-scope-btn";
        older.textContent = "搜索更早的历史（一年以前）";
        older.addEventListener("click", () => void runSearchPage(searchView.query, { mode: "widen" }));
        foot.append(older);
      } else {
        const note = document.createElement("span");
        note.className = "sr-scope-note";
        note.textContent = "已搜索全部历史";
        foot.append(note);
      }
    }
    box.append(foot);
  }
}

/** 去掉空白再比：短会话里"标题就是第一句话"，标点和换行不该影响判重 */
function searchComparable(text) {
  return String(text || "").replace(/\s+/g, "").trim();
}

/** 这条命中的片段是不是"标题本身"？是的话组头已经写了，别再在组里重复一遍。 */
function snippetIsTitle(title, snippet) {
  const t = searchComparable(title);
  const s = searchComparable(snippet);
  if (t.length < 2 || s.length < 2) return false;
  return s === t || s.includes(t) || t.includes(s);
}

/**
 * 一组 = 一条对话。
 *
 * 标题的两种来路要分开处理：
 *   - **改过名的会话**：标题是用户起的，和正文是两回事 → 组头显示标题，下面是命中行；
 *   - **没改过名的会话**：标题是服务端从第一条用户消息里截的，和某条命中是同一句话 →
 *     再把它当组头就是在重复正文。这种情况不显示标题：单条命中直接就是一行结果，
 *     多条命中给一行「N 处命中 · 时间」的计数（不可点），每条命中各自可点定位。
 * 这样同一句话只会出现一次，而且每一处命中都点得到（不会只剩第一条）。
 */
function searchGroupNode(group, query) {
  const card = document.createElement("article");
  card.className = "sr-group";
  const titleFromHit = group.hits.some((hit) => snippetIsTitle(group.title, hit.snippet));
  const showHeader = !group.hits.length || !titleFromHit;
  const counterText = `${group.hits.length} 处命中 · ${searchTimeText(group.lastAt)}`;

  if (showHeader) {
    const head = document.createElement("button");
    head.type = "button";
    head.className = "sr-head";
    const meta = group.hits.length
      ? counterText
      : `标题命中${group.turns ? ` · ${group.turns} 轮` : ""}`;
    head.innerHTML = `<span class="sr-title">${markQuery(group.title || "（无标题）", query)}</span>
      <span class="sr-meta">${esc(meta)}</span>`;
    head.addEventListener("click", () => void openConversation(group.conversationId));
    card.append(head);
  } else if (group.hits.length > 1) {
    // 多条命中且标题就是其中一句：计数单独一行，不重复正文
    const counter = document.createElement("div");
    counter.className = "sr-count";
    counter.textContent = counterText;
    card.append(counter);
  }

  if (!group.hits.length) return card;

  const list = document.createElement("div");
  list.className = "sr-hits";
  const appendHits = (items) => {
    for (const hit of items) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "sr-hit";
      row.innerHTML = `<span class="sr-snippet">${markQuery(hit.snippet, query)}</span>
        <span class="sr-time">${esc(searchTimeText(hit.at))}</span>`;
      row.addEventListener("click", () =>
        void openConversation(group.conversationId, { anchor: { at: hit.at } }),
      );
      list.append(row);
    }
  };
  appendHits(group.hits.slice(0, 3));
  card.append(list);
  if (group.hits.length > 3) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "sr-more";
    more.textContent = `还有 ${group.hits.length - 3} 处`;
    more.addEventListener("click", () => {
      appendHits(group.hits.slice(3));
      more.remove();
    });
    card.append(more);
  }
  return card;
}

/** 一行设置 = 标签 + 控件。
 *  hint 2026-11-08 起默认**不再常驻**；2026-11-09 二改：连 ⓘ 图标也去掉——
 *  data-tip 直接挂在**标签文字**上，悬停即出全句（全局 data-tip 系统）。
 *  设置页只留"状态/结果"类文案占一行（inlineHint: true，如动态计数、保存反馈）。 */

export { SEARCH_DAYS_ALL, SEARCH_DAYS_DEFAULT, SEARCH_PAGE_SIZE, chatMatchesQuery, groupSearchHits, renderSearchGroups, resetSearchState, runSearchPage, searchComparable, searchGroupNode, searchTimeText, searchView, snippetIsTitle, wireSearchPage };
