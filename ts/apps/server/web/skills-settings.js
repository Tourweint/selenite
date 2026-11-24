/**
 * 技能设置：来源标签与分类建议
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { el } from "./dom.js";
import { esc } from "./markdown.js";
import { request } from "./net.js";
import { openChiefChat } from "./partners-status.js";
import { resize } from "./plus-menu.js";
import { setModalHint } from "./project-modal.js";
import { renderSkillList } from "./skills-list.js";
import { renderSkillLocations } from "./skills-locations.js";
import { closeModal, openModal, toast } from "./ui-atoms.js";

/* ── 技能设置（2026-11-08 扫尾批 9-S）──────────────
 * 技能 = 给 AI 的操作手册（`skills/<name>.md`，第 1 行 = 索引用摘要）。
 * 目录解析在服务端（`resolveSkillsDir`）：AGENT_SKILLS_DIR / 用户目录 → 自加位置（2026-11-23）
 * → `.agents/skills`（只读）→ 应用目录兜底。
 * 这里只说"人对文件做了什么"：列表 / 点开编辑 / 新建 / 删除 / 管理位置。
 * 刻意不做启停位：删除即停；增删只影响下一个会话（D5 既有取舍，文案如实写）。 */

const SKILL_ORIGIN_LABEL = {
  env: "AGENT_SKILLS_DIR",
  user: "主目录",
  custom: "自加位置",
  agents: ".agents/skills",
  app: "内置目录",
};
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-_]{0,63}$/;

/** 「对已在跑的会话不生效，下一个会话开始使用」——三处入口共用同一句，避免各自改口径 */
const SKILL_NEXT_TURN_HINT = "对已在跑的会话不生效，下一个会话开始使用。";

/* ── 技能分类建议（2026-11-10 批 30）──
 * Agent 评估 + 人确认：三栏（keep=建议开启 / scene=按场景 / skip=建议不开）
 * + 预计使用频率（技能是手册不运行，频率只做"值不值得开"的参考）。
 * 建议快照在服务端 .data/skills-advice.json；采纳才写启停位。 */

const SKILL_ADVICE_BUCKET_LABEL = { keep: "建议开启", scene: "按场景", skip: "建议不开" };
const SKILL_ADVICE_FREQ_LABEL = {
  daily: "每天会用到",
  weekly: "每周用上",
  monthly: "每月一次上下",
  rare: "几乎用不上",
};
const SKILL_ADVICE_FILTERS = [
  { key: "all", label: "全部" },
  { key: "keep", label: "建议开启" },
  { key: "scene", label: "按场景" },
  { key: "skip", label: "建议不开" },
  { key: "none", label: "未评估" },
];

/** 会话级状态：当前建议快照 + 筛选/排序位 + 最近一次列表（供批量确认与重渲染）
 *  dirs / extraDirs：技能库位置（2026-11-23），新建 / 编辑时选写目标就靠它。 */
const skillAdvice = {
  view: null,
  filter: "all",
  sort: "default",
  items: [],
  dir: "",
  dirs: [],
  extraDirs: true,
};

/** 上一次成功读到的技能列表：设置页来回切时先用它渲染，后台再拉最新。
 *  只放进程内，不落 localStorage：技能会在磁盘上被别人改，缓存不该跨重启变成真相。 */
const skillCache = { data: null, advice: null, signature: "" };

function skillPageSignature(data, advice) {
  try {
    return JSON.stringify([
      String(data?.dir || ""),
      String(data?.origin || ""),
      data?.extraDirs !== false,
      Array.isArray(data?.dirs) ? data.dirs : [],
      Array.isArray(data?.items) ? data.items : [],
      advice || null,
    ]);
  } catch {
    return "";
  }
}

/** 页头位置卡（2026-11-23 多位置）：数据每次刷新都重画；计数位只留刷新失败提示（正常态不报数） */
function applySkillPageMeta(data, locations, countEl) {
  skillAdvice.dir = String(data.dir || "");
  skillAdvice.dirs = Array.isArray(data.dirs) ? data.dirs : [];
  skillAdvice.extraDirs = data.extraDirs !== false;
  if (countEl) {
    countEl.textContent = "";
    countEl.hidden = true;
    countEl.classList.remove("is-error");
  }
  renderSkillLocations(locations, data, { reload: loadSkills });
}

/** 有缓存就先画：页面不再从「读取中…」开始闪一下；数据回来只在真变了才重画。 */
function paintSkillCache(box, locations, countEl) {
  if (!box || !skillCache.data) return false;
  applySkillPageMeta(skillCache.data, locations, countEl);
  skillAdvice.view = skillCache.advice;
  renderSkillList(box, skillCache.data.items);
  return true;
}

/** 排序选项（2026-11-13 二轮）：分类之外给两种排序；没有建议快照时「Agent 建议」不出现 */
const SKILL_SORT_OPTIONS = [
  { key: "default", label: "默认排序" },
  { key: "usage", label: "使用频率" },
  { key: "advice", label: "Agent 建议" },
];
const SKILL_FREQ_RANK = { daily: 0, weekly: 1, monthly: 2, rare: 3 };

async function fetchSkillAdvice() {
  try {
    const response = await request("/api/v1/agent/skills/advice", { cache: "no-store" });
    if (!response.ok) return null; // 404 = SKILL_ADVICE=false，整个功能不出现
    const data = await response.json().catch(() => ({}));
    return data.ok ? data : null;
  } catch (error) {
    if (error.message !== "forbidden") return null;
    return null;
  }
}

/**
 * 评估入口（批 30 修订）：不再后端盲跑模型——那不知道会撞上哪个模型，万一能力低但
 * 计费高就亏了。改为：取服务端拼好的评估提示词 → 跳到总管对话（最新一条或新开）→
 * 提示词预填进输入框。主人看过、点发送，总管在主人选的模型上把活干了（结果经
 * save_skill_advice 工具写回快照），再回技能页分栏采纳。
 */
async function runSkillAdvice() {
  const run = document.getElementById("skill-advice-run");
  if (!run || run.disabled) return;
  run.disabled = true;
  try {
    const response = await request("/api/v1/agent/skills/advice", { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.prompt) {
      toast(data.message || "拿不到评估提示词（技能库可能是空的）");
      return;
    }
    if (data.ok) skillAdvice.view = data;
    openChiefChat();
    el.input.value = data.prompt;
    resize();
    el.input.focus();
    toast("评估提示词已填进总管输入框——看过没问题就发送");
  } catch (error) {
    if (error.message !== "forbidden") toast(`没拿到评估提示词：${error.message}`);
  } finally {
    run.disabled = false;
  }
}

/** Agent 建议的对齐计划：建议开启的打开、建议不开的关闭；按场景 / 未评估 / 待复核不动 */
function skillAdvicePlan(items) {
  const view = skillAdvice.view;
  if (!view?.generatedAt) return null;
  const entries = Object.entries(view.items || {});
  const exists = new Set(items.map((item) => item.name));
  const enabledOf = (name) => items.find((item) => item.name === name)?.enabled === true;
  const keep = entries.filter(([, entry]) => entry?.bucket === "keep");
  // 待复核 = 建议开启 + 几乎用不上：自相矛盾，不自动动它，让人自己看
  const warn = keep.filter(([, entry]) => entry.frequency === "rare").map(([name]) => name);
  const keepNames = keep
    .map(([name]) => name)
    .filter((name) => !warn.includes(name) && exists.has(name));
  const skipNames = entries
    .filter(([, entry]) => entry?.bucket === "skip")
    .map(([name]) => name)
    .filter((name) => exists.has(name));
  return {
    generatedAt: view.generatedAt,
    model: view.model || "",
    keep: keepNames.length,
    warn: warn.length,
    skip: skipNames.length,
    toOn: keepNames.filter((name) => !enabledOf(name)),
    toOff: skipNames.filter((name) => enabledOf(name)),
  };
}

/** 按 Agent 建议调整（批量、两个方向）：先确认再落盘；已对齐时只回一句提示 */
function applySkillAdvice() {
  const plan = skillAdvicePlan(skillAdvice.items);
  if (!plan) {
    toast("还没有 Agent 建议，先点「让 Agent 评估」");
    return;
  }
  const total = plan.toOn.length + plan.toOff.length;
  if (!total) {
    toast("已经按 Agent 建议对齐了，没有要改的");
    return;
  }
  openModal("按 Agent 建议调整", (body) => {
    const parts = [];
    if (plan.toOn.length) parts.push(`开启 <b>${plan.toOn.length}</b> 个（建议开启但没开）`);
    if (plan.toOff.length) parts.push(`关闭 <b>${plan.toOff.length}</b> 个（建议不开却开着）`);
    body.innerHTML = `
      <p class="modal-desc">将${parts.join("，")}。</p>
      <p class="modal-hint" id="sk-apply-hint">按场景 / 未评估 / 待复核的技能不动；索引随下一个会话刷新，已在跑的会话不受影响。</p>
      <div class="modal-actions">
        <button class="ghost" type="button" data-modal-cancel>取消</button>
        <button class="modal-primary" type="button" id="sk-apply-go">按建议调整</button>
      </div>`;
    const hint = body.querySelector("#sk-apply-hint");
    const go = body.querySelector("#sk-apply-go");
    body.querySelector("[data-modal-cancel]")?.addEventListener("click", closeModal);
    // 内置技能没有启停位：请求前过滤掉 core 名字（服务端 advice 端点也会跳，双保险）。
    const isCore = (name) =>
      skillAdvice.items.some((item) => item.name === name && item.core === true);
    const actions = [
      ...plan.toOn.filter((name) => !isCore(name)).map((name) => ({ name, enabled: true })),
      ...plan.toOff.filter((name) => !isCore(name)).map((name) => ({ name, enabled: false })),
    ];
    if (!actions.length) {
      closeModal();
      toast("这些技能都是系统内置的，始终可用，不用调整");
      return;
    }
    go.addEventListener("click", async () => {
      if (go.disabled) return;
      go.disabled = true;
      setModalHint(hint, "调整中…", false);
      try {
        const response = await request("/api/v1/agent/skills/advice", {
          method: "PUT",
          body: JSON.stringify({ actions }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          setModalHint(hint, data.message || `没存成：HTTP ${response.status}`);
          return;
        }
        closeModal();
        toast(`已按建议调整：开启 ${plan.toOn.length} 个、关闭 ${plan.toOff.length} 个`);
        void loadSkills();
      } catch (error) {
        if (error.message === "forbidden") { closeModal(); return; }
        setModalHint(hint, `没存成：${error.message}`);
      } finally {
        go.disabled = false;
      }
    });
  });
}

function skillSizeText(size) {
  const bytes = Number(size) || 0;
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function skillWhenText(iso) {
  const at = Date.parse(String(iso || ""));
  return Number.isFinite(at) ? new Date(at).toLocaleString("zh-CN") : "—";
}

/** 上次使用距今的说法（批 17 端点的 lastUsedAt，2026-11-12 前端补消费）：
 *  当天 = 「今天」，不满一天但已跨日 = 「昨天」，其余按整天数 = 「N 天前」。
 *  字段缺失 / 解析不了 → 空串（调用方整段不显示，不出 NaN/undefined）。 */
function skillLastUsedText(iso) {
  const at = Date.parse(String(iso || ""));
  if (!Number.isFinite(at)) return "";
  const now = Date.now();
  if (at >= now) return "今天"; // 服务端钟领先于本机钟：视为刚用过
  if (new Date(at).toDateString() === new Date(now).toDateString()) return "今天";
  const days = Math.floor((now - at) / 86_400_000);
  return days < 1 ? "昨天" : `${days} 天前`;
}

async function loadSkills() {
  const box = document.getElementById("skill-list");
  const locations = document.getElementById("skill-locations");
  const countEl = document.getElementById("skill-count");
  const add = document.getElementById("skill-add");
  if (!box) return;
  const hadCache = paintSkillCache(box, locations, countEl);
  try {
    // 建议快照与列表并行取；404（SKILL_ADVICE=false）= 功能整体不出现
    const [response, adviceView] = await Promise.all([
      request("/api/v1/agent/skills", { cache: "no-store" }),
      fetchSkillAdvice(),
    ]);
    const data = await response.json().catch(() => ({}));
    if (response.status === 404) {
      skillCache.data = null;
      skillCache.advice = null;
      skillCache.signature = "";
      if (countEl) {
        countEl.textContent = "";
        countEl.hidden = true;
        countEl.classList.remove("is-error");
      }
      if (locations) {
        locations.hidden = true;
        locations.replaceChildren();
      }
      if (add) add.hidden = true;
      const toolbar = document.getElementById("skill-toolbar");
      if (toolbar) toolbar.hidden = true;
      const banner = document.getElementById("skill-advice-banner");
      if (banner) banner.hidden = true;
      box.innerHTML = `<div class="card sk-empty"><p class="set-hint">技能管理未启用（服务端 SKILLS_ADMIN=false）。</p></div>`;
      return;
    }
    if (!response.ok) throw new Error(String(response.status));
    const next = {
      dir: String(data.dir || ""),
      origin: data.origin,
      items: Array.isArray(data.items) ? data.items : [],
      dirs: Array.isArray(data.dirs) ? data.dirs : [],
      extraDirs: data.extraDirs !== false,
    };
    const signature = skillPageSignature(next, adviceView);
    const changed = !hadCache || signature !== skillCache.signature;
    applySkillPageMeta(next, locations, countEl);
    skillCache.data = next;
    skillCache.advice = adviceView;
    skillCache.signature = signature;
    skillAdvice.view = adviceView;
    // 缓存已经把同一份内容画上去了就不要再拆一次 DOM，避免后台刷新打断滚动/筛选
    if (changed) renderSkillList(box, next.items);
  } catch (error) {
    if (error.message === "forbidden") return;
    if (hadCache) {
      // 后台刷新失败先留着旧内容，只把计数行改成失败提示；总比整页变成错误块好
      if (countEl && skillCache.data) {
        countEl.textContent = `刷新失败：${error.message}`;
        countEl.hidden = false;
        countEl.classList.add("is-error");
      }
      return;
    }
    box.innerHTML = `<div class="set-hint is-error">读不到技能：${esc(String(error.message))}</div>`;
  }
}

export { SKILL_ADVICE_BUCKET_LABEL, SKILL_ADVICE_FILTERS, SKILL_ADVICE_FREQ_LABEL, SKILL_FREQ_RANK, SKILL_NAME_RE, SKILL_NEXT_TURN_HINT, SKILL_ORIGIN_LABEL, SKILL_SORT_OPTIONS, applySkillAdvice, fetchSkillAdvice, loadSkills, runSkillAdvice, skillAdvice, skillAdvicePlan, skillLastUsedText, skillSizeText, skillWhenText };
