/**
 * 高级开关 + 自动归档设置区
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { attr, esc } from "./markdown.js";
import { request } from "./net.js";
import { mountSegmented, rowMarkup, setSwitchChecked, switchMarkup, syncSegmented } from "./settings-atoms.js";
import { state } from "./state.js";
import { toast } from "./ui-atoms.js";

/* ── 高级开关（2026-11-09）：服务端 env 行为开关搬进界面 ──────────
 * 数据面：GET/PUT /api/v1/agent/flags（服务端 .data/agent-flags.json 覆盖 env，见 flags.ts）。
 * hot=true 改完即时生效；hot=false（路由挂载/工具注册类，启动时冻结）重启后生效——
 * toast 与悬停提示都写明，不装即时。密钥/路径/令牌类 env 不进这张表（密钥纪律）。 */

/** 多档开关的选项（键不在表里 = 布尔开关）。value 是写进 env 的真值，label 给人看。 */
const FLAG_CHOICES = {
  MEMORY_EXTRACT: [
    { value: "auto", label: "auto" },
    { value: "llm", label: "llm" },
    { value: "rule", label: "rule" },
  ],
  AUTONOMY_ENABLED: [
    { value: "false", label: "关" },
    { value: "observe", label: "只观察" },
    { value: "true", label: "开" },
  ],
};

const FLAG_LABELS = {
  AUTONOMY_ENABLED: { label: "自主轮", tip: "定时任务 / 事件唤醒、没人盯着跑的一轮叫自主轮。关 = 完全不动；只观察 = 照常判定但只记账、不真的去做（先看它本来会做什么，放几天再决定）；开 = 真起轮：卡住 / 等你批 / 出错会提醒你，自主轮里写文件 / 跑命令 / 派活一律先问你（2026-11-13 起默认开，想关切到「关」）。" },
  AGENT_ATTACHMENTS: { label: "附件", tip: "对话里能发图片附件；关掉后分段发送会被拒。" },
  AGENT_EDIT_RESEND: { label: "编辑重发", tip: "自己的消息可以编辑后重发。" },
  CURRENT_PROJECT: { label: "当前项目", tip: "派活按当前项目归属；关掉 = 只有主工作区杂事态。" },
  MEMORY_ENABLED: { label: "记忆", tip: "记忆引擎总闸；关掉后新记忆立即停写，已加载的库要重启才彻底卸下。" },
  MEMORY_PAGE_A: { label: "记忆页 A 版", tip: "开 = 大字概览 + 分组折叠的新记忆页；关 = 回到旧版记忆列表。改完刷新页面生效。" },
  MEMORY_CONSOLIDATE_JOB: { label: "整理后台任务", tip: "开 = 点整理后后台跑，切走再回来能接上；关 = 页面同步等结果（旧行为）。" },
  MEMORY_EXTRACT_NOISE: { label: "记忆噪声过滤", tip: "开 = 审批续跑等系统话术、命令句与问句不再写成经历；关 = 回到旧规则。MEMORY_EXTRACT=rule 不受影响。抽取器在启动时装配，改完重启服务生效。" },
  MEMORY_EXTERNAL: { label: "一生记忆库入口", tip: "开 = 记忆页底部显示外部记忆库的库边界；关 = 整块不显示。" },
  MINISTER_DISPATCH_AUTHORITY: { label: "执事派发权", tip: "开 = 执事在自己的领域内可以直派活；关 = 全部绕回总管（改动前默认关）。" },
  DEVICE_AUTO_DISPATCH: { label: "设备自动派活", tip: "targetDevice=auto 时自动选设备（主机优先）。" },
  PARTNER_WORK_RECORD: { label: "工作履历", tip: "每单结算给执事落一条履历记录（append-only 台账）。" },
  SKILLS_ADMIN: { label: "技能管理", tip: "设置 → 技能 的增删改端点。" },
  ROUTINE_SELF_SERVICE: { label: "执事自建巡逻", tip: "执事可以用 routine_manage 给自己建/停例行规则（高危档，首次要人点头）。" },
  COMPANIONS_ENABLED: { label: "执事", tip: "执事（伙伴）体系总闸。" },
  GROUPS_ENABLED: { label: "群组", tip: "群聊与值日制。" },
  CHANCELLOR_ENABLED: { label: "派活（宰相）", tip: "delegation 派活链路总闸；关掉 = 回到 8 个基础工具。" },
  DELEGATION_WAKE_ENABLED: { label: "派活完成即唤醒", tip: "后台任务到终态后，把派活的会话自动叫起来跑一轮、接住结果并向你转述。关掉 = 只写汇报，不主动开口（改动前行为）。" },
  TOPICS_ENABLED: { label: "长期课题", tip: "课题户口本 + 每周研究。" },
  // 任务中心重做回滚（2026-11-13 批 1）：关 = 回到旧三列看板（含筛选栏），刷新页面即生效。
  TASKS_REDESIGN_ENABLED: { label: "任务中心新版", tip: "开 = 等你回话 / 在跑 / 打手手风琴 / 今日回顾；关 = 回到旧三列看板。前端一次会话只问一次开关，改完刷新页面生效。" },
  // persona 记忆库接入（2026-11-09）：读 = 查一生记忆库；写 = 对话归档。ASK 路径不进界面（路径类 env），
  // 开关文案里写清前置条件，别让用户拨了没反应以为是坏了。
  PERSONA_MEMORY_ENABLED: { label: "一生记忆库（查）", tip: "主人问到很久以前的事、或要原文出处时，去个人记忆库（persona-metric）检索证据。前置：.env 里 PERSONA_MEMORY_ASK 需指向 ask.py；没配的话这个开关拨了也不上架工具。" },
  PERSONA_EXPORT_ENABLED: { label: "对话归档（送）", tip: "每轮主对话聊完后，把你和助手的原话追加进导出目录，由记忆库那边定期收走归档。默认关——开了才往外送数据。" },
  // 归档管理对齐 ZCode（2026-11-13 批A/批B）：开关与天数在 设置→会话 也有独立区，
  // 这里的条目只管通用开关卡（设置→服务）上的可读名。
  ARCHIVE_AUTO_ENABLED: { label: "自动归档", tip: "开启后，没动静的普通对话与已结束的任务专线到天数就自动归档；总管、执事/群、置顶与运行中的不动。设置→会话 里也有这一区。" },
  ARCHIVE_AUTO_DAYS: { label: "自动归档天数", tip: "没动静多少天算旧会话（1-365），默认 30。" },
  CHAT_HARD_DELETE: { label: "永久删除", tip: "归档页里的永久删除端点总闸；关掉后预检与删除都返回 400，归档/恢复不受影响。默认开。" },
  CHAT_STREAM_REVEAL: { label: "对话逐字浮现", tip: "流式回答按汉字/英文词淡入，而不是整块蹦出。关 = 退回旧的整块渲染，改完下一轮生效。系统开启「减少动态效果」时自动关闭。" },
  // 历史分页回滚（2026-11-13）：关 = 一次拉最近 200 条、没有上滑加载与日期分隔。
  CHAT_HISTORY_PAGING_ENABLED: { label: "对话历史分页", tip: "开 = 打开会话先加载最近一页，往上滑再加载更早的（按天分组、带日期分隔）；关 = 退回一次拉最近 200 条。改完重新打开会话生效。" },
};

/** 有专属区块的开关（设置→会话 的自动归档 / 上下文压缩）：通用卡片里不再重复一行。
 *  不这么做的后果是数值型开关被当成布尔拨杆渲染——它的值永远不是 "true"，拨杆恒为关。 */
const FLAG_SECTION_KEYS = new Set([
  "ARCHIVE_AUTO_ENABLED",
  "ARCHIVE_AUTO_DAYS",
  "AGENT_COMPACT_ENABLED",
  "AGENT_COMPACT_TRIGGER_MODE",
  "AGENT_COMPACT_TRIGGER_PERCENT",
  "AGENT_COMPACT_TRIGGER_K",
]);

async function loadFlagsSettings() {
  const card = document.getElementById("flags-card");
  if (!card) return;
  try {
    const response = await request("/api/v1/agent/flags", { cache: "no-store" });
    if (!response.ok) throw new Error(String(response.status));
    const data = await response.json().catch(() => ({}));
    renderFlagRows(card, Array.isArray(data.flags) ? data.flags : []);
  } catch (error) {
    if (error.message === "forbidden") return;
    card.innerHTML = `<div class="row"><div class="row-main"><div class="row-hint">读不到开关：${esc(String(error.message))}</div></div></div>`;
  }
}

function renderFlagRows(card, flags) {
  card.replaceChildren();
  if (!flags.length) {
    card.innerHTML = `<div class="row"><div class="row-main"><div class="row-hint">这台服务端没开放开关（AGENT_FLAGS_UI=false）。</div></div></div>`;
    return;
  }
  for (const flag of flags) {
    if (FLAG_SECTION_KEYS.has(flag.key)) continue;
    const meta = FLAG_LABELS[flag.key] || { label: flag.key, tip: "" };
    const hot = flag.hot !== false;
    const valueText =
      flag.value === "true" ? "开" : flag.value === "false" ? "关" : flag.value;
    const tip =
      `${meta.tip}${meta.tip ? " " : ""}当前：${valueText}` +
      `${hot ? "；改完即时生效" : "；重启服务后生效"}${flag.overridden ? "（已被界面改过，恢复默认就拨回这个位置）" : ""}`;
    // 多档开关（2026-11-09 T2）：AUTONOMY_ENABLED 有 observe 档，布尔开关表达不了，
    // 与 MEMORY_EXTRACT 同用 segmented；标签写人话，不暴露 env 原值。
    const choices = FLAG_CHOICES[flag.key];
    const control = choices
      ? `<div class="segmented" role="radiogroup" aria-label="${attr(meta.label)}" data-flag-select="${attr(flag.key)}">
           ${choices.map((c) => `<button type="button" data-value="${attr(c.value)}" aria-checked="${flag.value === c.value}">${esc(c.label)}</button>`).join("")}
         </div>`
      : switchMarkup(flag.value === "true", {
          label: meta.label,
          attrs: `data-flag-switch="${attr(flag.key)}"`,
        });
    card.insertAdjacentHTML("beforeend", rowMarkup(meta.label, tip, control));
  }
  for (const sw of card.querySelectorAll("[data-flag-switch]")) {
    sw.addEventListener("click", () => {
      void toggleFlag(sw.dataset.flagSwitch, sw.getAttribute("aria-checked") !== "true", sw);
    });
  }
  for (const seg of card.querySelectorAll("[data-flag-select]")) {
    for (const button of seg.querySelectorAll("button")) {
      button.addEventListener("click", () => {
        if (button.getAttribute("aria-checked") === "true") return;
        void toggleFlag(seg.dataset.flagSelect, button.dataset.value, null, seg);
      });
    }
    mountSegmented(seg);
  }
}

async function toggleFlag(key, value, sw, seg) {
  const setBusy = (busy) => {
    if (sw) sw.disabled = busy;
    if (seg) for (const button of seg.querySelectorAll("button")) button.disabled = busy;
  };
  setBusy(true);
  try {
    const response = await request(`/api/v1/agent/flags/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify({ value: String(value) }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      toast(data.message || `没存成：HTTP ${response.status}`);
      return;
    }
    // 布尔拨杆路径传的是 boolean，分段控件路径传的是字符串——统一归一成字符串再比，
    // 否则 String(true === "true") 恒为 false，拨杆点击后服务端已翻但 UI 永远显示旧态（实测复现）。
    if (sw) sw.setAttribute("aria-checked", String(String(value) === "true"));
    if (seg) {
      for (const button of seg.querySelectorAll("button")) {
        button.setAttribute("aria-checked", String(button.dataset.value === String(value)));
      }
      syncSegmented(seg);
    }
    // 对话框的逐字浮现开关下一轮要立刻看到变化，不能等刷新：同步内存投影 + 缓存行。
    if (key === "CHAT_STREAM_REVEAL") state.chatRevealFlag = String(value) !== "false";
    // 自动归档拨杆同步进快照：下次进「会话」子页直接按它描，不再走一遍回填动画。
    if (key === "ARCHIVE_AUTO_ENABLED") archiveAutoSnapshot.enabled = String(value) === "true";
    // 历史分页同理：下一次 openChat 立刻按新开关走（当前屏幕不重排，避免翻页中被打断）。
    if (key === "CHAT_HISTORY_PAGING_ENABLED") state.chatPagingFlag = String(value) !== "false";
    if (state.flagsCache instanceof Map) {
      const row = state.flagsCache.get(key);
      state.flagsCache.set(key, { ...(row || { key }), value: String(value), hot: data.hot !== false });
    }
    toast(data.hot ? "已保存，即时生效" : "已保存，重启服务后生效");
  } catch (error) {
    if (error.message !== "forbidden") toast(`没存成：${error.message}`);
  } finally {
    setBusy(false);
  }
}

/* ── 自动归档设置区（2026-11-13 对齐 ZCode §3）──────────
   设置→会话 独立区块：开关 ARCHIVE_AUTO_ENABLED + 天数 ARCHIVE_AUTO_DAYS（1-365）。
   读 GET /agent/flags 回填，改动 PUT /agent/flags/:key。两个键还没进服务端白名单
   （批A 未落地）时按缺省展示，保存会被 404 拒——toast 里看得到原因，不算静默失败。 */

const AUTO_ARCHIVE_DEFAULTS = { ARCHIVE_AUTO_ENABLED: "false", ARCHIVE_AUTO_DAYS: "30" };

/** 本页面进程内最后一次从服务端回读到的档位：进页先按它描，别等请求回来再翻一次。
 *  设置页每次进子页都重建 DOM，所以 `switchMarkup(false)` 那一版默认态只是占位；
 *  没有这份快照的话，从别的子页切回来时开关会"关 → 滑到开"走一遍过渡，看着像自己又开了一次。
 *  服务端仍是唯一真值：回读到不同的值就地纠正，纠正本身不带过渡（见 setSwitchChecked）。 */
const archiveAutoSnapshot = { enabled: null, days: null };

/** 把开关与天数画成同一份值（程序化回填：一律不滑）。 */
function paintArchiveAuto(switchEl, daysInput, enabled, daysRaw) {
  let days = Math.round(Number(daysRaw));
  if (!Number.isFinite(days) || days <= 0) days = 30;
  days = Math.min(365, Math.max(1, days));
  setSwitchChecked(switchEl, enabled === true || enabled === "true");
  daysInput.value = String(days);
  daysInput.defaultValue = String(days);
  syncArchiveAutoTip(days);
  archiveAutoSnapshot.enabled = enabled === true || enabled === "true";
  archiveAutoSnapshot.days = days;
}

/** 标签悬停文案（解释文字不常驻）：天数变化要跟着改 N。 */
function archiveAutoTip(days) {
  return `开启后，${days} 天没动静的普通对话与已结束的任务专线自动归档；总管、执事/群、置顶与运行中的不动。`;
}

/** 把天数文案挂到「自动归档」那一行的标签上（rowMarkup 生成的 data-tip 位）。 */
function syncArchiveAutoTip(days) {
  const label = document
    .querySelector("[data-archive-auto-switch]")
    ?.closest(".row")
    ?.querySelector(".row-label");
  label?.setAttribute("data-tip", archiveAutoTip(days));
}

async function loadAutoArchiveSettings() {
  const switchEl = document.querySelector("[data-archive-auto-switch]");
  const daysInput = document.getElementById("archive-auto-days");
  const hint = document.getElementById("archive-auto-hint");
  const hintWrap = document.getElementById("archive-auto-hint-wrap");
  if (!(switchEl instanceof HTMLElement) || !(daysInput instanceof HTMLInputElement)) return;
  const hadSnapshot = archiveAutoSnapshot.enabled !== null;
  const fallbackText = hadSnapshot ? "先按上次读到的值展示" : "先按默认展示";
  // 同一页面进程里再次进这一页：先按上次回读到的值描好，请求回来只做纠正。
  // 这一步必须早于 await——晚一步就是让"关"那版占位态先上屏、再滑成"开"。
  if (hadSnapshot) {
    paintArchiveAuto(switchEl, daysInput, archiveAutoSnapshot.enabled, archiveAutoSnapshot.days);
  }
  const values = { ...AUTO_ARCHIVE_DEFAULTS };
  let known = false;
  try {
    const response = await request("/api/v1/agent/flags", { cache: "no-store" });
    if (response.ok) {
      const data = await response.json().catch(() => ({}));
      known = true;
      for (const flag of Array.isArray(data.flags) ? data.flags : []) {
        if (flag?.key === "ARCHIVE_AUTO_ENABLED" || flag?.key === "ARCHIVE_AUTO_DAYS") {
          values[flag.key] = String(flag.value || AUTO_ARCHIVE_DEFAULTS[flag.key]);
        }
      }
    } else if (hint) {
      hint.textContent = `读不到开关（HTTP ${response.status}），${fallbackText}。`;
    }
  } catch (error) {
    if (error.message === "forbidden") return;
    if (hint) hint.textContent = `读不到开关，${fallbackText}：${error.message}`;
  }
  // 提示行只装状态/错误：没话可说就整块（含分隔线）不占位
  if (hintWrap) hintWrap.hidden = !hint?.textContent;
  if (known) {
    paintArchiveAuto(switchEl, daysInput, values.ARCHIVE_AUTO_ENABLED === "true", values.ARCHIVE_AUTO_DAYS);
  } else if (!hadSnapshot) {
    // 从来没读到过：按缺省展示，别让两个控件空着
    paintArchiveAuto(switchEl, daysInput, false, AUTO_ARCHIVE_DEFAULTS.ARCHIVE_AUTO_DAYS);
  }
  // 读过就不回退：读失败时把已知的"开"改回"关"，比停在旧值更糟
}

async function saveAutoArchiveDays(input) {
  const previous = input.defaultValue || "30";
  let days = Math.round(Number(input.value));
  if (!Number.isFinite(days) || days <= 0) days = Number(previous) || 30;
  days = Math.min(365, Math.max(1, days));
  input.value = String(days);
  syncArchiveAutoTip(days);
  try {
    const response = await request("/api/v1/agent/flags/ARCHIVE_AUTO_DAYS", {
      method: "PUT",
      body: JSON.stringify({ value: String(days) }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      toast(data.message || `没存成：HTTP ${response.status}`);
      input.value = previous;
      syncArchiveAutoTip(Number(previous) || 30);
      return;
    }
    input.defaultValue = String(days);
    archiveAutoSnapshot.days = days;
    toast(data.hot === false ? "已保存，重启服务后生效" : "已保存，即时生效");
  } catch (error) {
    if (error.message !== "forbidden") toast(`没存成：${error.message}`);
    input.value = previous;
    syncArchiveAutoTip(Number(previous) || 30);
  }
}

export { AUTO_ARCHIVE_DEFAULTS, FLAG_CHOICES, FLAG_LABELS, archiveAutoTip, loadAutoArchiveSettings, loadFlagsSettings, renderFlagRows, saveAutoArchiveDays, syncArchiveAutoTip, toggleFlag };
