/**
 * 从回答分支 · 展示与文案（2026-11-17 批3b，纯函数，无 DOM）。
 *
 * 来源行与失败提示都收在这里，chat-open / chat-thread 只负责挂节点与发请求；
 * node --test 可直接 import（见 src/web-branch.test.mjs）。
 */

import { formatMessageClock } from "./msg-clock.js";

/**
 * 来源行文案：`{ text, source }`；没有 origin 返回 null。
 * text = `副本 · 来自 ${sourceTitle || "一条会话"} · ${时间}`；at 无效时省略时间。
 */
export function formatBranchOrigin(origin) {
  if (!origin || typeof origin !== "object") return null;
  const source = String(origin.source || "");
  if (!source) return null;
  const title = String(origin.sourceTitle || "").trim() || "一条会话";
  const at = Number(origin.at);
  const when = Number.isFinite(at) && at > 0 ? formatMessageClock(at) : "";
  return { text: `副本 · 来自 ${title}${when ? ` · ${when}` : ""}`, source };
}

const BRANCH_ERRORS = {
  conversation_busy: "这一轮还在跑，等它结束再分支",
  branch_point_empty: "这条回答没有正文，不能从这里分支",
  branch_too_large: "这条太长了，先压缩再复制",
  side_sessions_disabled: "副会话插件已关闭（设置 → 插件）",
  branch_not_supported: "这类会话不能分支",
};

/** 分支失败 → 一句人话；未知码给通用句。 */
export function branchErrorText(code) {
  const key = String(code || "");
  return BRANCH_ERRORS[key] || "分支失败，稍后再试";
}
