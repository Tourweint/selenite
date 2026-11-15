/**
 * 插件页（行为开关，原「高级开关」）+ 自动归档设置区
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 2026-11-15：通用开关卡改成「工具活动 + 分组的全部开关」，名字从「高级开关」改成「行为开关」。
 * 2026-11-16：整页从「设置 → 服务」拆出，独立成「设置 → 插件」——这些开关就是做出来的功能，
 * 按插件卡片墙摆；服务页只留服务自身状态。本文件仍是这一页的唯一渲染入口。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { attr, esc } from "./markdown.js";
import { request } from "./net.js";
import { mountSegmented, setSwitchChecked, switchMarkup, syncSegmented } from "./settings-atoms.js";
import { state } from "./state.js";
import { toast } from "./ui-atoms.js";

/* ── 高级开关（2026-11-09）：服务端 env 行为开关搬进界面 ──────────
 * 数据面：GET/PUT /api/v1/agent/flags（服务端 .data/agent-flags.json 覆盖 env，见 flags.ts）。
 * hot=true 改完即时生效；hot=false（路由挂载/工具注册类，启动时冻结）重启后生效——
 * toast 与悬停提示都写明，不装即时。密钥/路径/令牌类 env 不进这张表（密钥纪律）。 */

/** 多档开关的选项（键不在表里 = 布尔开关）。value 是写进 env 的真值，label 给人看。 */
const FLAG_CHOICES = {
  MEMORY_EXTRACT: [
    { value: "auto", label: "自动" },
    { value: "llm", label: "模型" },
    { value: "rule", label: "规则" },
  ],
  AUTONOMY_ENABLED: [
    { value: "false", label: "关" },
    { value: "observe", label: "只观察" },
    { value: "true", label: "开" },
  ],
};

/**
 * 开关的人话说明（2026-11-15 用户口径：看不懂是干啥的、要中文、要写详细）。
 * `summary` 常驻在行内（不再只塞悬停）：写清「它是什么 / 开与关差在哪 / 默认是什么 / 何时生效」。
 * 键按 FLAG_GROUPS 分组渲染；表里没有的键按原 key 兜底，不允许再出现只有英文的裸行。
 */
const FLAG_LABELS = {
  // ── 对话基本能力 ──
  AGENT_ATTACHMENTS: { label: "附件", summary: "对话里能发图片附件；关掉后分段发送会被拒。默认开，即时生效。" },
  AGENT_EDIT_RESEND: { label: "编辑重发", summary: "自己发过的消息可以改完再重发；关掉就只剩重新发一条。默认开，即时生效。" },
  CURRENT_PROJECT: { label: "当前项目", summary: "派活按当前项目归属走；关掉 = 只剩主工作区，不再区分项目。默认开，即时生效。" },
  AGENT_ASK_USER: { label: "结构化提问", summary: "助手拿不准时能直接弹选项 / 表单让你点，而不是自己猜；关掉 = 不再提供这个工具。默认开，重启服务后生效。" },

  // ── 记忆 ──
  MEMORY_ENABLED: { label: "记忆总闸", summary: "记忆引擎的总开关。关掉后新记忆立即停写；已经加载进内存的库要重启服务才彻底卸下（重启前召回 / 整理仍可用）。反过来，启动时关着再打开也要重启才真正上架。默认开。" },
  MEMORY_EXTRACT: { label: "记忆提取方式", summary: "每一轮聊完，怎么从对话里抓「经历」。自动 = 先按规则抓、拿不准才叫模型（默认）；模型 = 每句都让模型判断，准但费额度；规则 = 只按句长 / 关键词抓，免费但粗。改完下一轮生效。" },
  MEMORY_EXTRACT_NOISE: { label: "记忆噪声过滤", summary: "审批续跑等系统话术、命令行和问句不再被写成「经历」。关 = 回到旧规则（每句 ≥6 字都记）。默认开，重启服务后生效。" },
  MEMORY_CONSOLIDATE_JOB: { label: "整理放后台", summary: "点「整理」后放后台跑，切走再回来还能接上进度；关 = 页面同步等结果（旧行为）。默认开，即时生效。" },
  MEMORY_PAGE_A: { label: "记忆页新版", summary: "记忆页用大字概览 + 分组折叠；关 = 回到旧版长列表。默认开，改完刷新页面生效。" },
  MEMORY_EXTERNAL: { label: "外部记忆库入口", summary: "记忆页底部显示外部记忆库的库边界；关掉整块不显示。默认开，即时生效。" },
  MEMORY_INJECT_DEDUPE: { label: "记忆召回去重", summary: "每轮挑出来的记忆先合并「同一件事的多种说法」，只注入一条（保留分数最高的）；关 = 召回几条就注入几条。只影响本轮注入，不改记忆库。默认开，下一轮生效。" },

  // ── 一生记忆库（对外一进一出）──
  PERSONA_MEMORY_ENABLED: { label: "一生记忆库（查）", summary: "问到很久以前的事、或要原文出处时，去个人记忆库（persona-metric）检索证据。前置条件：.env 里 PERSONA_MEMORY_ASK 要指向 ask.py；没配的话这个开关拨了也不会挂上工具。默认开。" },
  PERSONA_EXPORT_ENABLED: { label: "对话归档（送）", summary: "每轮主对话聊完，把你和助手的原话追加到导出目录，由记忆库那边定期收走归档。默认关——这是唯一会把数据往本机之外送的开关，要用才开。" },

  // ── 自主与派活 ──
  AUTONOMY_ENABLED: { label: "自主轮", summary: "定时任务 / 事件唤醒、没人盯着跑的那一轮。关 = 完全不动；只观察 = 照常判定但只记账、不真的做；开 = 真起轮，卡住 / 等你批 / 出错会提醒你，写文件 / 跑命令 / 派活一律先问你。默认开。" },
  CHANCELLOR_ENABLED: { label: "派活（宰相）", summary: "派活链路的总闸；关掉 = 回到 8 个基础工具，不能把活分出去。默认开，重启服务后生效。" },
  DELEGATION_WAKE_ENABLED: { label: "派活完成即唤醒", summary: "后台任务到终态后，把派活的会话自动叫起来跑一轮、接住结果并向你转述。关 = 只写汇报、不主动开口（改动前的旧行为）。默认开。" },
  MINISTER_DISPATCH_AUTHORITY: { label: "执事派发权", summary: "执事在自己的领域内可以直派活；关 = 所有活都绕回总管。默认开（2026-11-15 用户口径），改完即时生效。" },
  ROUTINE_SELF_SERVICE: { label: "执事自建巡逻", summary: "执事能给自己建 / 停例行规则（高危档，第一次要你点头）。默认开，重启服务后生效。" },
  DEVICE_AUTO_DISPATCH: { label: "设备自动派活", summary: "派活时设备选「自动」就替你挑一台（主机优先）。默认开，即时生效。" },
  COMPANIONS_ENABLED: { label: "执事体系", summary: "执事（伙伴）体系总闸：关掉后不再有执事列表、执事对话与执事派活。默认开，重启服务后生效。" },
  GROUPS_ENABLED: { label: "群组", summary: "群聊与值日制的总闸。默认开，重启服务后生效。" },

  // ── 技能与课题 ──
  SKILLS_ADMIN: { label: "技能管理", summary: "设置 → 技能 里增删改技能手册的端点；关掉只能看不能改。默认开，重启服务后生效。" },
  SKILLS_INDEX_CLIP: { label: "技能索引截断", summary: "技能索引每行只显示摘要前 120 字（省上下文，实测能省一半）；关 = 显示完整摘要。只影响索引，真调用时读到的仍是完整手册。默认开，只影响新开的会话。" },
  PARTNER_TEMPLATES: { label: "执事招聘模板", summary: "招聘墙和新建执事弹窗里出现模板条，点一下按模板建人设。关 = 回到旧「新建执事」按钮。默认开，即时生效。" },
  TOPICS_ENABLED: { label: "长期课题", summary: "课题户口本 + 每周自动研究：值得长期跟的问题会留档并定期推进。默认开，重启服务后生效。" },
  PARTNER_WORK_RECORD: { label: "工作履历", summary: "每单结算给执事落一条履历记录（只增不改的台账），用来判断谁靠谱。默认开，即时生效。" },

  // ── 任务与界面 ──
  TASKS_REDESIGN_ENABLED: { label: "任务中心新版", summary: "任务中心用「等你回话 / 在跑 / 打手手风琴 / 今日回顾」的新版；关 = 回到旧三列看板。默认开，改完刷新页面生效。" },
  SIDEBAR_TASK_GROUPS: { label: "侧栏按创建者分组", summary: "侧栏对话按「我 / 各个打手」分开归类；关 = 回到旧版一整条平铺列表。默认开，改完刷新页面生效。" },
  CHAT_STREAM_REVEAL: { label: "对话逐字浮现", summary: "流式回答按字 / 词淡入，而不是整块蹦出；关 = 退回旧的整块渲染。系统开了「减少动态效果」时会自动关。默认开，下一轮生效。" },
  CHAT_HISTORY_PAGING_ENABLED: { label: "对话历史分页", summary: "打开会话先加载最近一页，往上滑再加载更早的（按天分组、带日期分隔）；关 = 一次拉最近 200 条。默认开，重新打开会话生效。" },
  CHAT_HARD_DELETE: { label: "永久删除", summary: "归档页里「永久删除」的总闸；关掉后预检和删除都返回 400，归档 / 恢复不受影响。默认开，即时生效。" },
  TOOL_PROJECTION: { label: "工具结果整理", summary: "命令行（bash / PowerShell）的结果会被读懂一点：grep 没匹配不算失败、超时统一标记、大输出提示落盘路径。总闸，关 = 所有会话一律原样透传（打手、执事、显式开过的执事都关，回滚用）。默认开，即时生效。默认只对打手生效：执事与总管默认不整理，需要时在执事个人页开。" },
  TOOL_PROJECTION_WORKER: { label: "打手工具结果整理", summary: "打手的命令行结果默认整理成上面那样（只管子任务 / 派单执行者这类本机内核打手）。执事与总管默认不整理——这是「默认只管打手」的落点，执事要用就在自己的个人页显式开。外接 CLI 打手（CodeBuddy / Qoder / Claude Code / Codex / OpenCode）跑自己的工具、不经过这层，不受开关影响。默认开，即时生效。" },
  PARTNER_MEMORY_RECALL: { label: "记忆召回（总闸）", summary: "每轮对话自动带的记忆（经历 / 事实 / 偏好 / 人和物 + 挂载项目的记忆）。这是总闸：关 = 所有会话都不再自动带，只留 recall 工具主动查。它和「记忆」分组里那些不一样——那些管的是记忆库本身（怎么记、怎么整理），这个只管「每轮自动注入」这一半。每位执事/总管的人设页里还有自己的子开关（按相关度召回），父子都开才带。默认开，即时生效。" },

  // 归档与压缩：数值型 / 有专属卡，通用卡里不再重复一行（见 FLAG_SECTION_KEYS）。
  ARCHIVE_AUTO_ENABLED: { label: "自动归档", summary: "没动静的普通对话与已结束的任务专线到天数自动归档；总管、执事 / 群、置顶与运行中的不动。设置 → 会话 有专属卡。默认开（2026-11-15 用户口径）。" },
  ARCHIVE_AUTO_DAYS: { label: "自动归档天数", summary: "多少天没动静算旧会话（1–365），默认 30。" },
};

/** 分组（2026-11-15）：一屏里按「管什么」分开，别让人从上到下猜 29 个开关的关系。 */
const FLAG_GROUPS = [
  {
    id: "chat",
    title: "对话基本能力",
    desc: "对话里能做什么：发图、改话、按项目走、拿不准时让你点选。",
    keys: ["AGENT_ATTACHMENTS", "AGENT_EDIT_RESEND", "CURRENT_PROJECT", "AGENT_ASK_USER"],
  },
  {
    id: "memory",
    title: "记忆",
    desc: "它怎么从对话里记事、怎么整理、记忆页长什么样。",
    keys: [
      "MEMORY_ENABLED",
      "MEMORY_EXTRACT",
      "MEMORY_EXTRACT_NOISE",
      "MEMORY_CONSOLIDATE_JOB",
      "MEMORY_PAGE_A",
      "MEMORY_EXTERNAL",
      "MEMORY_INJECT_DEDUPE",
      "PARTNER_MEMORY_RECALL",
    ],
  },
  {
    id: "persona",
    title: "一生记忆库（对外）",
    desc: "本机和外部记忆库之间的一进一出。往外送数据的那一项默认关。",
    keys: ["PERSONA_MEMORY_ENABLED", "PERSONA_EXPORT_ENABLED"],
  },
  {
    id: "autonomy",
    title: "自主与派活",
    desc: "没人盯着时它自己能跑多远、能不能把活派给别人。",
    keys: [
      "AUTONOMY_ENABLED",
      "CHANCELLOR_ENABLED",
      "DELEGATION_WAKE_ENABLED",
      "MINISTER_DISPATCH_AUTHORITY",
      "ROUTINE_SELF_SERVICE",
      "DEVICE_AUTO_DISPATCH",
      "COMPANIONS_ENABLED",
      "GROUPS_ENABLED",
    ],
  },
  {
    id: "skills",
    title: "技能与课题",
    desc: "给 AI 的操作手册、执事招聘模板、长期跟进的问题与履历。",
    keys: ["SKILLS_ADMIN", "SKILLS_INDEX_CLIP", "PARTNER_TEMPLATES", "TOPICS_ENABLED", "PARTNER_WORK_RECORD"],
  },
  {
    id: "ui",
    title: "任务与界面",
    desc: "任务中心、对话观感、历史翻页、永久删除与工具结果，都是「看起来 / 用起来」的开关。",
    keys: [
      "TASKS_REDESIGN_ENABLED",
      "SIDEBAR_TASK_GROUPS",
      "CHAT_STREAM_REVEAL",
      "CHAT_HISTORY_PAGING_ENABLED",
      "CHAT_HARD_DELETE",
      "TOOL_PROJECTION",
      "TOOL_PROJECTION_WORKER",
    ],
  },
];

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
    card.innerHTML = `<div class="card flag-empty"><p class="set-hint">读不到开关：${esc(String(error.message))}</p></div>`;
  }
}

/** 把 env 值翻成人话（布尔只有开/关，多档走 FLAG_CHOICES 的中文 label）。 */
function flagValueText(key, value) {
  const choices = FLAG_CHOICES[key];
  if (choices) return choices.find((choice) => choice.value === value)?.label || value;
  if (value === "true") return "开";
  if (value === "false") return "关";
  return value || "未设";
}

/** 卡片徽标只标「例外」：默认关、待重启、已改。默认开是多数派，页首已写总数。
 *  「待重启」只在 hot:false 的改动还没被进程装载时出现（服务端 pendingRestart）；重启后自动消失，
 *  不再像旧版那样对所有 hot:false 开关常驻「需重启」——那个字与"这次是否生效"无关。
 *  「已改」看当前值是否真的和默认不同，不看文件里有没有历史覆盖行（覆盖行可能只是测试留下的）。 */
function flagTags(flag) {
  const tags = [];
  if (flag.defaultValue === "false") tags.push(`<span class="flag-tag">默认${esc(flagValueText(flag.key, flag.defaultValue))}</span>`);
  if (flag.pendingRestart) tags.push('<span class="flag-tag warn">待重启</span>');
  else if (flag.value !== flag.defaultValue) tags.push('<span class="flag-tag accent">已改</span>');
  return tags.length ? `<span class="flag-tags">${tags.join("")}</span>` : "";
}

/** 卡片上一句话简介：取 summary 的第一句；完整解释仍在标题的 data-tip 里。 */
function flagBrief(summary) {
  const first = String(summary || "").split("。")[0].trim();
  return first;
}

/** 一张开关卡（2026-11-15 二版）：照「插件中心」的卡片墙排——名字 + 徽标 + 两行简介 + 控件；
 *  完整说明收进名字的 data-tip（和设置页其它标签同一套小黑块），不再把长段正文铺在卡面上。 */
function flagCardMarkup(flag) {
  const meta = FLAG_LABELS[flag.key] || { label: flag.key, summary: "" };
  // 多档开关（2026-11-09 T2）：AUTONOMY_ENABLED 有 observe 档，布尔开关表达不了，
  // 与 MEMORY_EXTRACT 同用 segmented；标签写人话，不暴露 env 原值。
  const choices = FLAG_CHOICES[flag.key];
  const control = choices
    ? `<div class="segmented" role="radiogroup" aria-label="${attr(meta.label)}" data-flag-select="${attr(flag.key)}">
         ${choices.map((choice) => `<button type="button" data-value="${attr(choice.value)}" aria-checked="${flag.value === choice.value}">${esc(choice.label)}</button>`).join("")}
       </div>`
    : switchMarkup(flag.value === "true", {
        label: meta.label,
        attrs: `data-flag-switch="${attr(flag.key)}"`,
      });
  return `<div class="card flag-item">
    <div class="flag-item-main" data-tip="${attr(meta.summary)}">
      <div class="flag-item-head">
        <div class="flag-item-name">${esc(meta.label)}</div>
        ${flagTags(flag)}
      </div>
      <div class="flag-item-brief">${esc(flagBrief(meta.summary))}</div>
    </div>
    <div class="flag-item-foot">${control}</div>
  </div>`;
}

function renderFlagRows(card, flags) {
  card.replaceChildren();
  if (!flags.length) {
    card.innerHTML = `<div class="card flag-empty"><p class="set-hint">这台服务端没开放开关（AGENT_FLAGS_UI=false）。</p></div>`;
    return;
  }
  const visible = flags.filter((flag) => !FLAG_SECTION_KEYS.has(flag.key));
  const byKey = new Map(visible.map((flag) => [flag.key, flag]));
  const defaultOff = visible.filter((flag) => flag.defaultValue === "false").length;
  const currentOff = visible.filter((flag) => flag.value === "false").length;
  // 页首只留一行计数，不铺解释性长文：这一页是干什么的，名字和卡片简介已经说清了。
  card.insertAdjacentHTML(
    "beforeend",
    `<div class="flag-intro">
      <span class="flag-intro-count">${visible.length} 个插件 · ${visible.length - defaultOff} 默认开 / ${defaultOff} 默认关 · 当前 ${visible.length - currentOff} 开 / ${currentOff} 关</span>
    </div>`,
  );
  // 工具活动不再单列一行（2026-11-15 用户口径：常开、平时不会去动它，条目可以删）：
  // 它确实是常开的复核凭据，但不是一个可配置项；压到卡尾一句话，既不占一行，也不丢这个事实。
  const grouped = new Set(FLAG_GROUPS.flatMap((group) => group.keys));
  const paintGroup = (title, desc, items) => {
    const section = document.createElement("section");
    section.className = "flag-section";
    section.innerHTML = `<div class="flag-group-head">
        <div class="flag-group-title" data-tip="${attr(desc)}">${esc(title)}</div>
        <div class="flag-group-count">${items.length}</div>
      </div>
      <div class="flag-grid"></div>`;
    const grid = section.querySelector(".flag-grid");
    for (const flag of items) grid.insertAdjacentHTML("beforeend", flagCardMarkup(flag));
    card.append(section);
  };
  for (const group of FLAG_GROUPS) {
    const items = group.keys.map((key) => byKey.get(key)).filter(Boolean);
    if (items.length) paintGroup(group.title, group.desc, items);
  }
  // 兜底分组：flags.ts 以后新加的键哪怕还没归组，也必须出现在界面上（不能变成「拨不到」）。
  const rest = visible.filter((flag) => !grouped.has(flag.key));
  if (rest.length) paintGroup("其他", "还没归组的开关；先按原样列出来，等下次整理。", rest);
  card.insertAdjacentHTML(
    "beforeend",
    `<div class="flag-foot"><strong>工具活动常开</strong>：对话里始终显示读了哪个文件、跑了什么命令、花了多久；不提供关闭，用来事后复核它到底动过什么。<br>密钥 / 路径 / 令牌类 env 刻意不上面板——那些是部署配置，不是日常开关；要改请走 .env。</div>`,
  );
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

const AUTO_ARCHIVE_DEFAULTS = { ARCHIVE_AUTO_ENABLED: "true", ARCHIVE_AUTO_DAYS: "30" };

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
    // 从来没读到过：按缺省展示，别让两个控件空着（2026-11-15 起自动归档缺省开）
    paintArchiveAuto(switchEl, daysInput, AUTO_ARCHIVE_DEFAULTS.ARCHIVE_AUTO_ENABLED === "true", AUTO_ARCHIVE_DEFAULTS.ARCHIVE_AUTO_DAYS);
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
