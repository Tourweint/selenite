/**
 * 一人多会话 · 对外 id 解析（服务端 partner-session-role.ts 的前端镜像，2026-11-17 批2）。
 *
 * 必须无 DOM 副作用：node --test 直接 import 本模块；弹层 / 请求逻辑一律放
 * partner-sessions-ui.js。正则与服务端逐字一致，禁止 split("-")（partnerId 本身可能含 "-"）。
 */

/** side → group → canonical；非 partner- → null。返回 {partnerId, role} | null。 */
export function parsePartnerExternalId(externalId) {
  if (typeof externalId !== "string" || !externalId.startsWith("partner-")) return null;
  const side = /^partner-(.+)-side-[0-9a-f]{8}$/.exec(externalId);
  if (side) return { partnerId: side[1], role: "side" };
  const group = /^partner-(.+)-group-(.+)$/.exec(externalId);
  if (group) return { partnerId: group[1], role: "group" };
  const canonical = /^partner-(.+)$/.exec(externalId);
  if (canonical) return { partnerId: canonical[1], role: "canonical" };
  return null;
}

/** 当前会话属于哪个执事；canonical + side → partnerId；group → ""（不是执事专线入口）。 */
export function partnerIdOfConversation(externalId) {
  const parsed = parsePartnerExternalId(externalId);
  if (!parsed || parsed.role === "group") return "";
  return parsed.partnerId;
}

/** 选择器行标题：有 title 用 title；空会话（turns=0）用「新会话」。 */
export function partnerSessionLabel(session) {
  const title = String(session?.title || "").trim();
  if (title) return title;
  const firstText = String(session?.firstText || "").trim();
  const turns = Number(session?.turns) || 0;
  return (turns > 0 && firstText) || "新会话";
}

/**
 * 把选择器列表按 `origin.source` 建成二级树（2026-11-18）。
 *
 * - 母会话在列表里 → 副本挂到 `children`；母会话不在（已归档 / 已删）→ 副本留在顶层；
 * - 保持服务端给的顺序（canonical 第一、其余 lastAt 倒序），不重排；
 * - 环（A→B→A）兜底：先遍历到的那个当根，其余已访问节点不再重复挂。
 * 纯函数，无 DOM；UI 只负责按 children 递归渲染。
 */
export function buildSessionTree(sessions) {
  const list = Array.isArray(sessions) ? sessions.filter((item) => item && item.conversationId) : [];
  const byId = new Map(list.map((session) => [session.conversationId, session]));
  const childrenOf = new Map();
  const roots = [];
  for (const session of list) {
    const parentId = String(session?.origin?.source || "");
    const parent = parentId && parentId !== session.conversationId ? byId.get(parentId) : null;
    if (!parent) {
      roots.push(session);
      continue;
    }
    const children = childrenOf.get(parentId) || [];
    children.push(session);
    childrenOf.set(parentId, children);
  }

  const visited = new Set();
  const build = (session) => {
    visited.add(session.conversationId);
    const children = (childrenOf.get(session.conversationId) || [])
      .filter((child) => !visited.has(child.conversationId))
      .map(build);
    return { session, children };
  };

  const tree = [];
  for (const root of roots) {
    if (visited.has(root.conversationId)) continue;
    tree.push(build(root));
  }
  // 环兜底：没有任何根时，按原顺序把还没访问过的节点当根。
  for (const session of list) {
    if (!visited.has(session.conversationId)) tree.push(build(session));
  }
  return tree;
}

/** 选择器每页行数（2026-11-21）：母会话 + 子副本一起数，10 行一页。 */
export const SESSION_PAGE_SIZE = 10;

/**
 * 把会话树切成页（2026-11-21）：子树不拆——母会话在第几页，它的副本就跟着在第几页。
 * 一页装到 SESSION_PAGE_SIZE 行为止；单棵子树超过一页时独占一页（页内照常滚）。
 * 纯函数，无 DOM；页内保持原顺序，页数随数据变少时由调用方钳页码。
 */
export function paginateSessionTree(tree, pageSize = SESSION_PAGE_SIZE) {
  const nodes = Array.isArray(tree) ? tree : [];
  const size = Math.max(1, Math.floor(Number(pageSize) || SESSION_PAGE_SIZE));
  const rowsOf = (node) => {
    let count = 1;
    for (const child of node.children || []) count += rowsOf(child);
    return count;
  };
  const pages = [];
  let current = [];
  let used = 0;
  for (const node of nodes) {
    const rows = rowsOf(node);
    if (current.length > 0 && used + rows > size) {
      pages.push(current);
      current = [];
      used = 0;
    }
    current.push(node);
    used += rows;
  }
  if (current.length > 0) pages.push(current);
  return pages;
}
