/**
 * 任务中心的状态表 / 徽标 / 陈旧提示
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { esc } from "./markdown.js";

/* ── 任务中心（2026-11-04） ────────────────────────────────
 * 只读看板。数据：GET /api/v1/tickets（列表）与 GET /api/v1/tickets/:id（详情）。
 * 列按「在等谁」分；界面词只有 助理 / 负责人 / 执行者 / 任务单 / 待你处理。
 * 主视图只留「要管的」：done 收进底部的「已完结」折叠区，
 * 不再与进行中的列抢位置（K1，2026-11-05）。
 * L3（2026-11-05）起粒度是「一张卡 = 一条来源对话」：卡头是对话，卡身是这条对话
 * 派出去的每次活（一行一单），子单收在那一行内部；三列喂的是对话卡的聚合灯。
 * 这一版不做改派、不做手动停止，也没有悬浮面板。 */

const TASK_COLUMNS = [
  { id: "ask", label: "待你处理", lamp: "ask" },
  { id: "fail", label: "出错", lamp: "fail" },
  { id: "run", label: "进行中", lamp: "run" },
];

/** [文案, 语气]；语气决定颜色，文案只用人话 */
const TASK_STATUS = {
  received: ["排队中", "idle"],
  planning: ["规划中", "run"],
  planned: ["待派发", "idle"],
  dispatching: ["派发中", "run"],
  reviewing: ["验收中", "run"],
  idle: ["等文件", "ask"],
  needs_you: ["待你处理", "ask"],
  done: ["已完成", "done"],
  failed: ["失败待看", "fail"],
  aborted: ["已中止", "fail"],
  canceled: ["已作废", "idle"],
};

const SUBTASK_STATUS = {
  pending: ["待开始", "idle"],
  running: ["进行中", "run"],
  reported: ["已报告", "run"],
  passed: ["已通过", "done"],
  failed: ["未通过", "fail"],
  blocked: ["受阻", "ask"],
  waiting: ["等待中", "ask"],
  dropped: ["已移除", "idle"],
};

/**
 * 任务阶段条（2026-11-10 批 18 §1.1；2026-11-19 删掉验收层，去掉「验收」段）：
 * 受理 → 规划 → 执行 → 完成。只用 ticket.status 推导；终态失败 / 中止 / 作废
 * **不猜**走到哪一步（返回 -1，只把各阶段画成暗色，真实状态由状态片说）。
 */
const TICKET_STAGES = ["受理", "规划", "执行", "完成"];
const TICKET_STAGE_OF_STATUS = {
  received: 0,
  planning: 1,
  planned: 1,
  dispatching: 2,
  idle: 2,
  needs_you: 2,
  done: 3,
};

function ticketStageIndex(status) {
  const index = TICKET_STAGE_OF_STATUS[String(status || "")];
  return Number.isInteger(index) ? index : -1;
}

function ticketStagesHtml(status) {
  const index = ticketStageIndex(status);
  const nodes = TICKET_STAGES.map((label, i) => {
    const stateOf = i < index ? "done" : i === index ? "now" : "todo";
    return `<li class="td-stage-node" data-state="${stateOf}">${esc(label)}</li>`;
  }).join("");
  return `<div class="td-stages-wrap">
      <ol class="td-stages"${index >= 0 ? ` data-stage="${index}"` : ' data-stage="none"'}>${nodes}</ol>
    </div>`;
}

/** 雇员对外只说「执行者」，类型作为后缀（L3 补齐 qoder 国际/国内、原生、总管） */
const EMPLOYEE_LABEL = {
  "pi-durable": "本机执行者",
  qoder: "Qoder",
  "qoder-intl": "Qoder 国际",
  "qoder-cn": "Qoder 国内",
  codebuddy: "CodeBuddy",
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  doubao: "豆包 CLI",
  mcp: "MCP",
  phone: "手机",
  native: "原生（旧）",
  pool: "池（独立进程）",
  manager: "总管",
};

/** 外部打手区固定卡（2026-11-16 补三档 CLI；2026-11-23 加豆包）：id 就是 ticket.employee 的字面值 */
const TASK_HITTERS = [
  { id: "codebuddy", label: "CodeBuddy" },
  { id: "qoder-intl", label: "Qoder 国际" },
  { id: "qoder-cn", label: "Qoder 国内" },
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "opencode", label: "OpenCode" },
  { id: "doubao", label: "豆包 CLI" },
  { id: "phone", label: "手机" },
];

/**
 * 侧栏徽标口径：还在流程里的单（received/planning/planned/idle/dispatching/
 * reviewing/needs_you）——failed / done / aborted 都不算「正在跑的活」。
 */
const TASK_BADGE_STATUSES = new Set([
  "received",
  "planning",
  "planned",
  "idle",
  "dispatching",
  "reviewing",
  "needs_you",
]);

/** SSE 的「在等谁」映射成列表里的 status，用来做增量更新 */
const PHASE_STATUS = {
  accepted: "planning",
  planning: "planning",
  running: "dispatching",
  reviewing: "reviewing",
  done: "done",
  needs_you: "needs_you",
  failed: "failed",
  aborted: "aborted",
};

/** 「按状态」排序：先处理需要人的，再看跑着的，最后是完成的（done/aborted 只在折叠区里参与排序） */
const STATUS_ORDER = [
  "needs_you",
  "failed",
  "aborted",
  "idle",
  "reviewing",
  "dispatching",
  "planning",
  "received",
  "planned",
  "done",
];

const TASKS_POLL_MS = 20000;
const BADGE_POLL_MS = 60000;

const STATE_ICON = {
  loading:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>',
  empty:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/></svg>',
  error:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
};

function statusError(status) {
  const error = new Error(`HTTP ${status}`);
  error.status = status;
  return error;
}

function employeeText(kind) {
  if (!kind) return "";
  return EMPLOYEE_LABEL[kind] || String(kind);
}

function relativeTime(iso) {
  if (!iso) return "";
  const stamp = new Date(iso).getTime();
  if (!Number.isFinite(stamp)) return "";
  const minutes = Math.floor((Date.now() - stamp) / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(iso).toLocaleDateString("zh-CN");
}

/* ── 陈旧提示（批 31 痕迹蒸发）────────────────────────────
 * 执行中的单超过 24 小时没动静，时间后面补一句「（很久没动静）」。
 * 这是文案不是状态：只改变人看到什么，不改变机器判什么——状态机不降级、不通知。
 * 终态卡（done/failed/aborted/canceled）与 needs_you（等人 ≠ 陈旧）一律不加。 */
const STALE_TICKET_MS = 24 * 60 * 60 * 1000;
const STALE_TICKET_HINT = "（很久没动静）";
function stalenessHint(status, iso) {
  const done_ = ["done", "canceled", "failed", "aborted", "needs_you"];
  if (done_.indexOf(status) !== -1) return "";
  const stamp = new Date(iso).getTime();
  if (!Number.isFinite(stamp)) return "";
  return Date.now() - stamp > STALE_TICKET_MS ? STALE_TICKET_HINT : "";
}

export { BADGE_POLL_MS, EMPLOYEE_LABEL, PHASE_STATUS, STALE_TICKET_HINT, STALE_TICKET_MS, STATE_ICON, STATUS_ORDER, SUBTASK_STATUS, TASKS_POLL_MS, TASK_BADGE_STATUSES, TASK_COLUMNS, TASK_HITTERS, TASK_STATUS, TICKET_STAGES, TICKET_STAGE_OF_STATUS, employeeText, relativeTime, stalenessHint, statusError, ticketStageIndex, ticketStagesHtml };
