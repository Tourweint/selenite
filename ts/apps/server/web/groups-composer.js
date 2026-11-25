/**
 * 群 composer / @picker / 重名候选
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { paintAvatar } from "./avatar.js";
import { el } from "./dom.js";
import { groupMemberAvatar, groups, renderGroupPulse, renderGroupSidebar } from "./groups-base.js";
import { appendGroupDayDivider, appendGroupMessageToThread, formatGroupTime, groupDayOf, groupMetaOf, insertGroupMention, renderGroupTimeline } from "./groups-thread.js";
import { request } from "./net.js";
import { popAnimateIn, popAnimateOut } from "./pop-anim.js";
import { toast } from "./ui-atoms.js";


/* ── 群 composer：发送（SSE 回合）─────────────────────── */

/**
 * 输入框按内容长高。
 *
 * 2026-11-07 修：原来用 `height:auto` → 读 `scrollHeight`，但 textarea 是
 * `flex:1` 的子项、父级 `.group-composer` 又是 `align-items:flex-end` 的 flex，
 * 量出来的 scrollHeight 会跟随被拉伸后的盒子（实测恒为 max-height 160），
 * 结果明明只有一行也撑成 160px 的大白框。
 * 改成先把 height 归零再量（content 决定 scrollHeight），并给 min-height 兜底。
 */
function resizeGroupInput() {
  if (!el.groupInput) return;
  el.groupInput.style.height = "0px";
  const next = Math.min(Math.max(el.groupInput.scrollHeight, 30), 160);
  el.groupInput.style.height = `${next}px`;
}

function updateGroupSendState() {
  if (!el.groupInput || !el.groupSend) return;
  el.groupSend.disabled = groups.sending || !el.groupInput.value.trim();
  el.groupStop.hidden = !groups.sending;
  el.groupSend.hidden = groups.sending;
  // 发/停的瞬间胶囊要跟上（轮询 5s，别让"正在发言"晚一拍）
  renderGroupPulse();
}

async function sendGroupMessage() {
  const text = el.groupInput.value.trim();
  if (!text || groups.sending || !groups.current) return;
  el.groupInput.value = "";
  resizeGroupInput();
  closeGroupAtPop();

  // 乐观落自己的气泡（主人右对齐）；回读时会以服务端为准再刷一遍
  const localMessage = {
    id: `local-${Date.now()}`,
    groupId: groups.current.id,
    seq: groups.lastSeq + 1,
    kind: "message",
    authorKind: "user",
    authorId: null,
    authorName: "主人",
    content: text,
    at: new Date().toISOString(),
  };
  groups.messages.push(localMessage);
  appendGroupMessageToThread(localMessage);
  groups.lastSeq = localMessage.seq;
  scrollGroupThread();

  groups.sending = true;
  updateGroupSendState();

  try {
    const response = await request(`/api/v1/groups/${encodeURIComponent(groups.current.id)}/chat`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    if (response.status === 409) {
      toast("这个群上一轮还在跑，等它说完（或点停止）");
      rollbackLocalMessage(localMessage.id, text);
      return;
    }
    if (response.status === 400) {
      const data = await response.json().catch(() => ({}));
      toast(data.message || "发不出去");
      // 重名歧义：后端把候选（名字 + 领域）带回来，这里给一条可点的长标签提示条
      showGroupAtHint(data.candidates);
      rollbackLocalMessage(localMessage.id, text);
      return;
    }
    if (!response.ok || !response.body) {
      toast(`请求失败：HTTP ${response.status}`);
      rollbackLocalMessage(localMessage.id, text);
      return;
    }

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let index;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data:")) continue;
          let event;
          try {
            event = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }
          handleGroupStreamEvent(event);
        }
      }
    }
    // 流收尾：以服务端时间线为准对齐一遍（拿到各成员终稿的 seq/at）
    await refreshGroupTimeline();
  } catch {
    toast("连接断了，稍后重试");
  } finally {
    groups.sending = false;
    groups.streamSender = null;
    groups.streamBubble = null;
    updateGroupSendState();
    void refreshGroupSidebarQuiet();
  }
}

function rollbackLocalMessage(localId, text) {
  groups.messages = groups.messages.filter((m) => m.id !== localId);
  const bubble = el.groupThread.querySelector(`[data-msg-id="${localId}"]`);
  bubble?.remove();
  // 渲染游标跟着回退：下一条追加仍按真实最后一条判合并/日界
  const last = groups.messages[groups.messages.length - 1];
  groups.lastMeta = last ? groupMetaOf(last) : null;
  el.groupInput.value = text;
  resizeGroupInput();
  updateGroupSendState();
}

/** 流式帧渲染：start 换发言者、delta 追加、notice 落系统行、done 收尾。 */
function handleGroupStreamEvent(event) {
  if (event.type === "start") {
    groups.streamSender = event.sender || null;
    groups.streamText = "";
    // 日界与回读同一条规则（2026-11-08 批三）：跨天了先插分割线，实时追加也不漏
    const streamDay = groupDayOf({ at: new Date().toISOString() });
    if (!groups.lastMeta || groups.lastMeta.day !== streamDay) {
      appendGroupDayDivider(streamDay);
      groups.lastMeta = { key: "stream", day: streamDay, at: Date.now() };
    }
    // 开一个正在发言的气泡（同 renderGroupTimeline 的左对齐形态）
    const bubble = document.createElement("div");
    bubble.className = "gmsg them streaming";
    const avatar = document.createElement("span");
    avatar.className = "pt-avatar gmsg-avatar";
    const senderMember = groups.current?.members.find((m) => m.partnerId === event.sender?.id) ?? null;
    paintAvatar(avatar, groupMemberAvatar(senderMember), event.sender?.name || "");
    const stack = document.createElement("div");
    stack.className = "gmsg-stack";
    const head = document.createElement("div");
    head.className = "gmsg-head";
    const who = document.createElement("span");
    who.className = "gmsg-who";
    who.textContent = event.sender?.name || "执事";
    const when = document.createElement("span");
    when.className = "gmsg-at gmsg-live";
    when.textContent = "正在发言…";
    head.append(who, when);
    const body = document.createElement("div");
    body.className = "gmsg-body";
    stack.append(head, body);
    bubble.append(avatar, stack);
    el.groupThread.append(bubble);
    groups.streamBubble = { root: bubble, body, when };
    scrollGroupThread();
  } else if (event.type === "delta") {
    if (groups.streamBubble) {
      groups.streamText += event.text || "";
      groups.streamBubble.body.textContent = groups.streamText;
      scrollGroupThread();
    }
  } else if (event.type === "progress") {
    if (groups.streamBubble) {
      groups.streamBubble.when.textContent = event.phase === "working" ? "正在动手…" : "正在思考…";
    }
  } else if (event.type === "notice") {
    const line = document.createElement("div");
    line.className = "group-sys";
    line.textContent = event.text || "";
    el.groupThread.append(line);
    scrollGroupThread();
  } else if (event.type === "done") {
    if (groups.streamBubble) {
      groups.streamBubble.root.classList.remove("streaming");
      if (groups.streamBubble.when) groups.streamBubble.when.textContent = formatGroupTime(new Date().toISOString());
    }
    groups.streamSender = null;
    groups.streamBubble = null;
  }
}

/** 流结束后以服务端时间线为准（终稿 seq/at/被停的半截话都对上） */
async function refreshGroupTimeline() {
  if (!groups.current) return;
  const response = await request(`/api/v1/groups/${encodeURIComponent(groups.current.id)}/messages?limit=200`, { cache: "no-store" }).catch(() => null);
  if (!response?.ok) return;
  const data = await response.json().catch(() => ({}));
  groups.messages = Array.isArray(data.messages) ? data.messages : [];
  groups.lastSeq = Number(data.lastSeq ?? 0);
  renderGroupTimeline();
}

async function refreshGroupSidebarQuiet() {
  const response = await request("/api/v1/groups", { cache: "no-store" }).catch(() => null);
  if (!response?.ok) return;
  const data = await response.json().catch(() => ({}));
  groups.list = Array.isArray(data.groups) ? data.groups : groups.list;
  renderGroupSidebar();
}

/** 时间线自己滚（2026-11-07 修）：原来滚的是外层 #groups-scroll，
 *  但群会话态是 `height:100%` 的 flex 列，外层根本不溢出——滚动量全落空，
 *  新消息来了不跟随。 */
function scrollGroupThread() {
  const thread = el.groupThread;
  if (thread) thread.scrollTop = thread.scrollHeight;
}

async function stopGroupRoundWeb() {
  if (!groups.current) return;
  await request(`/api/v1/groups/${encodeURIComponent(groups.current.id)}/stop`, { method: "POST" }).catch(() => undefined);
}

/* ── @picker（cindy 同款：纯文本 + 发送时服务端重解析）────── */

const groupAt = { open: false, items: [], index: 0, from: -1 };

/* 进出场动画（2026-11-25）：收起跑 140ms 才 hidden=true，这期间 hidden 还是 false，
 * 不能拿它当"开没开"的判据（逻辑态用 groupAt.open + groupAtShown，代际号防旧回调晚到）。 */
let seq = 0;
let groupAtShown = false;

function closeGroupAtPop() {
  groupAt.open = false;
  const node = el.groupAtpop;
  // 已经关着、或收起动画正在跑：别起第二遍（每次按键都会进 updateGroupAtPop，重启动画会一直关不掉）
  if (!node || node.hidden || !groupAtShown) return;
  groupAtShown = false;
  const mine = ++seq;
  popAnimateOut(node).then(() => {
    if (mine !== seq) return; // 已被重新打开，别藏
    node.hidden = true;
  });
}

function updateGroupAtPop() {
  if (!el.groupInput || !el.groupAtpop || !groups.current) return;
  const caret = el.groupInput.selectionStart ?? el.groupInput.value.length;
  const before = el.groupInput.value.slice(0, caret);
  const match = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!match) {
    closeGroupAtPop();
    return;
  }
  const typed = match[2].toLowerCase();
  // 长标签输入中（`@名字·域`）：前半段匹配名字、后半段匹配领域（2026-11-08 批三）
  const [namePart = "", domainPart] = typed.split("·");
  const candidates = [];
  if (domainPart === undefined && (!typed || "所有人".startsWith(typed))) {
    candidates.push({ label: "所有人", insert: "@所有人 " });
  }
  for (const member of groups.current.members) {
    const nameHit = !namePart || member.name.toLowerCase().includes(namePart);
    const domainHit =
      domainPart === undefined || (member.domain || "").toLowerCase().startsWith(domainPart);
    if (!nameHit || !domainHit) continue;
    // 带领域的一律按长标签展示与插入：重名时短名会被后端拒绝，
    // 这里给的是"唯一能写对的形式"，而不是让用户先撞一次 400 再回来改。
    candidates.push(
      member.domain
        ? { label: `${member.name}（${member.domain}）`, insert: `@${member.name}·${member.domain} ` }
        : { label: member.name, insert: `@${member.name} ` },
    );
  }
  if (!candidates.length) {
    closeGroupAtPop();
    return;
  }
  groupAt.open = true;
  groupAt.items = candidates.slice(0, 8);
  groupAt.index = 0;
  groupAt.from = caret - match[2].length - 1;
  el.groupAtpop.replaceChildren(
    ...groupAt.items.map((item, i) => {
      const row = document.createElement("div");
      row.className = `group-at-item${i === groupAt.index ? " current" : ""}`;
      row.setAttribute("role", "option");
      row.textContent = item.label;
      row.addEventListener("mousedown", (mouseEvent) => {
        mouseEvent.preventDefault();
        pickGroupAt(i);
      });
      return row;
    }),
  );
  // 入场（2026-11-25，pop-anim.js）：只在「隐藏 → 显示」那一下播；已经开着时只换候选，
  // 输入每个字符都播一遍会让候选条一直在闪。
  seq += 1; // 让还在跑的关闭回调失效
  if (!groupAtShown) {
    groupAtShown = true;
    el.groupAtpop.hidden = false;
    popAnimateIn(el.groupAtpop);
  }
}

function pickGroupAt(index) {
  const item = groupAt.items[index];
  if (!item || !el.groupInput) {
    closeGroupAtPop();
    return;
  }
  const value = el.groupInput.value;
  el.groupInput.value = value.slice(0, groupAt.from) + item.insert + value.slice(el.groupInput.selectionStart ?? value.length);
  const caret = groupAt.from + item.insert.length;
  el.groupInput.setSelectionRange(caret, caret);
  closeGroupAtPop();
  resizeGroupInput();
  updateGroupSendState();
  el.groupInput.focus();
}

/* ── 重名 400 的候选条（2026-11-08 批三）───────────────────
 * 后端仍然拒绝不猜：重名短名 400，但把候选（名字 + 领域）随载荷带回来。
 * 这里把候选画成一条可点的提示：点一下插入唯一长标签 @名字·领域，用户改一个字就能发。
 * 不给后端加"猜一个人"的余地，也不让用户自己去记领域。 */

function clearGroupAtHint() {
  if (!el.groupAtHint) return;
  el.groupAtHint.replaceChildren();
  el.groupAtHint.hidden = true;
}

function showGroupAtHint(candidates) {
  if (!el.groupAtHint) return;
  const list = (Array.isArray(candidates) ? candidates : []).filter((item) => item && item.name);
  if (!list.length) {
    clearGroupAtHint();
    return;
  }
  el.groupAtHint.replaceChildren();
  const label = document.createElement("span");
  label.className = "group-at-hint-label";
  label.textContent = "重名了，改用长标签点名：";
  el.groupAtHint.append(label);
  for (const item of list) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "group-at-hint-chip";
    chip.textContent = item.domain ? `${item.name}（${item.domain}）` : item.name;
    chip.title = item.domain ? `插入 @${item.name}·${item.domain}` : `插入 @${item.name}`;
    chip.addEventListener("click", () => insertGroupMention(item));
    el.groupAtHint.append(chip);
  }
  el.groupAtHint.hidden = false;
}

export { clearGroupAtHint, closeGroupAtPop, groupAt, handleGroupStreamEvent, pickGroupAt, refreshGroupSidebarQuiet, refreshGroupTimeline, resizeGroupInput, rollbackLocalMessage, scrollGroupThread, sendGroupMessage, showGroupAtHint, stopGroupRoundWeb, updateGroupAtPop, updateGroupSendState };
