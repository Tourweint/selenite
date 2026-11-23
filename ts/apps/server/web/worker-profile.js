/**
 * 二级页 · 普通助手（2026-11-16；2026-11-21 版面重做）
 *
 * 所有 Worker 共用一份人设 + 一套派活工具面；改完下一轮生效。
 * 版面三段：人设正文 / 会话（项目 · 技能 · 上下文）/ 派活（本机工人工具面）。
 * 解释只进 data-tip，不常驻成段落。
 * 入口 #/settings/partners/worker；端点 GET/PUT /api/v1/agent/worker-persona。
 */

import { el } from "./dom.js";
import { chevSvg } from "./icons.js";
import { esc } from "./markdown.js";
import { request } from "./net.js";
import { currentPartnerProfileId } from "./route.js";
import { switchMarkup, setSwitchChecked } from "./settings-atoms.js";
import { openConfirm, openModal, toast } from "./ui-atoms.js";

// 与服务端 workerPersonaDefault() 同一份文本（固定字节）；改默认文案两处要同步。
// 2026-11-16 批2 拆层：这里只有身份与作风（会话与派活工人同吃）；
// remember / recall / set_reminder 的工具提示只在会话里由服务端追加，不进文件。
const WORKER_DEFAULT = "你是一个普通任务助手，负责把交到你手上的具体事情办完。交代的事一定办到底：不推、不挑、不抱怨；办不成要说清卡在哪一步、缺什么。说话直接、克制、就事论事，给结论也给依据；不冒充总管，也不代表任何执事。涉及真实文件、真实数据、真实日程或当前时间的事，必须先用工具去看，不许凭印象回答或编造；看不到就说明缺什么。做不到、做不完或做偏了就如实说，不硬凑结果，更不谎报完成。没有预设的私人档案，也不主动建立执事身份。";

const WF_ENDPOINT = "/api/v1/agent/worker-persona";
const WF_CHEV = chevSvg("chev wf-chev");
const WF_PROJECT_TIP =
  "普通助手不绑项目：新会话跟随侧栏当前项目，创建后固定；派活按单子的 project 参数指定。";
const WF_TOOLS_TIP =
  "只对本机派活的工人生效；外部 CLI 用它们自己的工具，Worker 会话不在此列。";

function wfLockIcon() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`;
}

function wfMarkup(data) {
  const readOnly = data.editable === false;
  return `
  <div class="pf">
    <button class="pf-back" type="button" id="wf-back">← 总管与执事</button>
    <header class="pf-hero">
      <span class="pt-avatar wf-ava" aria-hidden="true">普</span>
      <div class="pf-hero-main">
        <h1 class="pf-title">普通助手</h1>
      </div>
    </header>

    <section class="pf-sec">
      <div class="pf-sec-head">
        <h2 class="pf-sec-title" data-tip="两种用法共用这一份：会话下一轮生效，派活下一单生效">人设正文</h2>
        <span class="pf-sec-note" id="wf-count">${Number(data.chars) || 0} 字</span>
      </div>
      <div class="card pf-panel">
        <textarea class="pf-soul" id="wf-text" spellcheck="false" aria-label="人设正文"
                  ${readOnly ? "readonly" : ""}>${esc(data.persona)}</textarea>
        <div class="pf-foot">
          <button class="ghost" type="button" id="wf-reset" disabled>撤销</button>
          <button class="ghost" type="button" id="wf-default" ${readOnly ? "disabled" : ""}>恢复默认</button>
          <button class="btn-primary" type="button" id="wf-save" disabled>保存</button>
        </div>
        <p class="pf-hint" id="wf-hint">
          ${readOnly ? "Worker 人设编辑已关闭（WORKER_PERSONA_EDIT=false）" : ""}
        </p>
      </div>
    </section>

    <section class="pf-sec" id="wf-session-sec">
      <div class="pf-sec-head">
        <h2 class="pf-sec-title" data-tip="同一份人设，在对话里直接用：带记忆召回、技能、全量工具与审批">会话</h2>
        <span class="pf-sec-note">对话里</span>
      </div>
      <div class="card pf-panel wf-rows">
        <div class="pf-row">
          <span class="pf-row-label">所处项目</span>
          <span class="wf-fixed" role="button" aria-disabled="true" data-tip="${esc(WF_PROJECT_TIP)}">
            ${wfLockIcon()}创建时确定
          </span>
        </div>
        <button class="pf-row wf-link" type="button" id="wf-skills" hidden>
          <span class="pf-row-label" data-tip="只影响普通助手会话；技能索引随下一个会话刷新，skill 工具立即生效">技能</span>
          <span class="wf-row-tail"><span class="wf-row-value" id="wf-skills-note"></span>${WF_CHEV}</span>
        </button>
      </div>
    </section>

    <section class="pf-sec" id="wf-dispatch-sec" hidden>
      <div class="pf-sec-head">
        <h2 class="pf-sec-title" data-tip="同一份人设，派活时写进任务书「你是谁」段：没有记忆 / 技能 / 审批，工具只有四件 + 上报">派活</h2>
        <span class="pf-sec-note">派出去</span>
      </div>
      <div class="card pf-panel wf-rows">
        <div class="pf-row" id="wf-tools-row" hidden>
          <span class="pf-row-label" data-tip="${esc(WF_TOOLS_TIP)}">工具</span>
          <span class="wf-row-tail">
            <span class="wf-chips" id="wf-tool-chips"></span>
            <button class="wf-more" type="button" id="wf-tools-edit"
                    aria-label="调整本机工人工具" data-tip="调整">⋯</button>
          </span>
        </div>
      </div>
    </section>
  </div>`;
}

/** 读失败：一句原因 + 重试按钮（重新 GET）。 */
function wfRenderError(root, message) {
  root.innerHTML = `<div class="pf">
    <button class="pf-back" type="button" id="wf-back">← 总管与执事</button>
    <p class="set-hint is-error">读不到普通助手人设：${esc(message)}</p>
    <button class="ghost" type="button" id="wf-retry">重试</button>
  </div>`;
  root.querySelector("#wf-back")?.addEventListener("click", () => {
    location.hash = "#/settings/partners";
  });
  root.querySelector("#wf-retry")?.addEventListener("click", () => void renderWorkerProfilePage());
}

async function renderWorkerProfilePage() {
  const root = el.settingsInner;
  if (!root) return;
  root.classList.add("is-partner-profile");
  root.innerHTML = `<div class="pf"><p class="set-hint">读取中…</p></div>`;

  let data;
  try {
    const response = await request(WF_ENDPOINT, { cache: "no-store" });
    data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok !== true) throw new Error(String(response.status));
  } catch (error) {
    if (error.message === "forbidden") return;
    if (currentPartnerProfileId() !== "worker") return;
    wfRenderError(root, error.message);
    return;
  }
  if (currentPartnerProfileId() !== "worker") return;

  root.innerHTML = wfMarkup(data);

  const text = root.querySelector("#wf-text");
  const count = root.querySelector("#wf-count");
  const hint = root.querySelector("#wf-hint");
  const reset = root.querySelector("#wf-reset");
  const restore = root.querySelector("#wf-default");
  const save = root.querySelector("#wf-save");
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
  // 正文框按内容长高（2026-11-21 用户口径）：默认 203 字时不再留一大截空白，
  // 写长了最多到 560px，再长内部滚动。
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
      const response = await request(WF_ENDPOINT, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ persona: text.value }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok !== true) {
        if (hint) hint.textContent = body.message || body.error || `保存失败：HTTP ${response.status}`;
        return false;
      }
      toast("已保存，下一轮生效");
      loaded = body.persona;
      text.value = body.persona;
      clearHint();
      autoGrow();
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

  root.querySelector("#wf-back")?.addEventListener("click", () => {
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
  // 只把默认正文填进 textarea，不直接保存——用户再点「保存」才落盘。
  restore?.addEventListener("click", () => {
    text.value = WORKER_DEFAULT;
    text.focus();
    clearHint();
    refresh();
    autoGrow();
  });
  save?.addEventListener("click", () => void saveNow());

  autoGrow();
  refresh();
  void wfWireSkills(root);
  void wfWireTools(root);
}

/** 会话行 · 技能（2026-11-21）：普通助手有自己的技能可见性。
 *  语义与执事个人页同一套：全局已开 = 所有人都有、这里锁死；全局未开可以只给普通助手开。
 *  只影响普通助手会话；派活工人不读技能索引（外部 CLI 用自己的工具）。 */
async function wfWireSkills(root) {
  const row = root.querySelector("#wf-skills");
  const note = root.querySelector("#wf-skills-note");
  if (!row || !note) return;
  const read = async () => {
    try {
      const response = await request("/api/v1/agent/skills?partnerId=worker", {
        cache: "no-store",
      });
      if (!response.ok) return null;
      const data = await response.json().catch(() => ({}));
      return Array.isArray(data.items) ? data.items : null;
    } catch (error) {
      if (error.message === "forbidden") return null;
      return null;
    }
  };
  const state = { items: await read() };
  if (!state.items) return; // 读不到就不渲染这一行，不挡人设编辑
  const paint = () => {
    const items = state.items || [];
    const globalOn = items.filter((item) => item && item.enabled === true).length;
    const override = items.filter((item) => item && item.partnerOverride === true).length;
    note.textContent = `全局 ${globalOn} · 独开 ${override}`;
    row.hidden = false;
  };
  paint();
  row.addEventListener("click", () => wfOpenSkillsModal(state, paint));
}

/** 技能弹层：两段——全局已开（锁死只读）/ 全局未开（只给普通助手开）。
 *  不写长说明；全局已开的锁定原因挂在行尾的「锁」上。 */
function wfOpenSkillsModal(state, onChanged) {
  openModal(
    "技能",
    (body) => {
      const items = state.items || [];
      const globalOn = items
        .filter((item) => item && item.enabled === true)
        .slice()
        .sort((a, b) => String(a?.name || "").localeCompare(String(b?.name || "")));
      const globalOff = items
        .filter((item) => item && item.enabled !== true)
        .slice()
        .sort(
          (a, b) =>
            Number(b?.partnerOverride === true) - Number(a?.partnerOverride === true) ||
            String(a?.name || "").localeCompare(String(b?.name || "")),
        );
      const overridden = globalOff.filter((item) => item?.partnerOverride === true).length;
      body.innerHTML = `
        <div class="pf-live-block">
          <div class="pf-live-head"><span>全局已开（所有人都有）</span><span class="pf-tag">${globalOn.length} 本</span></div>
          <div class="pf-skills" id="wf-skill-on"></div>
        </div>
        <div class="pf-live-block">
          <div class="pf-live-head"><span>全局未开（只给普通助手开）</span><span class="pf-tag" id="wf-skill-off-count">共 ${globalOff.length} 本 · 已开 ${overridden}</span></div>
          <div class="pf-skills" id="wf-skill-off"></div>
        </div>`;
      const onBox = body.querySelector("#wf-skill-on");
      const offBox = body.querySelector("#wf-skill-off");
      const offCount = body.querySelector("#wf-skill-off-count");

      const rowOf = (name, summary) => {
        const node = document.createElement("div");
        node.className = "pf-skill";
        node.innerHTML = `<span class="pf-skill-name">${esc(String(name || ""))}</span>
          <span class="pf-skill-sum">${esc(String(summary || ""))}</span>
          <span class="pf-skill-when"></span>`;
        return node;
      };

      if (onBox) {
        if (!globalOn.length) {
          onBox.innerHTML = `<p class="pf-hint">全局技能现在全关。</p>`;
        } else {
          for (const skill of globalOn) {
            const node = rowOf(skill.name, skill.summary);
            const slot = node.querySelector(".pf-skill-when");
            if (slot) {
              slot.textContent = "已开 · 锁";
              slot.dataset.tip = "全局已开：所有人都有，普通助手不能单独关";
            }
            onBox.append(node);
          }
        }
      }

      if (offBox) {
        if (!globalOff.length) {
          offBox.innerHTML = `<p class="pf-hint">全局没开的技能都开给普通助手了。</p>`;
        } else {
          for (const skill of globalOff) {
            const node = rowOf(skill.name, skill.summary);
            const slot = node.querySelector(".pf-skill-when");
            if (!slot) continue;
            slot.className = "pf-skill-switch";
            slot.innerHTML = switchMarkup(skill?.partnerOverride === true, {
              label: `给「${esc(String(skill?.name || ""))}」开`,
            });
            const sw = slot.querySelector(".switch");
            sw?.addEventListener("click", async () => {
              if (sw.disabled) return;
              const next = sw.getAttribute("aria-checked") !== "true";
              sw.disabled = true;
              try {
                const response = await request(
                  `/api/v1/agent/worker-skills/${encodeURIComponent(skill.name)}/enabled`,
                  { method: "PUT", body: JSON.stringify({ enabled: next }) },
                );
                const data = await response.json().catch(() => ({}));
                if (!response.ok) {
                  toast(data.message || `改不了这个开关：HTTP ${response.status}`);
                  return;
                }
                skill.partnerOverride = next;
                skill.partnerEnabled = next;
                setSwitchChecked(sw, next);
                const on = globalOff.filter((item) => item?.partnerOverride === true).length;
                if (offCount) offCount.textContent = `共 ${globalOff.length} 本 · 已开 ${on}`;
                onChanged();
              } catch (error) {
                if (error.message !== "forbidden") toast("改不了这个开关，稍后再试");
              } finally {
                sw.disabled = false;
              }
            });
            offBox.append(node);
          }
        }
      }
    },
    { className: "modal-wide", closeOnMask: false },
  );
}

/** 工具（2026-11-17 批4，2026-11-21 收成一行）：只管本机 native 工人（canonical 四件，存取消名单）。
 *  平时只画四颗名字；逐条开关收进 ⋯ 弹层，别让四行开关把页面撑开。 */
async function wfWireTools(root) {
  const row = root.querySelector("#wf-tools-row");
  const chips = root.querySelector("#wf-tool-chips");
  const edit = root.querySelector("#wf-tools-edit");
  if (!row || !chips || !edit) return;
  let data;
  try {
    const response = await request("/api/v1/agent/worker-tools", { cache: "no-store" });
    if (!response.ok) return;
    data = await response.json().catch(() => ({}));
    if (data?.ok !== true) return;
  } catch (error) {
    if (error.message === "forbidden") return;
    return; // 读不到就不渲染这一行，不挡人设编辑
  }
  const catalog = Array.isArray(data.catalog) ? data.catalog : [];
  if (!catalog.length) return;
  const state = {
    disabled: Array.isArray(data.disabled) ? [...data.disabled] : [],
    escalate: data.escalate !== false,
  };
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
    // 上报（escalate）：不在四件勾选里，恒开；让「他能不能找派单的人」在页面上看得见。
    const report = document.createElement("span");
    report.className = `wf-chip is-fixed${state.escalate ? "" : " is-off"}`;
    report.textContent = "上报";
    report.dataset.tip = state.escalate
      ? "派活遇到要人时，向派单的总管/执事提问；答复经插话通道回来（escalate，恒开，不占这四件的开关）"
      : "上报通道已关（WORKER_ESCALATE_TOOL=false）";
    chips.append(report);
  };
  paintChips();
  row.hidden = false;
  wfSyncDispatchSection(root);
  edit.addEventListener("click", () => wfOpenToolsModal(catalog, state, paintChips));
}

function wfOpenToolsModal(catalog, state, paintChips) {
  openModal("本机工人工具", (body) => {
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
          const response = await request("/api/v1/agent/worker-tools", {
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
              : "全关了：本机工人下次派活没有任何工具",
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
    report.innerHTML = `<span class="pf-row-label" data-tip="派活遇到要人时，向派单的总管/执事提问；答复经插话通道回来">上报</span>
      <span class="wf-row-tail"><span class="pf-tag">${state.escalate ? "恒开" : "已关"}</span></span>`;
    box.append(report);
    body.append(box);
  });
}

/** 派活分区：工具行读不到就整段不占位（派活带项目记忆已是恒注入，2026-11-21 退役开关）。 */
function wfSyncDispatchSection(root) {
  const section = root.querySelector("#wf-dispatch-sec");
  const row = root.querySelector("#wf-tools-row");
  if (section) section.hidden = !row || row.hidden;
}

export { renderWorkerProfilePage };
