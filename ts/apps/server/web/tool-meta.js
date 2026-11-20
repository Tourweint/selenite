/**
 * 工具元数据：名字 → 图标 / 动词 / 时长文案
 *
 * 2026-11-13 从 work-panel.js 拆出：E1 灰块（tool-flow.js）和通知卡（chat-notice.js）
 * 都要用这份表，但旧工作面板本身已退役，不该继续从它身上取常量。
 */

/** 工具名 → 语义分类：图标、动词、以及"这一步到底改了什么" */
const TOOL_KINDS = {
  read: { icon: "read", verb: "读取" },
  write: { icon: "write", verb: "写入" },
  edit: { icon: "edit", verb: "编辑" },
  bash: { icon: "shell", verb: "执行" },
  remember: { icon: "memory", verb: "记住" },
  recall: { icon: "memory", verb: "回忆" },
  set_reminder: { icon: "clock", verb: "提醒" },
  skill: { icon: "skill", verb: "技能" },
  delegate: { icon: "delegate", verb: "派活" },
  propose_project: { icon: "project", verb: "提议项目" },
  web_search: { icon: "search", verb: "搜索" },
  partner_manage: { icon: "delegate", verb: "执事" },
  partner_skill_write: { icon: "skill", verb: "执事技能" },
};

/** 线性图标（与界面其余内联 SVG 同做法：无依赖、无构建） */
const TOOL_ICON_PATHS = {
  read: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H19"/>',
  write: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  shell: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  memory: '<path d="M12 5a3 3 0 1 0-3 3"/><path d="M12 5a3 3 0 1 1 3 3"/><path d="M9 8h6"/><path d="M6 12h12"/><path d="M7 16h10"/><path d="M9 20h6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  skill: '<path d="M12 3l2.2 5.6L20 9.8l-4.4 3.6L17 20l-5-3-5 3 1.4-6.6L4 9.8l5.8-1.2z"/>',
  delegate: '<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M17 8h4"/><path d="m19 6 2 2-2 2"/>',
  project: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  // Lucide search（0.468）：24 视框、2 号描边，与上面同族
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  // 引号气泡：折叠区里"模型说过的话"用（批 32）
  say: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  // 思考块（2026-11-17）：和工具同款灰块，四角星比脑子线条在 11px 上更认得出
  think: '<path d="M9.94 15.5a2 2 0 0 0-1.44-1.44l-6.13-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.13a.5.5 0 0 1 .96 0L14.06 8.5A2 2 0 0 0 15.5 9.94l6.13 1.58a.5.5 0 0 1 0 .96L15.5 14.06a2 2 0 0 0-1.44 1.44l-1.58 6.13a.5.5 0 0 1-.96 0z"/>',
  tool: '<path d="M14.7 6.3a4 4 0 1 0 5 5L21 10l-3-3z"/><path d="m9 15-6 6"/><path d="m14 10-4 4"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  check: '<path d="m20 6-11 11-5-5"/>',
  fail: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
};

function toolKindOf(name) {
  return TOOL_KINDS[name] || { icon: "tool", verb: "" };
}

/** 毫秒 → 「12s」/「1m 05s」/「2h 10m」。低于 1s 给「<1s」，不写 0s 骗人 */
function shortDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const total = Math.round(ms / 1000);
  if (total <= 0) return "<1s";
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}


export { TOOL_ICON_PATHS, TOOL_KINDS, shortDuration, toolKindOf };
