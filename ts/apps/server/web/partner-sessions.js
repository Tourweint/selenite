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
