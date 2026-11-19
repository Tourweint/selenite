/**
 * 会话画板（2026-11-17 画板批，方案 `docs/设计方案/2026-11-17-会话画板（单会话回合卡）.md`）。
 *
 * 参照 dsh-synapse 的"回合卡 + 分支车道"：
 * - 一条会话一条横向车道，回合往右长；分支从母会话那张答卡伸出去，另起一条车道；
 * - 一个回合两张卡（问上 / 答下），工具只留计数；
 * - 画布可拖、可缩、可平移；卡片位置存 localStorage，删了只丢排版；
 * - 只读：看结构、看详情、进会话、从答卡再分一支；不在画板里写消息。
 *
 * 作用域写死：数据源只接受一个会话 id（`#/map/<id>`），不装工作区的其它会话。
 */

import { branchErrorText } from "./branch.js";
import { openConversation } from "./chat-open.js";
import { loadChats } from "./chats-list.js";
import { esc, renderMarkdown } from "./markdown.js";
import { request } from "./net.js";
import { openPartnerSessions } from "./partner-sessions-ui.js";
import { partnerIdOfConversation } from "./partner-sessions.js";
import { state } from "./state.js";
import { toast } from "./ui-atoms.js";

/* ── 常量（照 dsh-synapse 的几何，卡片略高一点放得下两行宋体）──────── */

const CARD_W = 252;
const CARD_H = 104;
const PAIR_GAP = 18;
const X_STEP = CARD_W + 56; // 308
const LANE_STEP = CARD_H * 2 + PAIR_GAP + 40; // 266
const ROOT_X = 72;
const ROOT_Y = 64;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.05;
const ZOOM_TAU = 90;
const ZOOM_SETTLE = 0.0015;
const VIEWPORT_MARGIN = 700;
const POS_KEY = "lifediary.chatmap.positions.v1";
// 收起状态（2026-11-18）：副本收起后只留第一张问卡，整条后代不画。
const COLLAPSE_KEY = "lifediary.chatmap.collapsed.v1";

/* ── 元素 ────────────────────────────────────────────── */

const shell = document.getElementById("chat-map");
const titleEl = document.getElementById("map-title");
const backBtn = document.getElementById("map-back");
const refreshBtn = document.getElementById("map-refresh");
const focusBtn = document.getElementById("map-focus");
const switchBtn = document.getElementById("map-switch");
const zoomEl = document.getElementById("map-zoom");
const viewport = document.getElementById("map-viewport");
const content = document.getElementById("map-content");
const edgesEl = document.getElementById("map-edges");
const cardsEl = document.getElementById("map-cards");
const stateEl = document.getElementById("map-state");
const inspector = document.getElementById("map-inspector");
const inspectorMeta = document.getElementById("map-inspector-meta");
const inspectorScroll = document.getElementById("map-inspector-scroll");
const inspectorActions = document.getElementById("map-inspector-actions");
const inspectorClose = document.getElementById("map-inspector-close");
const mapEntry = document.getElementById("chat-map-btn");

const SVG_NS = "http://www.w3.org/2000/svg";

/* ── 状态 ────────────────────────────────────────────── */

const mapState = {
  routeId: "",
  data: null,
  cards: [],
  cardById: new Map(),
  nodeById: new Map(),
  nodes: [],
  visibleNodes: [],
  lanes: new Map(),
  positions: loadPositions(),
  collapsed: loadCollapsed(),
  activeNodeId: "",
  selectedCardId: "",
  camera: { x: 0, y: 0 },
  zoom: 1,
  zoomTarget: 1,
  zoomRaf: 0,
  zoomLast: 0,
  zoomAnchor: null,
  drag: null,
  pan: null,
  mounted: new Map(),
  edges: [],
  edgeByCard: new Map(),
  mountRaf: 0,
  loading: false,
  loadToken: 0,
  messageCache: new Map(),
  inspectorTicket: 0,
};

function loadPositions() {
  try {
    const raw = JSON.parse(localStorage.getItem(POS_KEY) || "{}");
    const map = new Map();
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [key, value] of Object.entries(raw)) {
        const x = Number(value?.x);
        const y = Number(value?.y);
        if (key && Number.isFinite(x) && Number.isFinite(y)) map.set(key, { x, y });
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

function savePositions() {
  try {
    const raw = {};
    for (const [key, value] of mapState.positions) raw[key] = { x: Math.round(value.x), y: Math.round(value.y) };
    localStorage.setItem(POS_KEY, JSON.stringify(raw));
  } catch {
    // 隐私模式 / 配额满：只丢排版，不挡画板
  }
}

function loadCollapsed() {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "[]");
    return new Set(Array.isArray(raw) ? raw.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function saveCollapsed() {
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...mapState.collapsed]));
  } catch {
    // 同 savePositions：只丢收起状态，不挡画板
  }
}

/* ── 路由 / 入口 ─────────────────────────────────────── */

function mapRouteId() {
  const match = /^#\/map\/([A-Za-z0-9._-]+)/.exec(location.hash);
  return match ? decodeURIComponent(match[1]) : "";
}

/** 会话顶栏按钮：能力投影说没有就收起（`CHAT_MAP_ENABLED=false`）。 */
function syncChatMapEntry() {
  if (!mapEntry) return;
  mapEntry.hidden = state.capabilities?.chatMap === false;
}

/** 路由层（`applyRoute`）在 `#/map/<id>` 时调这里；同一 id 重复进入不重复拉。 */
function syncChatMapRoute() {
  syncChatMapEntry();
  const id = mapRouteId();
  if (!id) return;
  // 每次进地图都重拉一次：画板是快照，不假装实时；同一次 enter 由 loadToken 去重。
  void loadMap(id);
}

function openChatMap(conversationId) {
  const id = String(conversationId || "").trim();
  if (!id) {
    toast("先打开一条会话");
    return;
  }
  if (state.capabilities?.chatMap === false) {
    toast("会话地图已关闭");
    return;
  }
  const hash = `#/map/${encodeURIComponent(id)}`;
  if (location.hash === hash) {
    void loadMap(id);
    return;
  }
  location.hash = hash;
}

mapEntry?.addEventListener("click", () => openChatMap(state.conversationId));
backBtn?.addEventListener("click", () => {
  void openConversation(mapState.activeNodeId || mapState.routeId);
});

/* ── 数据 ────────────────────────────────────────────── */

function showState(text, isError = false) {
  if (!stateEl) return;
  stateEl.textContent = text;
  stateEl.classList.toggle("is-error", isError);
  stateEl.hidden = false;
}

function hideState() {
  if (stateEl) stateEl.hidden = true;
}

function clearMap() {
  mapState.cards = [];
  mapState.cardById.clear();
  mapState.nodeById.clear();
  mapState.nodes = [];
  mapState.visibleNodes = [];
  mapState.lanes.clear();
  mapState.mounted.forEach((node) => node.remove());
  mapState.mounted.clear();
  mapState.edges = [];
  mapState.edgeByCard.clear();
  cardsEl?.replaceChildren();
  edgesEl?.replaceChildren();
  viewport?.removeAttribute("data-tip");
  if (switchBtn) {
    switchBtn.hidden = true;
    switchBtn.removeAttribute("data-tip");
  }
  hideInspector();
}

async function loadMap(id) {
  const token = ++mapState.loadToken;
  mapState.loading = true;
  mapState.routeId = id;
  clearMap();
  showState("读地图中…");
  try {
    const response = await request(`/api/v1/agent/chat/${encodeURIComponent(id)}/map`, {
      cache: "no-store",
    });
    if (token !== mapState.loadToken) return;
    const data = await response.json().catch(() => ({}));
    if (token !== mapState.loadToken) return;
    if (!response.ok) {
      const message =
        data.error === "chat_map_disabled"
          ? "会话地图已关闭（CHAT_MAP_ENABLED=false）"
          : data.error === "unknown_conversation"
            ? "这条会话不存在，或已经删除"
            : `读不到地图：HTTP ${response.status}`;
      showState(message, true);
      titleEl.textContent = "会话地图";
      return;
    }
    mapState.data = data;
    mapState.activeNodeId = (data.nodes || []).some((node) => node.id === id) ? id : data.rootId;
    // 打开谁的图就把谁和祖先放出来：收起状态不能把当前会话藏掉。
    expandAncestorsOf(mapState.activeNodeId, data.nodes || []);
    buildModel();
    renderMap();
    requestAnimationFrame(() => focusActive(true));
  } catch (error) {
    if (token !== mapState.loadToken) return;
    showState(`读不到地图：${error.message}`, true);
  } finally {
    if (token === mapState.loadToken) mapState.loading = false;
  }
}

/* ── 模型：回合 → 卡片 / 车道 / 自然坐标 ───────────────── */

function assignLanes(nodes) {
  const childrenOf = new Map();
  const ids = new Set(nodes.map((node) => node.id));
  for (const node of nodes) {
    const parent = node.origin?.source;
    if (!parent || !ids.has(parent) || parent === node.id) continue;
    const list = childrenOf.get(parent) || [];
    list.push(node);
    childrenOf.set(parent, list);
  }
  const lanes = new Map();
  let next = 0;
  const visit = (node) => {
    if (lanes.has(node.id)) return;
    lanes.set(node.id, next);
    next += 1;
    for (const child of childrenOf.get(node.id) || []) visit(child);
  };
  for (const node of nodes) if (!node.origin?.source) visit(node);
  for (const node of nodes) if (!lanes.has(node.id)) visit(node);
  return lanes;
}

/** 打开某条会话的地图时，把它自己和祖先从收起集合里放出来（否则定位不到它）。 */
function expandAncestorsOf(nodeId, nodes) {
  const byId = new Map((nodes || []).map((node) => [node.id, node]));
  let current = nodeId;
  let changed = false;
  const seen = new Set();
  while (current && !seen.has(current)) {
    seen.add(current);
    if (mapState.collapsed.delete(current)) changed = true;
    current = byId.get(current)?.origin?.source || "";
  }
  if (changed) saveCollapsed();
}

function questionTextOf(turn) {
  if (turn.question.hidden) return "自动一轮（定时触发）";
  if (turn.question.text) return turn.question.text;
  if (turn.question.hasAttachments) return "（附件）";
  return "（没有文字）";
}

function answerTextOf(turn) {
  if (!turn.answer) return "还没有回答";
  if (turn.answer.text) return turn.answer.text;
  return "这一轮没有正文";
}

function buildModel() {
  const data = mapState.data;
  if (!data) return;
  const nodes = Array.isArray(data.nodes) ? data.nodes : [];
  mapState.nodes = nodes;
  mapState.nodeById = new Map(nodes.map((node) => [node.id, node]));
  // 已删 / 已归档的收起项不再留着（下次还在地图里出现会莫名其妙是收起的）。
  for (const id of [...mapState.collapsed]) {
    if (!mapState.nodeById.has(id)) mapState.collapsed.delete(id);
  }

  // 子链（只看 ChatOrigins 来源，不看 durable parent）
  const childrenOf = new Map();
  for (const node of nodes) {
    const parent = node.origin?.source;
    if (!parent || parent === node.id) continue;
    const list = childrenOf.get(parent) || [];
    list.push(node.id);
    childrenOf.set(parent, list);
  }

  const rootId = data.rootId;
  const hidden = new Set();
  const hideSubtree = (id) => {
    for (const childId of childrenOf.get(id) || []) {
      if (hidden.has(childId)) continue;
      hidden.add(childId);
      hideSubtree(childId);
    }
  };
  // 非根的空分支 / 已归档 / 已丢失：整支不画。
  // 用户口径（2026-11-18）：删掉的、刚建还没说话的新分支都不该占画板。
  for (const node of nodes) {
    if (node.id === rootId) continue;
    const empty = (node.turns || []).length === 0;
    if (node.archived || node.missing || empty) {
      hidden.add(node.id);
      hideSubtree(node.id);
    }
  }
  // 收起的副本：自己留第一张问卡，后代整支不画。
  for (const id of mapState.collapsed) {
    if (id === rootId || hidden.has(id)) continue;
    hideSubtree(id);
  }

  const visibleNodes = nodes.filter((node) => !hidden.has(node.id));
  mapState.visibleNodes = visibleNodes;
  mapState.lanes = assignLanes(visibleNodes);

  const cards = [];
  const byId = new Map();
  const nodeCards = new Map();

  for (const node of visibleNodes) {
    const lane = mapState.lanes.get(node.id) ?? 0;
    const laneTop = ROOT_Y + lane * LANE_STEP;
    const collapsed = node.id !== rootId && mapState.collapsed.has(node.id);
    const turns = collapsed ? (node.turns || []).slice(0, 1) : node.turns || [];
    const list = [];
    let prevAnswer = null;
    for (const turn of turns) {
      const questionId = `${node.id}:t${turn.index}:q`;
      const question = {
        id: questionId,
        key: questionId,
        nodeId: node.id,
        turnIndex: turn.index,
        role: "question",
        turn,
        node,
        laneTop,
        parentId: prevAnswer ? prevAnswer.id : null,
        answerCard: null,
        questionCard: null,
        natural: { x: ROOT_X, y: laneTop },
        position: { x: ROOT_X, y: laneTop },
        pinned: false,
        collapsible: node.id !== rootId && prevAnswer === null,
        collapsed,
      };
      cards.push(question);
      byId.set(question.id, question);
      list.push(question);
      // 收起只留第一张问卡：答卡不进模型，点卡片看详情仍能读到完整问答。
      if (collapsed) break;
      const answerId = `${node.id}:t${turn.index}:a`;
      const answer = {
        id: answerId,
        key: answerId,
        nodeId: node.id,
        turnIndex: turn.index,
        role: "answer",
        turn,
        node,
        laneTop,
        parentId: questionId,
        answerCard: null,
        questionCard: question,
        natural: { x: ROOT_X, y: laneTop + CARD_H + PAIR_GAP },
        position: { x: ROOT_X, y: laneTop + CARD_H + PAIR_GAP },
        pinned: false,
        collapsible: false,
        collapsed: false,
      };
      question.answerCard = answer;
      cards.push(answer);
      byId.set(answer.id, answer);
      list.push(answer);
      prevAnswer = answer;
    }
    nodeCards.set(node.id, list);
  }

  // 分叉卡挂回母会话那张答卡（找不到就退到母会话第一张卡，再找不到就自由漂浮）
  for (const node of visibleNodes) {
    const list = nodeCards.get(node.id);
    if (!list || list.length === 0) continue;
    const first = list[0];
    let anchor = null;
    const from = node.branchFrom;
    if (from) {
      anchor =
        byId.get(`${from.conversationId}:t${from.turnIndex}:a`) ||
        byId.get(`${from.conversationId}:t${from.turnIndex}:q`) ||
        nodeCards.get(from.conversationId)?.[0] ||
        null;
    }
    first.parentId = anchor ? anchor.id : null;
  }

  // 自然坐标：从父卡往右一格；父卡被拖过也不影响自然链（与 dsh-synapse 同口径）
  for (const card of cards) {
    if (card.role === "answer") {
      card.natural = {
        x: card.questionCard.natural.x,
        y: card.questionCard.natural.y + CARD_H + PAIR_GAP,
      };
      continue;
    }
    const parent = card.parentId ? byId.get(card.parentId) : null;
    card.natural = {
      x: parent ? parent.natural.x + X_STEP : ROOT_X,
      y: card.laneTop,
    };
  }

  // 落地坐标：手动位置优先；答卡跟着自己的问卡走；其余用自然坐标
  for (const card of cards) {
    const saved = mapState.positions.get(card.key);
    if (saved) {
      card.position = { x: saved.x, y: saved.y };
      card.pinned = true;
      continue;
    }
    if (card.role === "answer") {
      card.position = {
        x: card.questionCard.position.x,
        y: card.questionCard.position.y + CARD_H + PAIR_GAP,
      };
      continue;
    }
    card.position = { x: card.natural.x, y: card.natural.y };
  }

  mapState.cards = cards;
  mapState.cardById = byId;
}

/* ── 渲染：卡片 / 连线 ───────────────────────────────── */

const BRANCH_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2.4"/><circle cx="18" cy="6" r="2.4"/><circle cx="12" cy="18" r="2.4"/><path d="M8.4 6h7.2"/><path d="M7.2 8.2 10.8 15.8"/><path d="M16.8 8.2 13.2 15.8"/></svg>';

function createCardEl(card) {
  const article = document.createElement("article");
  const kindClass = card.role === "question" ? "is-question" : "is-answer";
  article.className = `map-card ${kindClass}`;
  article.dataset.cardId = card.id;
  article.dataset.nodeId = card.nodeId;
  article.style.transform = `translate(${Math.round(card.position.x)}px, ${Math.round(card.position.y)}px)`;
  article.style.width = `${CARD_W}px`;
  article.style.height = `${CARD_H}px`;

  const turn = card.turn;
  const isQuestion = card.role === "question";
  const tools = !isQuestion ? turn.answer?.tools : 0;
  const chips = [
    `<span class="map-card-kind">${isQuestion ? "问" : "答"}</span>`,
    `<span class="map-card-turn">第 ${turn.index + 1} 轮</span>`,
    isQuestion && turn.question.hidden ? `<span class="map-card-chip">自动</span>` : "",
    !isQuestion && tools ? `<span class="map-card-chip">工具 ${tools}</span>` : "",
    !isQuestion && !turn.answer ? `<span class="map-card-chip is-muted">未答</span>` : "",
    card.node.archived ? `<span class="map-card-chip is-muted">已归档</span>` : "",
    card.collapsed ? `<span class="map-card-chip is-muted">已收起</span>` : "",
  ]
    .filter(Boolean)
    .join("");
  const text = isQuestion ? questionTextOf(turn) : answerTextOf(turn);
  const textClass = !isQuestion && !turn.answer ? " is-empty" : "";
  const branchable = !isQuestion && Boolean(turn.answer?.id) && card.node.branchable;
  const headTools = [
    branchable
      ? `<button class="map-tool" type="button" data-act="branch" data-tip="从这里另开一支" aria-label="从这里另开一支">${BRANCH_ICON}</button>`
      : "",
    card.collapsible
      ? `<button class="map-tool is-toggle" type="button" data-act="toggle" data-tip="${card.collapsed ? "展开这支" : "收起这支"}" aria-label="${card.collapsed ? "展开这支" : "收起这支"}">${card.collapsed ? "+" : "−"}</button>`
      : "",
  ]
    .filter(Boolean)
    .join("");
  article.innerHTML = `
    <div class="map-card-head">
      <span class="map-card-chips">${chips}</span>
      ${headTools ? `<span class="map-card-tools">${headTools}</span>` : ""}
    </div>
    <p class="map-card-text${textClass}">${esc(text)}</p>`;
  return article;
}

function mountCard(card) {
  const element = createCardEl(card);
  cardsEl.append(element);
  mapState.mounted.set(card.id, element);
  return element;
}

function worldViewportRect() {
  const rect = viewport.getBoundingClientRect();
  const cssZoom = cssZoomOf();
  const width = rect.width / cssZoom;
  const height = rect.height / cssZoom;
  const margin = VIEWPORT_MARGIN / mapState.zoom;
  return {
    left: (-mapState.camera.x) / mapState.zoom - margin,
    top: (-mapState.camera.y) / mapState.zoom - margin,
    right: (-mapState.camera.x + width) / mapState.zoom + margin,
    bottom: (-mapState.camera.y + height) / mapState.zoom + margin,
  };
}

function syncCardMounts() {
  if (!cardsEl) return;
  const bounds = worldViewportRect();
  for (const card of mapState.cards) {
    const visible =
      card.position.x + CARD_W >= bounds.left &&
      card.position.x <= bounds.right &&
      card.position.y + CARD_H >= bounds.top &&
      card.position.y <= bounds.bottom;
    const mounted = mapState.mounted.get(card.id);
    if (visible && !mounted) {
      const element = mountCard(card);
      element.classList.toggle("is-selected", card.id === mapState.selectedCardId);
    } else if (!visible && mounted) {
      mounted.remove();
      mapState.mounted.delete(card.id);
    }
  }
}

function scheduleMountSync() {
  if (mapState.mountRaf) return;
  mapState.mountRaf = requestAnimationFrame(() => {
    mapState.mountRaf = 0;
    syncCardMounts();
  });
}

function edgePath(from, to) {
  const fromX = from.position.x;
  const fromY = from.position.y;
  const toX = to.position.x;
  const toY = to.position.y;
  if (from.role === "question" && to.role === "answer" && to.questionCard === from) {
    const fromCx = fromX + CARD_W / 2;
    const toCx = toX + CARD_W / 2;
    const start = fromY + CARD_H;
    const end = toY;
    const bend = Math.min(28, Math.max(8, Math.abs(end - start) * 0.45));
    const sign = end >= start ? 1 : -1;
    return `M ${fromCx} ${start} C ${fromCx} ${start + sign * bend}, ${toCx} ${end - sign * bend}, ${toCx} ${end}`;
  }
  const startX = fromX + CARD_W;
  const startY = fromY + CARD_H / 2;
  const endX = toX;
  const endY = toY + CARD_H / 2;
  const sign = endX >= startX ? 1 : -1;
  const bend = Math.min(110, Math.max(36, Math.abs(endX - startX) * 0.2));
  return `M ${startX} ${startY} C ${startX + sign * bend} ${startY}, ${endX - sign * bend} ${endY}, ${endX} ${endY}`;
}

function renderEdges() {
  if (!edgesEl) return;
  edgesEl.replaceChildren();
  mapState.edges = [];
  mapState.edgeByCard = new Map();
  for (const card of mapState.cards) {
    if (!card.parentId) continue;
    const parent = mapState.cardById.get(card.parentId);
    if (!parent) continue;
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", edgePath(parent, card));
    const branch = parent.nodeId !== card.nodeId;
    if (branch) path.classList.add("is-branch");
    if (parent.nodeId === mapState.activeNodeId && card.nodeId === mapState.activeNodeId) {
      path.classList.add("is-active");
    }
    path.dataset.from = parent.id;
    path.dataset.to = card.id;
    edgesEl.append(path);
    const edge = { from: parent, to: card, path };
    mapState.edges.push(edge);
    for (const id of [parent.id, card.id]) {
      const set = mapState.edgeByCard.get(id) || new Set();
      set.add(edge);
      mapState.edgeByCard.set(id, set);
    }
  }
}

function refreshEdgesFor(cardIds) {
  const seen = new Set();
  for (const id of cardIds) {
    for (const edge of mapState.edgeByCard.get(id) || []) {
      if (seen.has(edge)) continue;
      seen.add(edge);
      edge.path.setAttribute("d", edgePath(edge.from, edge.to));
    }
  }
}

function renderMap() {
  if (!content) return;
  mapState.mounted.forEach((node) => node.remove());
  mapState.mounted.clear();
  cardsEl.replaceChildren();
  renderEdges();
  updateHeader();
  updateTransform();
  syncCardMounts();
  updateZoomMeter();
  const hasCards = mapState.cards.length > 0;
  if (hasCards) hideState();
  else if (!mapState.loading) showState("这条会话还没有回合。");
  restoreSelection();
}

function restoreSelection() {
  if (!mapState.selectedCardId) return;
  const card = mapState.cardById.get(mapState.selectedCardId);
  if (!card) {
    mapState.selectedCardId = "";
    hideInspector();
    return;
  }
  const element = mapState.mounted.get(card.id);
  element?.classList.add("is-selected");
  renderInspector();
}

/* ── 相机 / 缩放 ─────────────────────────────────────── */

function cssZoomOf() {
  const value = Number.parseFloat(getComputedStyle(shell).zoom || "1");
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function updateTransform() {
  if (!content) return;
  content.style.transform = `translate(${mapState.camera.x}px, ${mapState.camera.y}px) scale(${mapState.zoom})`;
}

function updateZoomMeter() {
  if (zoomEl) zoomEl.textContent = `${Math.round(mapState.zoom * 100)}%`;
}

function centerOnCard(card) {
  if (!card || !viewport) return;
  const rect = viewport.getBoundingClientRect();
  const cssZoom = cssZoomOf();
  const width = rect.width / cssZoom;
  const height = rect.height / cssZoom;
  mapState.camera = {
    x: width / 2 - (card.position.x + CARD_W / 2) * mapState.zoom,
    y: height / 2 - (card.position.y + CARD_H / 2) * mapState.zoom,
  };
  updateTransform();
  scheduleMountSync();
}

function lastCardOfNode(nodeId) {
  const cards = mapState.cards.filter((card) => card.nodeId === nodeId);
  return cards[cards.length - 1] || null;
}

function focusActive(resetZoom = false, attempt = 0) {
  if (mapState.zoomRaf) {
    cancelAnimationFrame(mapState.zoomRaf);
    mapState.zoomRaf = 0;
  }
  if (resetZoom) {
    mapState.zoom = 1;
    mapState.zoomTarget = 1;
    updateZoomMeter();
  }
  const card =
    lastCardOfNode(mapState.activeNodeId) ||
    mapState.cards[mapState.cards.length - 1] ||
    null;
  if (!card) return;
  // 深链首帧：路由还没把画板显示出来时视口尺寸是 0，等两帧再居中
  const rect = viewport?.getBoundingClientRect();
  if ((!rect || rect.width < 10 || rect.height < 10) && attempt < 12) {
    setTimeout(() => focusActive(false, attempt + 1), 50);
    return;
  }
  centerOnCard(card);
}

function settleZoom() {
  if (mapState.zoomRaf) cancelAnimationFrame(mapState.zoomRaf);
  mapState.zoomRaf = 0;
  mapState.zoom = mapState.zoomTarget;
  updateTransform();
  updateZoomMeter();
  scheduleMountSync();
}

function zoomAt(delta, clientX, clientY) {
  if (!viewport) return;
  const rect = viewport.getBoundingClientRect();
  const cssZoom = cssZoomOf();
  const localX = (clientX - rect.left) / cssZoom;
  const localY = (clientY - rect.top) / cssZoom;
  const worldX = (localX - mapState.camera.x) / mapState.zoom;
  const worldY = (localY - mapState.camera.y) / mapState.zoom;
  const next = Math.round(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, mapState.zoomTarget + delta)) * 100) / 100;
  if (next === mapState.zoomTarget) return;
  mapState.zoomTarget = next;
  mapState.zoomAnchor = { localX, localY, worldX, worldY };
  if (!mapState.zoomRaf) {
    mapState.zoomLast = performance.now();
    mapState.zoomRaf = requestAnimationFrame(stepZoom);
  }
}

function stepZoom(now) {
  mapState.zoomRaf = 0;
  const anchor = mapState.zoomAnchor;
  if (!anchor) return;
  const dt = Math.min(64, Math.max(1, now - mapState.zoomLast));
  mapState.zoomLast = now;
  const from = Math.log(mapState.zoom);
  const target = Math.log(mapState.zoomTarget);
  const delta = target - from;
  if (Math.abs(delta) < ZOOM_SETTLE) {
    mapState.zoom = mapState.zoomTarget;
    mapState.camera = {
      x: anchor.localX - anchor.worldX * mapState.zoom,
      y: anchor.localY - anchor.worldY * mapState.zoom,
    };
    updateTransform();
    updateZoomMeter();
    scheduleMountSync();
    return;
  }
  const next = Math.exp(from + delta * (1 - Math.exp(-dt / ZOOM_TAU)));
  mapState.zoom = next;
  mapState.camera = {
    x: anchor.localX - anchor.worldX * next,
    y: anchor.localY - anchor.worldY * next,
  };
  updateTransform();
  updateZoomMeter();
  scheduleMountSync();
  mapState.zoomRaf = requestAnimationFrame(stepZoom);
}

/* ── 交互：拖动 / 平移 / 缩放 ────────────────────────── */

function applyCardPosition(card) {
  const element = mapState.mounted.get(card.id);
  if (element) {
    element.style.transform = `translate(${Math.round(card.position.x)}px, ${Math.round(card.position.y)}px)`;
  }
}

function onCardPointerDown(event) {
  if (event.button !== 0) return;
  const element = event.target.closest?.(".map-card");
  if (!element) return;
  if (event.target.closest("button")) return;
  const card = mapState.cardById.get(element.dataset.cardId);
  if (!card) return;
  event.preventDefault();
  mapState.drag = {
    card,
    element,
    startX: event.clientX,
    startY: event.clientY,
    originX: card.position.x,
    originY: card.position.y,
    answerOrigin: card.answerCard ? { ...card.answerCard.position } : null,
    moved: false,
    pointerId: event.pointerId,
  };
  try {
    element.setPointerCapture(event.pointerId);
  } catch {
    // 某些环境 pointer capture 不可用：window 上的 pointermove/up 仍能收尾
  }
  element.classList.add("is-dragging");
}

function onPointerMove(event) {
  if (mapState.drag) {
    const drag = mapState.drag;
    const cssZoom = cssZoomOf();
    const dx = (event.clientX - drag.startX) / cssZoom;
    const dy = (event.clientY - drag.startY) / cssZoom;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    drag.card.position = { x: drag.originX + dx, y: drag.originY + dy };
    applyCardPosition(drag.card);
    const touched = [drag.card.id];
    const answer = drag.card.answerCard;
    if (answer && !answer.pinned && drag.answerOrigin) {
      answer.position = { x: drag.answerOrigin.x + dx, y: drag.answerOrigin.y + dy };
      applyCardPosition(answer);
      touched.push(answer.id);
    }
    refreshEdgesFor(touched);
    return;
  }
  if (mapState.pan) {
    const pan = mapState.pan;
    const cssZoom = cssZoomOf();
    const dx = (event.clientX - pan.startX) / cssZoom;
    const dy = (event.clientY - pan.startY) / cssZoom;
    if (!pan.moved && Math.hypot(dx, dy) < 4) return;
    pan.moved = true;
    mapState.camera = { x: pan.originX + dx, y: pan.originY + dy };
    updateTransform();
    scheduleMountSync();
  }
}

function onPointerUp(event) {
  if (mapState.drag) {
    const drag = mapState.drag;
    mapState.drag = null;
    drag.element.classList.remove("is-dragging");
    try {
      drag.element.releasePointerCapture(drag.pointerId);
    } catch {
      // 已经释放过就算了
    }
    if (drag.moved) {
      mapState.positions.set(drag.card.key, {
        x: Math.round(drag.card.position.x),
        y: Math.round(drag.card.position.y),
      });
      const answer = drag.card.answerCard;
      if (answer && !answer.pinned && drag.answerOrigin) {
        mapState.positions.set(answer.key, {
          x: Math.round(answer.position.x),
          y: Math.round(answer.position.y),
        });
      }
      savePositions();
    } else {
      selectCard(drag.card.id);
    }
    return;
  }
  if (mapState.pan) {
    const pan = mapState.pan;
    mapState.pan = null;
    viewport.classList.remove("is-panning");
    if (!pan.moved) hideInspector();
  }
}

function onViewportPointerDown(event) {
  if (event.button !== 0) return;
  if (event.target.closest?.(".map-card")) return;
  event.preventDefault();
  mapState.pan = {
    startX: event.clientX,
    startY: event.clientY,
    originX: mapState.camera.x,
    originY: mapState.camera.y,
    moved: false,
  };
  viewport.classList.add("is-panning");
  try {
    viewport.setPointerCapture(event.pointerId);
  } catch {
    // 同上
  }
}

function onWheel(event) {
  if (!viewport) return;
  event.preventDefault();
  const delta = event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
  zoomAt(delta, event.clientX, event.clientY);
}

/* ── 选中 / 详情 ─────────────────────────────────────── */

function selectCard(cardId) {
  const card = mapState.cardById.get(cardId);
  if (!card) return;
  mapState.selectedCardId = cardId;
  mapState.activeNodeId = card.nodeId;
  for (const [id, element] of mapState.mounted) {
    element.classList.toggle("is-selected", id === cardId);
  }
  renderInspector();
}

function hideInspector() {
  mapState.inspectorTicket += 1;
  if (inspector) inspector.hidden = true;
  if (inspectorScroll) inspectorScroll.replaceChildren();
  if (inspectorActions) inspectorActions.replaceChildren();
  mapState.selectedCardId = "";
  for (const element of mapState.mounted.values()) element.classList.remove("is-selected");
}

function sectionHtml(label, html, extraClass = "") {
  return `<section class="map-detail-sec ${extraClass}">
    <h3 class="map-detail-label">${esc(label)}</h3>
    <div class="map-detail-body">${html}</div>
  </section>`;
}

function renderInspector() {
  const card = mapState.cardById.get(mapState.selectedCardId);
  if (!card || !inspector) return;
  inspector.hidden = false;
  const turn = card.turn;
  const meta = [
    card.node.title,
    `第 ${turn.index + 1} 轮`,
    turn.answer?.tools ? `工具 ${turn.answer.tools}` : "",
    turn.question.hidden ? "自动触发" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  inspectorMeta.textContent = meta;

  const questionText = turn.question.hidden
    ? "（定时触发，内容不对用户显示）"
    : turn.question.text || (turn.question.hasAttachments ? "（附件）" : "（没有文字）");
  const answerText = answerTextOf(turn);
  inspectorScroll.innerHTML =
    sectionHtml(
      "问",
      `<p class="map-detail-question">${esc(questionText)}</p>`,
      "is-question",
    ) +
    sectionHtml(
      "答",
      turn.answer
        ? `<div class="body map-answer">${renderMarkdown(answerText)}</div>`
        : `<p class="map-detail-empty">还没有回答</p>`,
      "is-answer",
    );
  inspectorScroll.scrollTop = 0;

  inspectorActions.replaceChildren();
  const enter = document.createElement("button");
  enter.type = "button";
  enter.className = "ghost";
  enter.textContent = "进入会话";
  enter.addEventListener("click", () => void openConversation(card.nodeId));
  inspectorActions.append(enter);
  if (turn.answer?.id && card.node.branchable) {
    const branch = document.createElement("button");
    branch.type = "button";
    branch.className = "ghost";
    branch.textContent = "从这里分支";
    branch.addEventListener("click", () => void branchFromCard(card));
    inspectorActions.append(branch);
  }

  // 全文是按需取的：地图只回预览；取不到就保留预览，不假装有全文
  const ticket = ++mapState.inspectorTicket;
  void hydrateInspector(card, ticket);
}

async function fetchMessage(nodeId, messageId) {
  const key = `${nodeId}:${messageId}`;
  if (mapState.messageCache.has(key)) return mapState.messageCache.get(key);
  try {
    const response = await request(
      `/api/v1/agent/chat/${encodeURIComponent(nodeId)}/messages/${encodeURIComponent(messageId)}`,
      { cache: "no-store" },
    );
    if (!response.ok) return null;
    const data = await response.json().catch(() => null);
    const message = data?.message ?? null;
    mapState.messageCache.set(key, message);
    return message;
  } catch {
    return null;
  }
}

async function hydrateInspector(card, ticket) {
  const turn = card.turn;
  if (!turn) return;
  const jobs = [];
  if (turn.question.id) jobs.push(fetchMessage(card.nodeId, turn.question.id));
  else jobs.push(Promise.resolve(null));
  if (turn.answer?.id) jobs.push(fetchMessage(card.nodeId, turn.answer.id));
  else jobs.push(Promise.resolve(null));
  const [question, answer] = await Promise.all(jobs);
  if (ticket !== mapState.inspectorTicket) return;
  if (!inspector || inspector.hidden) return;

  const questionText = question?.text?.trim();
  const answerText = answer?.text?.trim();
  const sections = inspectorScroll.querySelectorAll(".map-detail-sec");
  if (questionText && sections[0]) {
    const body = sections[0].querySelector(".map-detail-body");
    if (body) body.innerHTML = `<p class="map-detail-question">${esc(questionText)}</p>`;
  }
  if (answerText && sections[1]) {
    const body = sections[1].querySelector(".map-detail-body");
    if (body) body.innerHTML = `<div class="body map-answer">${renderMarkdown(answerText)}</div>`;
  }
}

inspectorClose?.addEventListener("click", hideInspector);
inspector?.addEventListener("pointerdown", (event) => event.stopPropagation());

async function branchFromCard(card) {
  const answerId = card?.turn?.answer?.id;
  if (!answerId) {
    toast("这条回答还没有落盘，稍后再试");
    return;
  }
  try {
    const response = await request(
      `/api/v1/agent/chat/${encodeURIComponent(card.nodeId)}/branches`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ atMessageId: answerId }),
      },
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.conversationId) {
      toast(branchErrorText(data.error));
      return;
    }
    toast("已另开一支");
    void loadChats().catch(() => undefined);
    void openConversation(data.conversationId);
  } catch (error) {
    toast(error.message === "forbidden" ? "鉴权失败" : branchErrorText(""));
  }
}

/* ── 顶栏 ────────────────────────────────────────────── */

/** 当前地图能切到哪个会话选择器：执事 → 该执事；总管 → chief；普通对话 → 空。 */
function mapSwitchPartnerId() {
  const id = mapState.activeNodeId || mapState.routeId;
  if (!id) return "";
  const node = mapState.nodeById.get(id);
  if (node?.chatKind === "chief") return "chief";
  if (node?.chatKind === "partner") return partnerIdOfConversation(id);
  return "";
}

function syncMapSwitchButton() {
  if (!switchBtn) return;
  const partnerId = mapSwitchPartnerId();
  switchBtn.hidden = !partnerId;
  if (!partnerId) return;
  const node = mapState.nodeById.get(mapState.activeNodeId || mapState.routeId);
  switchBtn.setAttribute(
    "data-tip",
    `切换另一条会话的地图${node?.title ? `（当前：${node.title}）` : ""}`,
  );
}

function updateHeader() {
  const data = mapState.data;
  if (!data) return;
  const root = mapState.nodeById.get(data.rootId);
  const turns = mapState.cards.filter((card) => card.role === "question").length;
  const branches = Math.max(0, (mapState.visibleNodes?.length ?? mapState.nodes.length) - 1);
  if (titleEl) titleEl.textContent = "会话地图";
  // 会话标题 + 轮数/分支数不再常驻顶栏：鼠标停到画布上时，由全局黑底小签显示
  // （2026-11-18 用户口径：解释性文字收进悬停）。
  if (viewport) {
    const tip = [
      root?.title || "一条会话",
      `${Math.round(turns)} 轮`,
      `${branches} 条分支`,
      data.truncated ? "已截断" : "",
    ]
      .filter(Boolean)
      .join(" · ");
    viewport.setAttribute("data-tip", tip);
  }
  syncMapSwitchButton();
}

/* ── 事件接线 / 路由入口 ─────────────────────────────── */

/** 收起 / 展开一支副本（2026-11-18）：收起只留第一张问卡，后代整支不画。 */
function toggleCollapsed(nodeId) {
  const rootId = mapState.data?.rootId;
  if (!nodeId || nodeId === rootId) return;
  if (mapState.collapsed.has(nodeId)) mapState.collapsed.delete(nodeId);
  else mapState.collapsed.add(nodeId);
  saveCollapsed();
  buildModel();
  renderMap();
}

cardsEl?.addEventListener("pointerdown", onCardPointerDown);
cardsEl?.addEventListener("dblclick", (event) => {
  const element = event.target.closest?.(".map-card");
  const card = element ? mapState.cardById.get(element.dataset.cardId) : null;
  if (card) void openConversation(card.nodeId);
});
cardsEl?.addEventListener("click", (event) => {
  const button = event.target.closest?.("button[data-act]");
  if (!button) return;
  event.stopPropagation();
  const element = button.closest(".map-card");
  const card = element ? mapState.cardById.get(element.dataset.cardId) : null;
  if (!card) return;
  if (button.dataset.act === "branch") void branchFromCard(card);
  else if (button.dataset.act === "toggle") toggleCollapsed(card.nodeId);
});
viewport?.addEventListener("pointerdown", onViewportPointerDown);
viewport?.addEventListener("wheel", onWheel, { passive: false });
window.addEventListener("pointermove", onPointerMove);
window.addEventListener("pointerup", onPointerUp);
window.addEventListener("pointercancel", onPointerUp);
window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (document.documentElement.dataset.route !== "map") return;
  if (inspector && !inspector.hidden) hideInspector();
});
window.addEventListener("resize", () => {
  if (document.documentElement.dataset.route === "map") scheduleMountSync();
});

focusBtn?.addEventListener("click", () => focusActive(false));
switchBtn?.addEventListener("click", () => {
  const partnerId = mapSwitchPartnerId();
  if (!partnerId) return;
  openPartnerSessions(partnerId, { target: "map" });
});
refreshBtn?.addEventListener("click", () => {
  mapState.positions.clear();
  savePositions();
  mapState.collapsed.clear();
  saveCollapsed();
  mapState.data = null;
  const id = mapState.routeId || mapRouteId();
  if (id) void loadMap(id);
});

// 首帧就按能力投影收起入口（loadCapabilities 回来后会再调一次）
syncChatMapEntry();

// 路由自己收：`#/map/<id>` 进出都靠 hashchange；首帧深链再补一次
window.addEventListener("hashchange", syncChatMapRoute);
if (mapRouteId()) setTimeout(syncChatMapRoute, 0);

export { mapRouteId, openChatMap, syncChatMapEntry, syncChatMapRoute };
