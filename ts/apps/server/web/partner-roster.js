/**
 * 执事花名册与打开会话
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { paintAvatar } from "./avatar.js";
import { scrollToEnd } from "./chat-notice.js";
import { openChat } from "./chat-open.js";
import { hideEmpty } from "./chat-thread.js";
import { el } from "./dom.js";
import { request } from "./net.js";
import { openCreatePartnerModal } from "./partner-modals.js";
import { openPartnerSessions } from "./partner-sessions-ui.js";
import { loadRoster, paintBusyChip, partnerBusyOf, partnerDisplayName, rosterDomain, syncRosterBusy } from "./partners-status.js";
import { currentPartnerLineId, currentRoute, go } from "./route.js";
import { openSecMenu, openMenuAt } from "./sec-menu.js";
import { cs, drawerOpen, openDrawerAt, refreshCsDetail, renderCsPage } from "./settings-drawer.js";
import { updateHomeMode } from "./shell.js";
import { state } from "./state.js";
import { inShell, toast } from "./ui-atoms.js";

/** 领域 → 在办单数：整份重绘与轮询就地更新共用一份口径 */
function activeMapOf(domainRows) {
  const activeByDomain = new Map();
  for (const row of domainRows) {
    const key = String(row.domain || "").trim();
    if (key) activeByDomain.set(key, Number(row.activeTickets) || 0);
  }
  return activeByDomain;
}

/** 「N 单」按钮：可点进任务中心按领域筛选；没有在办单就整枚不占位 */
function rosterCountButton(domain, active) {
  if (!(active > 0)) return null;
  const count = document.createElement("button");
  count.type = "button";
  count.className = "side-count roster-count";
  count.textContent = `${active} 单`;
  count.title = `看「${domain}」的任务单`;
  count.addEventListener("click", (event) => {
    event.stopPropagation();
    location.hash = `#/tasks?domain=${encodeURIComponent(domain)}`;
  });
  return count;
}

/** 花名册渲染：box 缺省 = 展开侧栏的花名册；收起轨道的悬停卡传自己的容器
 *  （2026-11-13）——同一份行渲染（头像/领域/派发权/在办单/忙因），行为也一致。 */
function renderRoster(partners, domainRows, box = el.partnerRoster) {
  if (!box) return;
  box.replaceChildren();

  const activeByDomain = activeMapOf(domainRows);
  // 忙因胶囊在待办快照变化时用同一份数据就地重算（syncRosterBusy），不重绘整份花名册
  rosterDomain.active = activeByDomain;

  // 数据源返回全部（含 chief）；过滤掉 chief 与已归档的
  const roster = partners.filter(
    (partner) => partner && partner.id !== "chief" && partner.status !== "archived",
  );

  if (!roster.length) {
    const hint = document.createElement("div");
    hint.className = "roster-empty";
    hint.textContent = "还没有执事。让总管建一个，或在设置→执事里新建。";
    box.append(hint);
    return;
  }

  for (const partner of roster) {
    const id = String(partner.id || "");
    const name = String(partner.name || "执事").trim() || "执事";
    const domain = String(partner.domain || "").trim();
    const active = domain ? activeByDomain.get(domain) || 0 : 0;
    // 忙因算一次、两处用：有胶囊时不再写「空闲」，否则同一行自相矛盾（七原则⑤）
    const busy = partnerBusyOf(partner, active);

    const row = document.createElement("div");
    row.className = "side-item roster-row";
    row.dataset.partnerId = id;
    row.setAttribute("role", "button");
    row.tabIndex = 0;
    // 「你在这里」：正开着这条执事专线（2026-11-13 选中态批；折叠卡与展开侧栏共用）
    if (id === currentPartnerLineId()) row.setAttribute("aria-current", "true");

    // 头像：有图用 img，没图用名字首字。2026-11-13 起只做展示——侧栏里点头像
    // 跟点名字一样，都只是打开这位执事的会话；改头像 / 改名字去右侧人设页或设置→执事。
    const avatar = document.createElement("span");
    avatar.className = "pt-avatar";
    avatar.setAttribute("aria-hidden", "true");
    paintAvatar(avatar, partner.avatar || null, name);

    const label = document.createElement("span");
    label.className = "roster-name";
    label.textContent = name;

    row.append(avatar, label);

    if (domain) {
      const tag = document.createElement("span");
      tag.className = "pill-tag roster-domain";
      tag.textContent = domain;
      row.append(tag);

      // 派发权拨杆（2026-11-06 执事派发权开关）：亮 = 有权接单；关 = 派单等同无分管领域。
      const dispatch = document.createElement("button");
      dispatch.type = "button";
      dispatch.className = `pill-tag roster-dispatch${partner.dispatchAuthority ? " on" : " off"}`;
      dispatch.textContent = partner.dispatchAuthority ? "派·开" : "派·关";
      dispatch.title = partner.dispatchAuthority
        ? "派发权：开（点击关闭）"
        : "派发权已关：派单不经过该执事（点击打开）";
      dispatch.setAttribute("aria-label", `${name}的派发权开关`);
      dispatch.addEventListener("click", async (event) => {
        event.stopPropagation();
        const next = !partner.dispatchAuthority;
        dispatch.disabled = true;
        try {
          const response = await request(`/api/v1/partners/${encodeURIComponent(id)}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ dispatchAuthority: next }),
          });
          if (response.ok) {
            partner.dispatchAuthority = next;
            renderRoster(state.partners, domainRows, box);
            return;
          }
        } catch { /* 落到下面的提示 */ }
        dispatch.disabled = false;
        dispatch.title = "切换失败，稍后再试";
      });
      row.append(dispatch);
    }

    // 数字可点 → 任务中心按 domain 筛选（.side-count 与任务中心徽章同款）
    const count = rosterCountButton(domain, active);
    if (count) row.append(count);

    // 忙因胶囊（批 18 §二）：忙时才占位，空闲不画（七原则⑥）。
    // 2026-11-13 用户口径：状态点、「空闲」、员工档案小图标一律不摆——
    // 侧栏这一行只留「谁」和「有什么活」，状态去会话里看。
    const busyChip = document.createElement("span");
    busyChip.className = "roster-busy";
    busyChip.hidden = true;
    paintBusyChip(busyChip, busy);
    row.append(busyChip);

    // 副会话选择器入口（2026-11-23）：行尾小图标退役，收进右键菜单；
    // 插件关时菜单项也不出现（与旧按钮同一口径）。
    const open = () => void openPartnerChat(id);
    row.addEventListener("click", open);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
    // 右键（2026-11-16）：开对话 / 选择会话 / 档案页 / 看这个领域的任务单。
    row.addEventListener("contextmenu", (event) => {
      if (!inShell()) return;
      event.preventDefault();
      const items = [
        { label: "打开对话", run: open },
      ];
      if (state.sideSessionsEnabled) {
        items.push({ label: "选择会话", run: () => void openPartnerSessions(id) });
      }
      items.push({ label: "人设档案", run: () => void openPartnerProfile(id, "records") });
      if (domain) {
        items.push(
          { separator: true },
          {
            label: `看「${domain}」的任务`,
            run: () => {
              location.hash = `#/tasks?domain=${encodeURIComponent(domain)}`;
            },
          },
        );
      }
      openMenuAt(event.clientX, event.clientY, items, name);
    });
    box.append(row);
  }
}

/** 待派数字就地改：行不重建，头像 img 不动（不再重新解码） */
function syncRosterCounts() {
  for (const row of document.querySelectorAll("#partner-roster [data-partner-id]")) {
    const partner = state.partners.find((item) => item.id === row.dataset.partnerId);
    if (!partner) continue;
    const domain = String(partner.domain || "").trim();
    const active = domain ? rosterDomain.active.get(domain) || 0 : 0;
    const existing = row.querySelector(".roster-count");
    const next = rosterCountButton(domain, active);
    if (!next) {
      existing?.remove();
      continue;
    }
    if (existing) {
      existing.textContent = next.textContent;
      existing.title = next.title;
      continue;
    }
    const busyNode = row.querySelector(".roster-busy");
    if (busyNode) busyNode.before(next);
    else row.append(next);
  }
}

/**
 * 轮询刷新在办单数（2026-11-24）：只走轻量 /api/v1/domains。
 * /api/v1/partners 的每条记录都内联头像 base64，轮询为几个数字反复拉整份花名册
 * 会让人看见头像反复加载。这个函数只更新数字与忙因胶囊，不重绘行、不重解头像；
 * 花名册本身仍在启动 / 改执事 / 改头像时由 loadRoster 重读。
 */
async function refreshRosterDomains() {
  let domains = null;
  try {
    const response = await request("/api/v1/domains", { cache: "no-store" });
    if (response.ok) domains = (await response.json().catch(() => ({}))).domains || [];
  } catch {
    return;
  }
  if (!Array.isArray(domains)) return;
  rosterDomain.rows = domains;
  rosterDomain.active = activeMapOf(domains);
  syncRosterCounts();
  syncRosterBusy();
}

/**
 * 行点击 = 打开该执事的 canonical 对话。
 *
 * 2026-11-06 C 批：先 POST /api/v1/partners/:id/open（服务端负责 ensurePartnerSession
 * + 首次问候的持久去重），返回后再 openChat 回读。前端不再自己判断「有没有历史」，
 * 否则第一次点永远没有入口。护栏：
 *  - 同一个执事的 open 在飞时直接吞掉重复点击；
 *  - 每次导航有令牌，快速切到别的会话 / 执事后旧响应直接作废；
 *  - 失败给「重试 / 继续现有空会话」两个动作，不只 toast。
 *
 * 404 拆义（2026-11-06 返修，实测踩过）：open 的 404 有两种含义——
 *  a) 服务进程比页面旧，还没有 /open 路由（Hono 对未知路由一律 404）；
 *  b) 执事档案真被删了（花名册残留的幽灵行）。
 * 两种都报「执事不存在」是谎报。用 GET /api/v1/partners/:id 复核一次：
 *  200 = 服务旧 → 说清楚要重启服务，可重试；404 = 真没了 → 刷花名册让这行消失。
 */
async function openPartnerChat(partnerId) {
  if (!partnerId || state.partnerOpening.has(partnerId)) return;
  state.partnerOpening.add(partnerId);
  const token = ++state.navToken;
  const startHash = location.hash;
  const startGen = state.routeGen;
  // 离开再回到同一 hash 也算离开：routeGen 比 hash 字符串更可信。
  const stillHere = () =>
    token === state.navToken && state.routeGen === startGen && location.hash === startHash;
  try {
    const response = await request(`/api/v1/partners/${encodeURIComponent(partnerId)}/open`, {
      method: "POST",
    });
    if (response.status === 404) {
      if (!stillHere()) return;
      // 复核档案还在不在，两种 404 分开说、分开处置
      const verdict = await partnerExistsAfter404(partnerId);
      if (verdict === "gone") {
        // 真被删了：列表里那行是幽灵，刷掉并明说，不报「点开失败」
        void loadRoster();
        toast("这个执事已删除，列表已刷新");
      } else {
        showPartnerOpenFailureCard(
          partnerId,
          verdict === "stale-server"
            ? "服务还是旧版本，先重启服务（托盘右键退出后重开）再点。"
            : "执事状态读不到，稍后再试。",
          stillHere,
        );
      }
      return;
    }
    if (response.status === 409) {
      // 409 = 服务端说暂停/归档：列表可能还在显示旧状态，静默刷一次对齐
      void loadRoster();
      if (stillHere()) toast("这个执事已暂停或归档，先恢复再打开");
      return;
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      await showPartnerOpenFailure(
        partnerId,
        data.message || data.error || `打开失败（HTTP ${response.status}）`,
        stillHere,
      );
      return;
    }
    if (!stillHere()) return; // 用户已经切走，旧响应不得抢回
    // 只认服务端返回的 canonical id；缺字段说明契约不完整，不拿 partner-<id> 猜。
    const convId = String(data.conversationId || "");
    if (!convId) {
      await showPartnerOpenFailure(partnerId, "服务端返回不完整，稍后再试", stillHere);
      return;
    }
    go("chat");
    await openChat(convId);
  } catch (error) {
    if (error.message !== "forbidden" && stillHere()) {
      await showPartnerOpenFailure(partnerId, `打不开执事会话：${error.message}`, stillHere);
    }
  } finally {
    state.partnerOpening.delete(partnerId);
  }
}

/**
 * 花名册「档案」直达（2026-11-09）：开该执事会话 + 抽屉**直落**档案页。
 *
 * 任务书允许降级到「开对话 + 开抽屉 home」，这里做到的是更高一档：csTarget 显式给
 * partnerId、csPage 直接给档案页，不靠 csResolveTarget 猜当前会话（会话刚 open 完、
 * 或 open 失败留在旧会话时，档案页仍明确显示你点的那个执事）。
 */
async function openPartnerProfile(partnerId, page = "records") {
  await openPartnerChat(partnerId);
  if (drawerOpen()) {
    // 抽屉已开着：直接切页，别走 toggle（toggle 的语义是关掉它）
    cs.target = partnerId;
    cs.detail = null;
    cs.page = page;
    renderCsPage();
    void refreshCsDetail();
    return;
  }
  await openDrawerAt(partnerId, page);
}

/**
 * open 404 后复核档案：GET /api/v1/partners/:id。
 * 200 = 档案在（服务版本旧，缺 /open 路由）；404 = 档案真没了；其他 = 读不到，无法判定。
 */
async function partnerExistsAfter404(partnerId) {
  try {
    const probe = await request(`/api/v1/partners/${encodeURIComponent(partnerId)}`, {
      cache: "no-store",
    });
    if (probe.ok) return "stale-server";
    if (probe.status === 404) return "gone";
    return "unknown";
  } catch (error) {
    return error.message === "forbidden" ? "forbidden" : "unknown";
  }
}

/**
 * open 失败且只适合给一张可重试卡（不切会话、不动花名册）的轻量入口：
 * 典型是 404 拆义出的「服务旧」——重试大概率还是 404，卡比 toast 留得住。
 * 与 showPartnerOpenFailure 的差别：这里不做 canonical 探测，也不切路由。
 */
function showPartnerOpenFailureCard(partnerId, message, stillHere) {
  if (!stillHere()) return;
  const name = partnerDisplayName(partnerId);
  const wrap = document.createElement("div");
  wrap.className = "msg error partner-open-error";
  const body = document.createElement("div");
  body.className = "body";
  body.textContent = `打开${name}失败：${message}`;
  wrap.append(body);
  const actions = document.createElement("div");
  actions.className = "partner-open-actions";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "retry-btn";
  retry.textContent = "重试";
  retry.title = "重新请求打开执事";
  retry.addEventListener("click", () => {
    wrap.remove();
    void openPartnerChat(partnerId);
  });
  actions.append(retry);
  wrap.append(actions);
  el.thread.append(wrap);
  updateHomeMode();
  if (state.stick) scrollToEnd();
}

/** 只读探测 canonical 会话是否已由服务端确认存在（响应必须带同一个 conversationId） */
async function partnerConversationExists(partnerId) {
  const convId = partnerConversationId(partnerId);
  try {
    const response = await request(
      `/api/v1/agent/chat/${encodeURIComponent(convId)}/messages?limit=1`,
      { cache: "no-store" },
    );
    if (!response.ok) return false;
    const data = await response.json().catch(() => null);
    return Boolean(data && data.conversationId === convId);
  } catch {
    return false;
  }
}

function partnerConversationId(partnerId) {
  return `partner-${partnerId}`;
}

/** openChat 的结果只有在“仍是最后一次导航 + 仍是这条会话 + 仍在对话路由”时才算归属本次 */
function ownsChatResult(result, conversationId) {
  return Boolean(result) &&
    result.token === state.navToken &&
    result.conversationId === conversationId &&
    state.conversationId === conversationId &&
    currentRoute() === "chat";
}

/** 只打开已确认存在的 canonical；探测失败就不制造伪执事页面 */
async function openConfirmedPartnerCanonical(partnerId) {
  const convId = partnerConversationId(partnerId);
  if (!(await partnerConversationExists(partnerId))) return { ok: false, reason: "missing" };
  go("chat");
  const result = await openChat(convId);
  if (!ownsChatResult(result, convId)) {
    return { ok: false, reason: result?.status === "missing" ? "missing" : "stale" };
  }
  return { ok: true, result };
}

/**
 * open 失败（503 等）：
 *  - canonical 已确认存在 → 切过去并挂可重试错误卡；
 *  - 探测不到 canonical → 不切换、不改标题/身份，保留当前会话，只挂可重试错误卡。
 * 错误文案用服务端的通用中文，不展示上游原文。
 * 失败后顺手静默刷一次花名册（2026-11-06 返修）：档案可能刚被删/暂停，列表里的
 * 名字、状态点、幽灵行跟着对齐——「点开失败但列表还说在」就是这次 bug 的观感来源。
 */
async function showPartnerOpenFailure(partnerId, message, stillHere) {
  void loadRoster();
  if (!stillHere()) return;
  const name = partnerDisplayName(partnerId);
  const convId = partnerConversationId(partnerId);
  // 先探测再切路由：切完再看会把自己的 go("chat") 当成用户离开
  const exists = await partnerConversationExists(partnerId);
  if (!stillHere()) return;

  if (!exists) {
    // 不制造“标题是执事、身份却是 worker”的假页面：原会话、标题、chatKind 一律不动。
    addPartnerOpenError(message, partnerId, false, name, { keptConversation: true });
    // 错误卡挂在对话页；如果用户此刻在任务/设置页，补一条即时提示，别让点击像没反应。
    if (currentRoute() !== "chat") toast(`打开${name}失败：${message}`);
    return;
  }

  go("chat");
  const result = await openChat(convId);
  // openChat 自己会递增 token；这里用结果归属判断，不能拿旧 token 让正常路径失效。
  if (!ownsChatResult(result, convId)) {
    if (result?.status === "missing") toast("执事会话不在了，先点重试");
    return;
  }
  addPartnerOpenError(message, partnerId, true, name);
}

function addPartnerOpenError(message, partnerId, canContinue, name, opts = {}) {
  hideEmpty();
  const wrap = document.createElement("div");
  wrap.className = "msg error partner-open-error";
  const body = document.createElement("div");
  body.className = "body";
  body.textContent = opts.keptConversation
    ? `打开${name}失败：${message}。已保留当前会话，稍后可以重试。`
    : `${name}的问候没生成：${message}`;
  wrap.append(body);

  const actions = document.createElement("div");
  actions.className = "partner-open-actions";

  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "retry-btn";
  retry.textContent = "重试";
  retry.title = "重新请求首次问候";
  retry.addEventListener("click", () => {
    wrap.remove();
    void openPartnerChat(partnerId);
  });
  actions.append(retry);

  if (canContinue) {
    const cont = document.createElement("button");
    cont.type = "button";
    cont.className = "retry-btn";
    cont.textContent = "继续对话";
    cont.title = "不重试问候，直接在这个空会话里说话";
    cont.addEventListener("click", async () => {
      // 点击时再确认一次 canonical：会话可能在错误卡出现后被清理。
      const opened = await openConfirmedPartnerCanonical(partnerId);
      if (opened.ok) {
        wrap.remove();
        return;
      }
      if (opened.reason === "missing") toast("这个执事会话还没建好，先点重试");
    });
    actions.append(cont);
  }

  wrap.append(actions);
  el.thread.append(wrap);
  updateHomeMode();
  if (state.stick) scrollToEnd();
  if (currentRoute() === "chat") el.input.focus();
}

// 分区标题右侧 ⋯（2026-11-14 由 ＋ 改）：菜单只有「新建执事」，复用 E1 模态，不重写
el.secPartnersMore?.addEventListener("click", () => {
  openSecMenu(el.secPartnersMore, [
    { label: "新建执事", run: () => openCreatePartnerModal() },
  ]);
});

export { addPartnerOpenError, openConfirmedPartnerCanonical, openPartnerChat, openPartnerProfile, ownsChatResult, partnerConversationExists, partnerConversationId, partnerExistsAfter404, refreshRosterDomains, renderRoster, showPartnerOpenFailure, showPartnerOpenFailureCard };
