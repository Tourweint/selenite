/**
 * 侧栏课题与课题详情
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { el } from "./dom.js";
import { groups, initGroups, paintGroupAvatar, renderGroupPulse, renderGroupSidebar, startGroupPulse, stopGroupPulse } from "./groups-base.js";
import { closeGroupAtPop, resizeGroupInput, updateGroupSendState } from "./groups-composer.js";
import { gsResponderShort } from "./groups-settings.js";
import { renderGroupMembersBar, renderGroupTimeline } from "./groups-thread.js";
import { request } from "./net.js";
import { groupRouteId } from "./route.js";
import { openMenuAt } from "./sec-menu.js";
import { shortDateTime } from "./topic-proposal.js";
import { inShell, toast } from "./ui-atoms.js";


/* ── 侧栏课题（2026-11-07 批二）──────────────────────────
   展开侧栏时拉 GET /topics；点开一行 = 时间线（GET /topics/:id 按需拉）。
   改节奏 / 暂停恢复 / 关闭成功后就地刷新，不整页重载。
   列表只放「在跟的」：closed 不进侧栏（方案 §六 的进行中课题列表）。 */
let topicsSidebarAvailable = null; // null=未查 / true / false（404 = 未启用）
let topicsSidebarList = [];
const expandedTopicIds = new Set();

const TOPIC_EMPTY_TEXT = "还没有在跟的课题。聊到值得长期跟进的问题，总管会提议。";

async function loadTopicsSidebar({ force = false } = {}) {
  if (!el.topicList) return;
  if (topicsSidebarAvailable === false && !force) return;
  try {
    const response = await request("/api/v1/topics", { cache: "no-store" });
    if (response.status === 404) {
      // TOPICS_ENABLED=false / 老服务端：整块入口退场（不留点进去必然空页的入口）
      topicsSidebarAvailable = false;
      topicsSidebarList = [];
      el.topicList.replaceChildren();
      const section = document.getElementById("sec-topics");
      if (section) section.hidden = true;
      if (el.railTopics) el.railTopics.hidden = true;
      return;
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(String(response.status));
    topicsSidebarAvailable = true;
    const section = document.getElementById("sec-topics");
    if (section) section.hidden = false;
    if (el.railTopics) el.railTopics.hidden = false;
    topicsSidebarList = Array.isArray(data.topics) ? data.topics : [];
    renderTopicSidebar();
  } catch {
    // 网络抖动不藏功能：已有列表保留；空列表给一句可重试的话
    if (!topicsSidebarList.length && el.topicList) {
      el.topicList.replaceChildren();
      const empty = document.createElement("div");
      empty.className = "roster-empty";
      empty.textContent = "课题读取失败，稍后再试。";
      el.topicList.append(empty);
    }
  }
}

function renderTopicSidebar() {
  if (!el.topicList) return;
  const ongoing = topicsSidebarList.filter((topic) => topic.status !== "closed");
  if (el.topicsBadge) {
    el.topicsBadge.hidden = ongoing.length === 0;
    el.topicsBadge.textContent = String(ongoing.length);
  }
  el.topicList.replaceChildren();
  if (!ongoing.length) {
    const empty = document.createElement("div");
    empty.className = "roster-empty";
    empty.textContent = TOPIC_EMPTY_TEXT;
    el.topicList.append(empty);
    return;
  }
  for (const topic of ongoing) el.topicList.append(buildTopicRow(topic));
}

/** 右键里的暂停 / 恢复：和详情面板那颗按钮同一口径（PATCH status → 重拉侧栏）。 */
async function toggleTopicPaused(topic) {
  const next = topic.status === "paused" ? "active" : "paused";
  try {
    const response = await request(`/api/v1/topics/${encodeURIComponent(topic.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ status: next }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      toast(payload.message || "没切成，稍后再试。");
      return;
    }
    toast(next === "paused" ? "已暂停。" : "已恢复。");
    await loadTopicsSidebar({ force: true });
  } catch {
    toast("请求没发出去，检查服务是否在跑。");
  }
}

function buildTopicRow(topic) {
  const wrap = document.createElement("div");
  wrap.className = "topic-item";
  wrap.dataset.topicId = topic.id;

  const row = document.createElement("button");
  row.type = "button";
  row.className = "side-item topic-row";
  row.title = topic.question;
  const expanded = expandedTopicIds.has(topic.id);
  row.setAttribute("aria-expanded", String(expanded));

  const name = document.createElement("span");
  name.className = "roster-name";
  name.textContent = topic.question;

  const flavor = document.createElement("span");
  flavor.className = "pill-tag topic-flavor";
  flavor.dataset.flavor = topic.flavor;
  flavor.textContent = topic.flavor === "dig" ? "啃题" : "盯梢";

  row.append(name, flavor);

  if (topic.status === "paused") {
    const paused = document.createElement("span");
    paused.className = "topic-paused";
    paused.textContent = "已暂停";
    row.append(paused);
  } else if (topic.nextFireAt) {
    const next = document.createElement("span");
    next.className = "roster-idle topic-next";
    next.textContent = topic.nextFireLabel || shortDateTime(topic.nextFireAt);
    next.title = `下次研究：${topic.nextFireLabel || topic.nextFireAt}`;
    row.append(next);
  }

  const detail = document.createElement("div");
  detail.className = "topic-detail";
  detail.hidden = !expanded;

  row.addEventListener("click", () => {
    const open = detail.hidden;
    if (open) {
      expandedTopicIds.add(topic.id);
      detail.hidden = false;
      row.setAttribute("aria-expanded", "true");
      void refreshTopicDetail(topic, detail);
    } else {
      expandedTopicIds.delete(topic.id);
      detail.hidden = true;
      row.setAttribute("aria-expanded", "false");
    }
  });

  // 右键（2026-11-16）：展开时间线 / 暂停恢复——后两项原本只在展开后的详情里。
  row.addEventListener("contextmenu", (event) => {
    if (!inShell()) return;
    event.preventDefault();
    openMenuAt(
      event.clientX,
      event.clientY,
      [
        { label: detail.hidden ? "展开详情" : "收起详情", run: () => row.click() },
        {
          label: topic.status === "paused" ? "恢复研究" : "暂停研究",
          hint: topic.status === "paused" ? "恢复后按原节奏继续" : "研究记录都留着",
          run: () => void toggleTopicPaused(topic),
        },
      ],
      topic.question,
    );
  });

  wrap.append(row, detail);
  if (expanded) void refreshTopicDetail(topic, detail);
  return wrap;
}

async function refreshTopicDetail(topic, detail) {
  detail.replaceChildren();
  const loading = document.createElement("p");
  loading.className = "topic-detail-hint";
  loading.textContent = "读取中…";
  detail.append(loading);

  let full = null;
  try {
    const response = await request(`/api/v1/topics/${encodeURIComponent(topic.id)}`, {
      cache: "no-store",
    });
    if (response.ok) {
      const payload = await response.json();
      full = payload.topic || null;
    }
  } catch {
    /* 下面统一给一句可重试的提示 */
  }
  if (!full) {
    detail.replaceChildren();
    const fail = document.createElement("p");
    fail.className = "topic-detail-hint";
    fail.textContent = "课题详情读取失败，稍后再试。";
    detail.append(fail);
    return;
  }
  renderTopicDetail(full, detail);
}

/** `0 9 * * 1` → { weekday: 1, hour: 9 }；不是周节奏就返回 null（下拉退回默认值）。 */
function parseWeeklyCron(cron) {
  const parts = String(cron || "").trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  if (minute !== "0" || dayOfMonth !== "*" || month !== "*") return null;
  if (!/^\d{1,2}$/.test(hour) || !/^[0-7]$/.test(dayOfWeek)) return null;
  const hh = Number(hour);
  if (hh > 23) return null;
  return { weekday: Number(dayOfWeek) % 7, hour: hh };
}

function renderTopicDetail(topic, detail) {
  detail.replaceChildren();

  const head = document.createElement("div");
  head.className = "topic-detail-head";

  // 改节奏：每周几 + 时段（整点）两个下拉，拼成 `0 H * * D`
  const parsed = parseWeeklyCron(topic.cron);
  const weekday = document.createElement("select");
  weekday.className = "topic-select";
  weekday.setAttribute("aria-label", "每周几");
  for (const [value, label] of [
    [1, "周一"], [2, "周二"], [3, "周三"], [4, "周四"], [5, "周五"], [6, "周六"], [0, "周日"],
  ]) {
    const option = document.createElement("option");
    option.value = String(value);
    option.textContent = label;
    weekday.append(option);
  }
  weekday.value = String(parsed ? parsed.weekday : 1);

  const hour = document.createElement("select");
  hour.className = "topic-select";
  hour.setAttribute("aria-label", "时段");
  for (let hh = 0; hh < 24; hh += 1) {
    const option = document.createElement("option");
    option.value = String(hh);
    option.textContent = `${String(hh).padStart(2, "0")}:00`;
    hour.append(option);
  }
  hour.value = String(parsed ? parsed.hour : 9);

  const schedule = document.createElement("div");
  schedule.className = "topic-schedule";
  const weekPrefix = document.createElement("span");
  weekPrefix.textContent = "每周";
  schedule.append(weekPrefix, weekday, hour);

  const state = document.createElement("span");
  state.className = "topic-detail-state";
  state.dataset.state = topic.status === "paused" ? "paused" : "active";
  state.textContent = topic.status === "paused" ? "已暂停" : "进行中";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "ghost topic-act";
  toggle.textContent = topic.status === "paused" ? "恢复" : "暂停";

  const close = document.createElement("button");
  close.type = "button";
  close.className = "ghost is-danger topic-act";
  close.textContent = "关闭";

  head.append(schedule, state, toggle, close);
  detail.append(head);

  const hint = document.createElement("p");
  hint.className = "topic-detail-hint";
  detail.append(hint);

  const setHint = (text, isError = false) => {
    hint.textContent = text || "";
    hint.classList.toggle("is-error", Boolean(isError) && Boolean(text));
  };

  const reload = async () => {
    await loadTopicsSidebar({ force: true });
  };

  const patch = async (body, okText) => {
    weekday.disabled = true;
    hour.disabled = true;
    toggle.disabled = true;
    close.disabled = true;
    setHint("保存中…");
    try {
      const response = await request(`/api/v1/topics/${encodeURIComponent(topic.id)}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setHint(payload.message || "没有保存成功，稍后再试。", true);
        return false;
      }
      // 成功后整个侧栏会重绘（保留展开态），行内那句会跟着旧节点消失——用 toast 留个回执
      toast(okText);
      await reload();
      return true;
    } catch {
      setHint("请求没发出去，检查服务是否在跑。", true);
      return false;
    } finally {
      weekday.disabled = false;
      hour.disabled = false;
      toggle.disabled = false;
      close.disabled = false;
    }
  };

  const commitCron = () => {
    const cron = `0 ${Number(hour.value)} * * ${Number(weekday.value)}`;
    if (cron === topic.cron) return;
    void patch({ cron }, "节奏已改。");
  };
  weekday.addEventListener("change", commitCron);
  hour.addEventListener("change", commitCron);

  toggle.addEventListener("click", () => {
    void patch(
      { status: topic.status === "paused" ? "active" : "paused" },
      topic.status === "paused" ? "已恢复。" : "已暂停。",
    );
  });

  // 关闭：先点一次变成确认态，再点一次才发请求（行内确认，不弹窗）
  let armed = false;
  let armTimer = 0;
  close.addEventListener("click", async () => {
    if (!armed) {
      armed = true;
      close.textContent = "确认关闭？";
      setHint("再点一次就关掉；研究记录会留着。");
      armTimer = setTimeout(() => {
        armed = false;
        close.textContent = "关闭";
        setHint("");
      }, 4000);
      return;
    }
    clearTimeout(armTimer);
    close.disabled = true;
    setHint("关闭中…");
    try {
      const response = await request(`/api/v1/topics/${encodeURIComponent(topic.id)}/close`, {
        method: "POST",
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        setHint(payload.message || "关闭失败，稍后再试。", true);
        close.disabled = false;
        return;
      }
      expandedTopicIds.delete(topic.id);
      await reload();
    } catch {
      setHint("请求没发出去，检查服务是否在跑。", true);
      close.disabled = false;
    }
  });

  const timeline = document.createElement("div");
  timeline.className = "topic-timeline";
  if (!Array.isArray(topic.findings) || topic.findings.length === 0) {
    const empty = document.createElement("p");
    empty.className = "topic-detail-hint";
    empty.textContent = "还没有研究记录，到点后会在这里出现。";
    timeline.append(empty);
  } else {
    for (const finding of topic.findings) timeline.append(buildTopicFinding(finding));
  }
  detail.append(timeline);
}

function findingCompare(body) {
  const lines = String(body || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const line = [...lines].reverse().find((item) => /^相比上次[:：]/.test(item));
  return line ? line.replace(/^相比上次[:：]\s*/, "") : "";
}

function buildTopicFinding(finding) {
  const wrap = document.createElement("div");
  wrap.className = "topic-finding";

  const head = document.createElement("div");
  head.className = "topic-finding-head";
  const date = document.createElement("span");
  date.className = "topic-finding-date";
  date.textContent = finding.date || "";
  head.append(date);
  if (finding.noNew) {
    const pill = document.createElement("span");
    pill.className = "pill-tag topic-no-new";
    pill.textContent = "无新进展";
    head.append(pill);
  }
  wrap.append(head);

  const summary = document.createElement("div");
  summary.className = "topic-finding-summary";
  summary.textContent = finding.summary || "（本轮没有摘要）";
  wrap.append(summary);

  const compareText = findingCompare(finding.body);
  if (compareText) {
    const compare = document.createElement("div");
    compare.className = "topic-finding-compare";
    compare.textContent = `相比上次：${compareText}`;
    wrap.append(compare);
  }

  if (finding.body) {
    const details = document.createElement("details");
    details.className = "topic-finding-body";
    const label = document.createElement("summary");
    label.textContent = "正文";
    const pre = document.createElement("pre");
    pre.textContent = finding.body;
    details.append(label, pre);
    wrap.append(details);
  }
  return wrap;
}


/** 群组路由入口：#/groups 列表态，#/group/:id 会话态。 */
async function openGroupsView() {
  if (groups.available === null) await initGroups();
  closeGroupAtPop();
  const id = groupRouteId();
  if (!id) {
    el.groupsTitleText.textContent = "群组";
    el.groupsTitleSub.textContent = "";
    el.groupSettingsBtn.hidden = true;
    el.groupCreate.hidden = groups.available !== true;
    el.groupChat.hidden = true;
    el.groupsBody.hidden = false;
    if (el.groupHeadAvatar) el.groupHeadAvatar.hidden = true;
    // 列表态没有"谁在忙"可看：停掉轮询，别在后台空转
    stopGroupPulse();
    if (el.groupPulse) {
      el.groupPulse.replaceChildren();
      el.groupPulse.hidden = true;
    }
    await renderGroupsListPage();
    return;
  }
  el.groupCreate.hidden = true;
  el.groupsBody.hidden = true;
  el.groupChat.hidden = false;
  await openGroupChat(id);
}

async function renderGroupsListPage() {
  if (groups.available !== true) {
    el.groupsBody.replaceChildren();
    const empty = document.createElement("div");
    empty.className = "tasks-empty";
    empty.textContent = "群组未启用（GROUPS_ENABLED / COMPANIONS_ENABLED）。";
    el.groupsBody.append(empty);
    return;
  }
  // 现拉一次：建群/删群回来列表要新
  const response = await request("/api/v1/groups", { cache: "no-store" }).catch(() => null);
  if (response?.ok) {
    const data = await response.json().catch(() => ({}));
    groups.list = Array.isArray(data.groups) ? data.groups : [];
    renderGroupSidebar();
  }

  el.groupsBody.replaceChildren();
  if (!groups.list.length) {
    const empty = document.createElement("div");
    empty.className = "tasks-empty";
    empty.innerHTML = [
      "<h2>还没有群组</h2>",
      // 措辞与建群弹窗同一套（那里也说"成员"）：群里的可以是指挥官，也可以是执事
      "<p>把 2–6 位成员拉进同一条会话：@名字 点名谁回，不 @ 就发给值日。</p>",
    ].join("");
    el.groupsBody.append(empty);
    return;
  }
  const list = document.createElement("div");
  list.className = "group-list";
  for (const group of groups.list) {
    // 一行一群（2026-11-07）：原来是自适应网格卡片，1–2 个群时被撑成一大块孤卡。
    const row = document.createElement("button");
    row.type = "button";
    row.className = "group-item";
    row.dataset.groupId = group.id;

    const avatar = document.createElement("span");
    avatar.className = "pt-avatar group-item-avatar";
    avatar.setAttribute("aria-hidden", "true");
    paintGroupAvatar(avatar, group.members);

    const main = document.createElement("span");
    main.className = "group-item-main";
    const name = document.createElement("span");
    name.className = "group-item-name";
    name.textContent = group.name;
    const sub = document.createElement("span");
    sub.className = "group-item-sub";
    const duty = group.members.find((m) => m.partnerId === group.responderPartnerId);
    const who = group.members.map((m) => m.name).join("、");
    // 口径直接复用设置抽屉的 gsResponderShort（值日 阅读助手 / 全员都回 / 只回点名）：
    // 同一个概念在两处出现，就不该有两套措辞——原来这里拼「不 @ 阅读助手 回」，
    // 断句会读成"不要 @ 阅读助手"，而设置页写的是「值日 阅读助手」。
    sub.textContent = `${who} · ${gsResponderShort(group)}`;
    main.append(name, sub);

    const count = document.createElement("span");
    count.className = "group-item-count";
    count.textContent = `${group.members.length} 人`;

    const chevron = document.createElement("span");
    chevron.className = "group-item-chevron";
    chevron.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';

    row.append(avatar, main, count, chevron);
    row.addEventListener("click", () => {
      location.hash = `#/group/${group.id}`;
    });
    list.append(row);
  }
  el.groupsBody.append(list);
}

/** 打开群会话视图：群资料 + 时间线，composer 就绪。 */
async function openGroupChat(groupId) {
  const response = await request(`/api/v1/groups/${encodeURIComponent(groupId)}`, { cache: "no-store" }).catch(() => null);
  if (!response || !response.ok) {
    toast("这个群不存在或已被删除");
    location.hash = "#/groups";
    return;
  }
  const data = await response.json().catch(() => ({}));
  groups.current = data.group ?? null;
  groups.messages = [];
  groups.streamSender = null;
  groups.streamBubble = null;

  if (!groups.current) {
    toast("这个群不存在或已被删除");
    location.hash = "#/groups";
    return;
  }
  el.groupsTitleText.textContent = groups.current.name;
  // 会话头复合头像（2026-11-08 批三）：列表态没有它，进群才画
  if (el.groupHeadAvatar) {
    el.groupHeadAvatar.hidden = false;
    paintGroupAvatar(el.groupHeadAvatar, groups.current.members);
  }
  const duty = groups.current.members.find((m) => m.partnerId === groups.current.responderPartnerId);
  el.groupsTitleSub.textContent = duty
    ? ` · 值日 ${duty.name}`
    : groups.current.responderKind === "everyone"
      ? " · 不 @ 全员回"
      : groups.current.responderKind === "mentions"
        ? " · 只回点名"
        : "";
  el.groupSettingsBtn.hidden = false;
  el.groupNotice.hidden = !groups.current.notice?.trim();
  el.groupNotice.textContent = groups.current.notice?.trim() ? `公告：${groups.current.notice.trim()}` : "";
  renderGroupMembersBar();

  el.groupThread.replaceChildren();
  const msgResponse = await request(`/api/v1/groups/${encodeURIComponent(groupId)}/messages?limit=200`, { cache: "no-store" }).catch(() => null);
  if (msgResponse?.ok) {
    const msgData = await msgResponse.json().catch(() => ({}));
    groups.messages = Array.isArray(msgData.messages) ? msgData.messages : [];
    groups.lastSeq = Number(msgData.lastSeq ?? 0);
    renderGroupTimeline();
  }
  el.groupInput.value = "";
  resizeGroupInput();
  // 状态胶囊（2026-11-08 批三）：先按详情里的轮次状态画一帧，再开轮询
  groups.round = groups.current.round ?? null;
  groups.pending = [];
  updateGroupSendState();
  renderGroupPulse();
  startGroupPulse();
  el.groupInput.focus();
}

export { TOPIC_EMPTY_TEXT, buildTopicFinding, buildTopicRow, expandedTopicIds, findingCompare, loadTopicsSidebar, openGroupChat, openGroupsView, parseWeeklyCron, refreshTopicDetail, renderGroupsListPage, renderTopicDetail, renderTopicSidebar, topicsSidebarAvailable, topicsSidebarList };
