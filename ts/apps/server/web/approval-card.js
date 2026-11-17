/**
 * 审批卡片
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { groups } from "./groups-base.js";
import { request } from "./net.js";
import { parsePartnerExternalId } from "./partner-sessions.js";
import { state } from "./state.js";

/* ── 审批卡片（批次二 A1）：写类工具要人确认 ─────────────
   按 callId 去重：SSE 与"刷新补挂"两条路都可能把它画一次。
   答复后按钮置灰、倒计时停下；卡片留在原地作为痕迹。
   2026-11-08 批三：标题下补一行「来自 <会话或群名> · <执事名>」——群成员的审批
   与主人会话的审批长得一样，不标来源就分不清是谁在等确认。 */
const approvalCards = new Map();

/** `partner-<pid>-group-<gid>` → { partnerId, groupId }；不是群成员会话返回 null */
function parseGroupMemberConversation(conversationId) {
  const value = String(conversationId || "");
  if (!value.startsWith("partner-")) return null;
  const rest = value.slice("partner-".length);
  const at = rest.indexOf("-group-");
  if (at < 0) return null;
  const partnerId = rest.slice(0, at);
  const groupId = rest.slice(at + "-group-".length);
  if (!partnerId || !groupId) return null;
  return { partnerId, groupId };
}

/** 执事展示名（审批来源用：查不到就给空串，让调用方省略，不猜） */
function approvalPartnerName(partnerId) {
  if (!partnerId) return "";
  if (partnerId === "chief") return "总管";
  return state.partners.find((item) => item.id === partnerId)?.name || "";
}

/** 群投影（当前打开的群优先，其次侧栏列表；都查不到返回 null） */
function groupProjectionById(groupId) {
  if (groups.current?.id === groupId) return groups.current;
  return groups.list.find((item) => item.id === groupId) || null;
}

/**
 * 审批来源标签（2026-11-08 批三）：「来自 <会话或群名> · <执事名>」。
 * 只写能反查到的：群成员会话 → 群名 + 成员名；执事专线 → 执事名；主对话 → 总管。
 * task- 前缀（自主轮/课题专线）与查不到的一律返回空串——如实不显示，不猜。
 */
function approvalSourceLabel(conversationId) {
  const value = String(conversationId || "");
  if (!value) return "";
  const ref = parseGroupMemberConversation(value);
  if (ref) {
    const group = groupProjectionById(ref.groupId);
    const memberName =
      group?.members.find((member) => member.partnerId === ref.partnerId)?.name ||
      approvalPartnerName(ref.partnerId);
    return [group?.name ? `群「${group.name}」` : "群聊", memberName].filter(Boolean).join(" · ");
  }
  if (value.startsWith("task-")) return "";
  // canonical / side 都解析出真正的 partnerId（不能 slice——副会话会切出 id-side-token）。
  const parsed = parsePartnerExternalId(value);
  if (parsed) return approvalPartnerName(parsed.partnerId) || "执事";
  return "总管";
}

/** ask_user 的 args 是 JSON：question / options / recommended（服务端已校验） */
function parseAskUserPayload(raw) {
  try {
    const value = JSON.parse(String(raw || ""));
    return {
      question: String(value.question || "").trim(),
      options: Array.isArray(value.options)
        ? value.options.filter((item) => typeof item === "string").slice(0, 3)
        : [],
      recommended: Number.isInteger(value.recommended) ? value.recommended : null,
    };
  } catch {
    return { question: String(raw || "").trim(), options: [], recommended: null };
  }
}

/**
 * 提问卡（2026-11-09 §3）：模型有事问人，不执行任何工具。
 * 答复走 POST /agent/approvals/:callId/answer（不是 approve/reject）；
 * 点选项 = 直接答复该选项原文，也可以在输入框里自己写。
 */
function renderAskUserCard(card, event) {
  const payload = parseAskUserPayload(event.args);
  const title = document.createElement("p");
  title.className = "attention-text";
  title.textContent = "有个问题等你回答";
  card.append(title);

  const source = approvalSourceLabel(event.conversationId);
  if (source) {
    const from = document.createElement("p");
    from.className = "approval-source";
    from.textContent = `来自 ${source}`;
    card.append(from);
  }

  const question = document.createElement("p");
  question.className = "attention-text";
  question.textContent = payload.question || "（问题正文缺失）";
  card.append(question);

  const status = document.createElement("div");
  status.className = "approval-meta";
  status.textContent = "等待处理";
  card.append(status);

  const actions = document.createElement("div");
  actions.className = "approval-actions";
  const input = document.createElement("textarea");
  input.className = "cs-textarea";
  input.rows = 2;
  input.placeholder = "直接回答…";
  const send = document.createElement("button");
  send.type = "button";
  send.className = "primary";
  send.textContent = "回答";
  actions.append(input, send);
  card.append(actions);

  const optionButtons = [];
  if (payload.options.length) {
    const options = document.createElement("div");
    options.className = "approval-actions";
    payload.options.forEach((text, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ghost";
      button.textContent =
        index === payload.recommended ? `${text}（建议）` : text;
      button.addEventListener("click", () => void answer(text));
      options.append(button);
      optionButtons.push(button);
    });
    card.append(options);
  }

  const answer = async (text) => {
    if (!text.trim()) return;
    for (const button of optionButtons) button.disabled = true;
    send.disabled = true;
    input.disabled = true;
    try {
      const response = await request(
        `/api/v1/agent/approvals/${encodeURIComponent(event.callId)}/answer`,
        { method: "POST", body: JSON.stringify({ answer: text }) },
      );
      if (!response.ok) throw new Error(String(response.status));
      status.textContent = "已回答";
      approvalCards.delete(event.callId);
      card.classList.add("resolved");
    } catch {
      status.textContent = "答复失败，请重试";
      for (const button of optionButtons) button.disabled = false;
      send.disabled = false;
      input.disabled = false;
    }
  };
  send.addEventListener("click", () => void answer(input.value));

  approvalCards.set(event.callId, { root: card, timer: null });
  return card;
}

function renderApprovalCard(event) {
  if (!event || !event.callId) return null;
  const existing = approvalCards.get(event.callId);
  if (existing) return existing.root;

  const card = document.createElement("div");
  card.className = "attention approval";
  card.dataset.callId = event.callId;

  // ask_user（2026-11-09 §3）：这不是"要不要执行"，是一个问题。
  // 服务端把 question/options 塞在 args（JSON）里，SSE 帧不改契约。
  if (event.tool === "ask_user" || event.kind === "ask_user") {
    return renderAskUserCard(card, event);
  }

  const title = document.createElement("p");
  title.className = "attention-text";
  title.append(document.createTextNode(`要执行 ${event.tool || "工具"}`));
  // 自主轮（例行任务）的审批：工具名旁挂一枚徽章（批次C C2，纯增量）
  if (event.origin === "autonomous") {
    const routineTag = document.createElement("span");
    routineTag.className = "pill-tag";
    routineTag.textContent = "例行任务";
    title.append(routineTag);
  }
  title.append(document.createTextNode("，需要你确认"));
  card.append(title);

  // 来源行（2026-11-08 批三）：群成员轮的审批必须在卡上说是谁/哪个群，
  // 否则同一张卡在主对话与执事专线里长得一模一样，只能靠猜。
  const source = approvalSourceLabel(event.conversationId);
  if (source) {
    const from = document.createElement("p");
    from.className = "approval-source";
    from.textContent = `来自 ${source}`;
    card.append(from);
  }

  const args = document.createElement("pre");
  args.className = "approval-args";
  args.textContent = event.args || "（没有参数）";
  card.append(args);

  const meta = document.createElement("div");
  meta.className = "approval-meta";
  const remain = document.createElement("span");
  // 2026-11-08 扫尾批 8c：审批形态决定这一行。
  // blocking（AGENT_APPROVAL_MODE=blocking）= 旧形态，保留倒计时；
  // async（缺省）= 等待态落库，没有截止时间，只写「等待处理」。
  const blocking = state.capabilities.approvalMode === "blocking";
  let timer = null;
  if (blocking) {
    const deadline = Date.parse(event.deadlineAt || "");
    const tick = () => {
      if (!Number.isFinite(deadline)) {
        remain.textContent = "";
        return;
      }
      const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      remain.textContent = left > 0 ? `剩余 ${left} 秒，超时按拒绝处理` : "已超时";
    };
    tick();
    timer = setInterval(tick, 1000);
  } else {
    remain.textContent = "等待处理";
  }
  meta.append(remain);
  card.append(meta);

  const actions = document.createElement("div");
  actions.className = "approval-actions";
  const rememberLabel = document.createElement("label");
  rememberLabel.className = "approval-remember";
  const remember = document.createElement("input");
  remember.type = "checkbox";
  rememberLabel.append(remember, document.createTextNode("本会话记住这个工具"));
  const approve = document.createElement("button");
  approve.type = "button";
  approve.className = "ghost";
  approve.textContent = "批准";
  const reject = document.createElement("button");
  reject.type = "button";
  reject.className = "ghost";
  reject.textContent = "拒绝";
  actions.append(rememberLabel, approve, reject);
  card.append(actions);

  // 带说明拒绝（2026-11-09 §4.3）：默认折叠，只有一行小字入口；
  // 不填就是普通拒绝（与旧行为逐字节一致），填了服务端把它当"主人的要求"交给模型。
  const more = document.createElement("button");
  more.type = "button";
  more.className = "approval-more";
  more.textContent = "带说明拒绝";
  const feedbackRow = document.createElement("div");
  feedbackRow.className = "approval-feedback";
  feedbackRow.hidden = true;
  const feedbackInput = document.createElement("textarea");
  feedbackInput.className = "cs-textarea";
  feedbackInput.rows = 2;
  feedbackInput.placeholder = "告诉他怎么改（可选，不填就是普通拒绝）";
  const feedbackSend = document.createElement("button");
  feedbackSend.type = "button";
  feedbackSend.className = "ghost";
  feedbackSend.textContent = "拒绝并说明";
  feedbackRow.append(feedbackInput, feedbackSend);
  card.append(more, feedbackRow);
  more.addEventListener("click", () => {
    feedbackRow.hidden = !feedbackRow.hidden;
    if (!feedbackRow.hidden) feedbackInput.focus();
  });

  const decide = async (decision, note = "") => {
    approve.disabled = true;
    reject.disabled = true;
    remember.disabled = true;
    feedbackSend.disabled = true;
    try {
      const response = await request(
        `/api/v1/agent/approvals/${encodeURIComponent(event.callId)}`,
        {
          method: "POST",
          body: JSON.stringify({
            decision,
            remember: remember.checked,
            ...(note.trim() ? { feedback: note.trim() } : {}),
          }),
        },
      );
      if (!response.ok) throw new Error(String(response.status));
      const data = await response.json();
      const label = {
        approved: "已批准",
        rejected: "已拒绝",
        timeout: "已超时（按拒绝处理）",
        aborted: "本轮已停止",
      }[data.status];
      remain.textContent = label || String(data.status || "已处理");
      clearInterval(timer);
      approvalCards.delete(event.callId);
      card.classList.add("resolved");
    } catch {
      remain.textContent = "答复失败，请重试";
      approve.disabled = false;
      reject.disabled = false;
      remember.disabled = false;
      feedbackSend.disabled = false;
    }
  };
  approve.addEventListener("click", () => void decide("approve"));
  reject.addEventListener("click", () => void decide("reject"));
  feedbackSend.addEventListener("click", () => void decide("reject", feedbackInput.value));

  approvalCards.set(event.callId, { root: card, timer });
  return card;
}

export { approvalCards, approvalPartnerName, approvalSourceLabel, groupProjectionById, parseAskUserPayload, parseGroupMemberConversation, renderApprovalCard, renderAskUserCard };
