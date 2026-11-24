/**
 * 二级页 · 派活工人（池）（2026-11-23）
 *
 * 普通助手（worker 会话）退役后，本机唯一可配的工人就是「派活工人（池）」。
 * 这一页把池工人的可调面一次摆清：
 *   人设正文  → GET/PUT /api/v1/agent/worker-persona（与旧 worker 共用同一份文件，可改）
 *   工具      → GET/PUT /api/v1/agent/worker-tools（四件勾选；上报恒开，不可勾）
 *   模型/权限 → 只读，来自 GET /api/v1/agent/executor 的 profiles.pool；改去「派活 → 执行器」
 *   上下文    → 只读，来自 GET /api/v1/agent/context-defaults?role=dispatch-worker 的九段；
 *              逐段看原文去「注入 → 上下文」
 *
 * 入口 #/settings/partners/pool（旧 #/settings/partners/worker 由 settings-router 改写到这）。
 * 读不到就整段不占位：除人设外的三块都是增强信息，任何一块 404 都不能挡人设编辑。
 */

import { el } from "./dom.js";
import { chevSvg } from "./icons.js";
import { esc } from "./markdown.js";
import { request } from "./net.js";
import { currentPartnerProfileId } from "./route.js";
import { switchMarkup, setSwitchChecked } from "./settings-atoms.js";
import { openModal, toast, openConfirm } from "./ui-atoms.js";

const POOL_PROFILE_ID = "pool";
const PW_PERSONA = "/api/v1/agent/worker-persona";
const PW_TOOLS = "/api/v1/agent/worker-tools";
const PW_EXECUTOR = "/api/v1/agent/executor";
const PW_CONTEXT = "/api/v1/agent/context-defaults?role=dispatch-worker";
const PW_CHEV = chevSvg("chev wf-chev");
const PW_CONTEXT_HASH = "#/settings/context?role=dispatch-worker";
const PW_EXECUTOR_HASH = "#/settings/agent";

const PW_TOOLS_TIP =
  "本机池工人的四件工具按这里勾选；外部 CLI 用它们自己的工具，不在此列。上报（escalate）恒开。";

function pwLockIcon() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`;
}

function pwMarkup(data) {
  const readOnly = data.editable === false;
  return `
  <div class="pf">
    <button class="pf-back" type="button" id="pw-back">← 总管与执事</button>
    <header class="pf-hero">
      <span class="pt-avatar wf-ava" aria-hidden="true">池</span>
      <div class="pf-hero-main">
        <h1 class="pf-title">派活工人（池）</h1>
      </div>
    </header>

    <section class="pf-sec">
      <div class="pf-sec-head">
        <h2 class="pf-sec-title" data-tip="池工人与外部 CLI 共用这一份「你是谁」；保存后下一单生效">人设正文</h2>
        <span class="pf-sec-note" id="pw-count">${Number(data.chars) || 0} 字</span>
      </div>
      <div class="card pf-panel">
        <textarea class="pf-soul" id="pw-text" spellcheck="false" aria-label="池工人人设正文"
                  ${readOnly ? "readonly" : ""}>${esc(data.persona)}</textarea>
        <div class="pf-foot">
          <button class="ghost" type="button" id="pw-reset" disabled>撤销</button>
          <button class="ghost" type="button" id="pw-default" ${readOnly ? "disabled" : ""}>恢复默认</button>
          <button class="btn-primary" type="button" id="pw-save" disabled>保存</button>
        </div>
        <p class="pf-hint" id="pw-hint">
          ${readOnly ? "工人人设编辑已关闭（WORKER_PERSONA_EDIT=false）" : ""}
        </p>
      </div>
    </section>

    <section class="pf-sec" id="pw-tools-sec" hidden>
      <div class="pf-sec-head">
        <h2 class="pf-sec-title" data-tip="${esc(PW_TOOLS_TIP)}">工具</h2>
        <span class="pf-sec-note">四件可勾 · 上报恒开</span>
      </div>
      <div class="card pf-panel wf-rows">
        <div class="pf-row" id="pw-tools-row" hidden>
          <span class="pf-row-label" data-tip="${esc(PW_TOOLS_TIP)}">可用工具</span>
          <span class="wf-row-tail">
            <span class="wf-chips" id="pw-tool-chips"></span>
            <button class="wf-more" type="button" id="pw-tools-edit"
                    aria-label="调整池工人工具" data-tip="调整">⋯</button>
          </span>
        </div>
        <div class="pf-row">
          <span class="pf-row-label" data-tip="派活遇到要人时向派单的总管 / 执事提问；答复经插话通道回来">上报</span>
          <span class="wf-row-tail"><span class="pf-tag">恒开</span></span>
        </div>
      </div>
    </section>

    <section class="pf-sec" id="pw-model-sec" hidden>
      <div class="pf-sec-head">
        <h2 class="pf-sec-title" data-tip="模型与权限在本页只读；改去「派活 → 执行器」，两处共用同一份配置">模型与权限</h2>
        <span class="pf-sec-note">只读 · 去派活页改</span>
      </div>
      <div class="card pf-panel wf-rows">
        <button class="pf-row wf-link" type="button" id="pw-model-row">
          <span class="pf-row-label">模型</span>
          <span class="wf-row-tail"><span class="wf-row-value" id="pw-model"></span>${PW_CHEV}</span>
        </button>
        <div class="pf-row">
          <span class="pf-row-label" data-tip="池与本机内核同档：权限由本机权限策略管，不在这里单独设">权限</span>
          <span class="wf-row-tail"><span class="wf-fixed" role="button" aria-disabled="true">${pwLockIcon()}本机策略管</span></span>
        </div>
        <button class="pf-row wf-link" type="button" id="pw-executor-row">
          <span class="pf-row-label">执行器</span>
          <span class="wf-row-tail"><span class="wf-row-value" id="pw-executor"></span>${PW_CHEV}</span>
        </button>
      </div>
    </section>

    <section class="pf-sec" id="pw-context-sec" hidden>
      <div class="pf-sec-head">
        <h2 class="pf-sec-title" data-tip="池工人不是会话：每张单按这套固定段装配；只有「人设」这一段能改">上下文（一单的固定段）</h2>
        <span class="pf-sec-note" id="pw-context-note"></span>
      </div>
      <div class="card pf-panel wf-rows" id="pw-sections"></div>
    </section>
  </div>`;
}

function pwRenderError(root, message) {
  root.innerHTML = `<div class="pf">
    <button class="pf-back" type="button" id="pw-back">← 总管与执事</button>
    <p class="set-hint is-error">读不到池工人人设：${esc(message)}</p>
    <button class="ghost" type="button" id="pw-retry">重试</button>
  </div>`;
  root.querySelector("#pw-back")?.addEventListener("click", () => {
    location.hash = "#/settings/partners";
  });
  root.querySelector("#pw-retry")?.addEventListener("click", () => void renderPoolWorkerPage());
}

async function renderPoolWorkerPage() {
  const root = el.settingsInner;
  if (!root) return;
  root.classList.add("is-partner-profile");
  root.innerHTML = `<div class="pf"><p class="set-hint">读取中…</p></div>`;

  let data;
  try {
    const response = await request(PW_PERSONA, { cache: "no-store" });
    data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok !== true) throw new Error(String(response.status));
  } catch (error) {
    if (error.message === "forbidden") return;
    if (currentPartnerProfileId() !== POOL_PROFILE_ID) return;
    pwRenderError(root, error.message);
    return;
  }
  if (currentPartnerProfileId() !== POOL_PROFILE_ID) return;

  root.innerHTML = pwMarkup(data);

  const text = root.querySelector("#pw-text");
  const count = root.querySelector("#pw-count");
  const hint = root.querySelector("#pw-hint");
  const reset = root.querySelector("#pw-reset");
  const restore = root.querySelector("#pw-default");
  const save = root.querySelector("#pw-save");
  let loaded = String(data.persona ?? "");
  const editable = data.editable !== false;
  let saving = false;

  const isDirty = () => Boolean(text) && text.value !== loaded;
  const refresh = () => {
    if (!text) return;
    if (count) count.textContent = `${text.value.length} 字`;
    const changed = isDirty();
    if (reset) reset.disabled = saving || !changed;
    if (save) save.disabled = saving || !changed;
  };
  const clearHint = () => {
    if (hint) hint.textContent = "";
  };
  const autoGrow = () => {
    if (!text) return;
    text.style.height = "auto";
    text.style.height = `${Math.max(150, Math.min(text.scrollHeight + 2, 560))}px`;
  };

  const saveNow = async () => {
    if (!text || !editable || saving) return false;
    if (!isDirty()) return true;
    saving = true;
    refresh();
    if (hint) hint.textContent = "保存中…";
    try {
      const response = await request(PW_PERSONA, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ persona: text.value }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok !== true) {
        if (hint) hint.textContent = body.message || body.error || `保存失败：HTTP ${response.status}`;
        return false;
      }
      toast("已保存，下一单生效");
      loaded = body.persona;
      text.value = body.persona;
      clearHint();
      autoGrow();
      refresh();
      // 上下文段里的「人设」字数跟着变，重拉一次固定段（读不到就保持现状）
      void pwLoadSections(root);
      return true;
    } catch (error) {
      if (error.message === "forbidden") return false;
      if (hint) hint.textContent = `保存失败：${error.message}`;
      return false;
    } finally {
      saving = false;
      refresh();
    }
  };

  /** 离开这一页：有草稿先问一句，保存成功才走，避免顺手点个链接就丢字。 */
  const leaveTo = async (hash) => {
    if (!isDirty()) {
      location.hash = hash;
      return;
    }
    const proceed = await openConfirm({
      title: "人设还没保存",
      message: "离开会丢掉这次改动。",
      confirmText: "保存后离开",
      cancelText: "留下",
    });
    if (!proceed) return;
    if (!(await saveNow())) return;
    location.hash = hash;
  };

  root.querySelector("#pw-back")?.addEventListener("click", () => {
    void leaveTo("#/settings/partners");
  });
  text?.addEventListener("input", () => {
    clearHint();
    refresh();
    autoGrow();
  });
  reset?.addEventListener("click", () => {
    text.value = loaded;
    clearHint();
    refresh();
    autoGrow();
  });
  // 恢复默认 = 写空串（服务端删文件回默认），不直接保存，用户再点「保存」才落盘。
  restore?.addEventListener("click", () => {
    text.value = "";
    text.focus();
    clearHint();
    refresh();
    autoGrow();
  });
  save?.addEventListener("click", () => void saveNow());
  root.querySelector("#pw-model-row")?.addEventListener("click", () => {
    location.hash = PW_EXECUTOR_HASH;
  });
  root.querySelector("#pw-executor-row")?.addEventListener("click", () => {
    location.hash = PW_EXECUTOR_HASH;
  });

  autoGrow();
  refresh();
  void pwLoadTools(root);
  void pwLoadExecutor(root);
  void pwLoadSections(root);
}

/** 工具：四件勾选（存取消名单）；上报恒开，不占这四件的开关。读不到就整段不占位。 */
async function pwLoadTools(root) {
  const section = root.querySelector("#pw-tools-sec");
  const row = root.querySelector("#pw-tools-row");
  const chips = root.querySelector("#pw-tool-chips");
  const edit = root.querySelector("#pw-tools-edit");
  if (!section || !row || !chips || !edit) return;
  let data;
  try {
    const response = await request(PW_TOOLS, { cache: "no-store" });
    if (!response.ok) return;
    data = await response.json().catch(() => ({}));
    if (data?.ok !== true) return;
  } catch (error) {
    if (error.message === "forbidden") return;
    return;
  }
  const catalog = Array.isArray(data.catalog) ? data.catalog : [];
  if (!catalog.length) return;
  const state = { disabled: Array.isArray(data.disabled) ? [...data.disabled] : [] };
  const paintChips = () => {
    chips.replaceChildren();
    for (const item of catalog) {
      const chip = document.createElement("span");
      const on = !state.disabled.includes(item.name);
      chip.className = `wf-chip${on ? "" : " is-off"}`;
      chip.textContent = item.label;
      chip.dataset.tip = item.note || item.label;
      chips.append(chip);
    }
  };
  paintChips();
  row.hidden = false;
  section.hidden = false;
  edit.addEventListener("click", () => pwOpenToolsModal(catalog, state, paintChips));
}

function pwOpenToolsModal(catalog, state, paintChips) {
  openModal("池工人工具", (body) => {
    const box = document.createElement("div");
    box.className = "wf-tool-modal";
    for (const item of catalog) {
      const row = document.createElement("div");
      row.className = "pf-row";
      const label = document.createElement("span");
      label.className = "pf-row-label";
      label.textContent = item.label;
      label.dataset.tip = item.note || item.label;
      const control = document.createElement("span");
      control.className = "wf-row-tail";
      control.innerHTML = switchMarkup(!state.disabled.includes(item.name), {
        label: `${item.label}开关`,
      });
      const sw = control.querySelector(".switch");
      sw?.addEventListener("click", async () => {
        const turningOff = !state.disabled.includes(item.name);
        const next = turningOff
          ? [...state.disabled, item.name]
          : state.disabled.filter((name) => name !== item.name);
        sw.disabled = true;
        try {
          const response = await request(PW_TOOLS, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ disabled: next }),
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok || payload?.ok !== true) {
            toast(payload.message || `没存成：HTTP ${response.status}`);
            return;
          }
          state.disabled = Array.isArray(payload.disabled) ? [...payload.disabled] : next;
          setSwitchChecked(sw, !state.disabled.includes(item.name));
          paintChips();
          const granted = Array.isArray(payload.granted) ? payload.granted : [];
          toast(
            granted.length
              ? "已保存，下一次派活生效"
              : "全关了：池工人下次派活没有任何工具",
          );
        } catch (error) {
          if (error.message !== "forbidden") toast("没存成，稍后再试");
        } finally {
          sw.disabled = false;
        }
      });
      row.append(label, control);
      box.append(row);
    }
    const report = document.createElement("div");
    report.className = "pf-row";
    report.innerHTML = `<span class="pf-row-label" data-tip="派活遇到要人时向派单的总管 / 执事提问；答复经插话通道回来">上报</span>
      <span class="wf-row-tail"><span class="pf-tag">恒开</span></span>`;
    box.append(report);
    body.append(box);
  });
}

/** 模型 / 权限 / 执行器：只读，读 executor 视图；改去派活 → 执行器。 */
async function pwLoadExecutor(root) {
  const section = root.querySelector("#pw-model-sec");
  const model = root.querySelector("#pw-model");
  const running = root.querySelector("#pw-executor");
  if (!section || !model || !running) return;
  let data;
  try {
    const response = await request(PW_EXECUTOR, { cache: "no-store" });
    if (!response.ok) return;
    data = await response.json().catch(() => ({}));
    if (!data || data.ok === false) return;
  } catch (error) {
    if (error.message === "forbidden") return;
    return;
  }
  const kinds = Array.isArray(data.kinds) ? data.kinds : [];
  const profile = (data.profiles && data.profiles.pool) || {};
  const picked = String(profile.model ?? "").trim();
  model.textContent = picked || "跟随默认模型";
  model.title = picked || "留空 = 跟随「设置 → 模型」的默认模型";
  const employee = String(data.employee || "");
  const kind = kinds.find((item) => item && item.id === employee);
  running.textContent = kind?.label || employee || "—";
  // 默认执行器不是池时给一句实话：新单不会落到池里。
  if (employee && employee !== "pool") {
    running.textContent = `${kind?.label || employee}（新单暂不落池）`;
    running.title = "默认派给谁现在是别的执行器；到「派活 → 执行器」改回池，新单才会落池";
  }
  section.hidden = false;
}

/** 上下文：池工人一单的九段（只读）；点任意一行去上下文页看原文。 */
async function pwLoadSections(root) {
  const section = root.querySelector("#pw-context-sec");
  const box = root.querySelector("#pw-sections");
  const note = root.querySelector("#pw-context-note");
  if (!section || !box) return;
  let data;
  try {
    const response = await request(PW_CONTEXT, { cache: "no-store" });
    if (!response.ok) return;
    data = await response.json().catch(() => ({}));
    if (!data || data.ok === false) return;
  } catch (error) {
    if (error.message === "forbidden") return;
    return;
  }
  const sections = data.system && Array.isArray(data.system.sections) ? data.system.sections : [];
  if (!sections.length) return;
  const tools = data.tools && Number.isFinite(Number(data.tools.count)) ? Number(data.tools.count) : 0;
  if (note) note.textContent = `${sections.length} 段 · 工具 ${tools} 件`;
  box.replaceChildren();
  for (const item of sections) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "pf-row wf-link";
    const label = item.label || item.key || "段";
    const chars = Number(item.chars) || 0;
    row.innerHTML = `<span class="pf-row-label">${esc(String(label))}</span>
      <span class="wf-row-tail"><span class="wf-row-value">${chars ? `${chars} 字` : "0 字"}</span>${PW_CHEV}</span>`;
    row.dataset.tip = item.text ? String(item.text).slice(0, 300) : "这一段这次是空槽位";
    row.addEventListener("click", () => {
      location.hash = PW_CONTEXT_HASH;
    });
    box.append(row);
  }
  section.hidden = false;
}

export { renderPoolWorkerPage };
