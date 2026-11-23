/**
 * 执事列表 + 新建 / 编辑模态
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { paintAvatar, partnerDotClass } from "./avatar.js";
import { addNotice } from "./chat-notice.js";
import { chevSvg } from "./icons.js";
import { attr, esc } from "./markdown.js";
import { request } from "./net.js";
import { ptSaveName, ptWireInstructionEditor } from "./partner-editor.js";
import { PF_PERSONA_EDITORS, pfPersonaFieldMarkup, pfPersonaValue } from "./partner-profile.js";
import { openRunPartnerModal, ptRenderRoutineList, ptRoutineFormMarkup, ptWireRoutineForm } from "./partner-routines.js";
import { applyTemplateChain, PARTNER_TEMPLATES, renderHireWall } from "./partner-templates.js";
import { loadRoster, syncChiefAvatar } from "./partners-status.js";
import { openProjMenu } from "./settings-projects.js";
import { clearModalHint, setModalHint } from "./project-modal.js";
import { cs } from "./settings-drawer.js";
import { mountChainEditor } from "./settings-model.js";
import { state } from "./state.js";
import { closeModal, openModal, toast } from "./ui-atoms.js";


/* ── 执事与例行任务（E1，2026-11-05；纯前端，后端零改动）────
   端点形状以 companion-api.ts / routines.ts 为准：
   执事投影 {id,name,status,soulVersion,domain?}；详情多 soul / soulVersion / modelChain；
   例行任务投影 {id,name,triggers,sessionMode,enabled,…}；runs {status,trigger,summary,startedAt,…}。
   网络只走 request()，反馈只走 toast()，确认只走 openModal()，动态值一律 esc()/attr()。 */

const PT_STATUS = {
  active: { text: "运行中", cls: "ok" },
  paused: { text: "已暂停", cls: "warn" },
  archived: { text: "已归档", cls: "" },
};
const PT_RUN_STATUS = {
  success: { text: "成功", cls: "ok" },
  failed: { text: "失败", cls: "warn" },
  interrupted: { text: "中断", cls: "warn" },
  running: { text: "运行中", cls: "" },
  skipped: { text: "跳过", cls: "" },
};

function ptStatusPill(status) {
  const info = PT_STATUS[status] || { text: status || "未知", cls: "" };
  return `<span class="pill-tag ${info.cls}">${esc(info.text)}</span>`;
}

function ptStatusDot(status, id = "") {
  // 与服务连通一起判：active + 在线才是绿；失联黄；暂停/归档灰（2026-11-06 C 批）
  const attrs = id ? ` data-pt-dot="${esc(id)}"` : "";
  return `<span class="status-dot ${partnerDotClass(status)}"${attrs} aria-hidden="true"></span>`;
}

/** 触发器人话化：cron 给原文 + 一句人话，其余给一句人话。返回值已转义，直接塞进模板。 */
function ptHumanizeTrigger(trigger) {
  if (!trigger) return "—";
  if (trigger.type === "cron") {
    const raw = String(trigger.expr || "");
    const parts = raw.trim().split(/\s+/);
    let human = "按 cron 定时";
    if (parts.length === 5) {
      const [mi, hr, dom, mon, dow] = parts;
      const pad = (v) => (v === "*" ? "*" : String(v).padStart(2, "0"));
      const clock = `${pad(hr)}:${pad(mi)}`;
      if (hr !== "*" && mi !== "*" && dom === "*" && mon === "*" && dow === "*") human = `每天 ${clock}`;
      else if (hr === "*" && mi !== "*" && dom === "*" && mon === "*" && dow === "*") human = `每小时第 ${mi} 分`;
      else if (hr === "*" && mi === "*") human = "每分钟";
      else if (dom !== "*") human = `每月 ${dom} 日 ${clock}`;
      else if (dow !== "*") human = `每周 ${dow} ${clock}`;
    }
    return `<span class="kv">${esc(raw)}</span> <span class="pt-human">${esc(human)}</span>`;
  }
  if (trigger.type === "interval") {
    const secs = Number(trigger.seconds) || 0;
    const mins = secs / 60;
    const human = Number.isInteger(mins) && mins > 0 ? `每 ${mins} 分钟` : `每 ${secs} 秒`;
    return esc(human);
  }
  if (trigger.type === "once") {
    const at = trigger.at ? new Date(trigger.at) : null;
    const shown = at && !Number.isNaN(at.getTime()) ? at.toLocaleString("zh-CN") : String(trigger.at || "");
    return `一次性 · ${esc(shown)}`;
  }
  if (trigger.type === "event") {
    const kind = String(trigger.kind || "");
    const matchText = trigger.match && Object.keys(trigger.match).length
      ? Object.entries(trigger.match).map(([k, v]) => `${k}=${v}`).join(", ")
      : "";
    return `事件 · ${esc(kind)}${matchText ? ` <span class="kv">${esc(matchText)}</span>` : ""}`;
  }
  return "—";
}

/* ── 执事列表（设置页 #/settings/partners）────────────── */

async function loadPartners() {
  const box = document.getElementById("partner-list");
  if (!box) return;
  try {
    const response = await request("/api/v1/partners", { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(String(response.status));
    // 设置页也共享头像 / 状态缓存（侧栏与设置不各拉一份结论）
    if (Array.isArray(data.partners)) {
      state.partners = data.partners;
      syncChiefAvatar();
    }
    renderPartnerList(box, data.partners || []);
  } catch (error) {
    if (error.message === "forbidden") return;
    box.innerHTML = `<div class="set-hint is-error">读不到执事：${esc(error.message)}</div>`;
  }
}

function renderPartnerList(box, partners) {
  box.replaceChildren();

  // 普通助手（2026-11-16）：全局一份人设，固定置顶，不是执事行——不进 hasButlers、
  // 没有 ⋯ / 暂停 / 状态徽章。点进去只改一份正文，所有 worker 下一轮生效。
  // 2026-11-21：卡面不再挂解释句，共用范围留给标签；详情页本身说明一切。
  const workerCard = document.createElement("div");
  workerCard.className = "card pt-card";
  workerCard.setAttribute("role", "button");
  workerCard.tabIndex = 0;
  workerCard.setAttribute("aria-label", "打开普通助手设置");
  workerCard.innerHTML = `
    <span class="pt-avatar pt-card-avatar" data-worker-avatar aria-hidden="true"></span>
    <div class="pt-card-main">
      <div class="pt-card-name-row">
        <span class="row-label pt-name">普通助手</span>
        <span class="pill-tag">全部 Worker 共用</span>
      </div>
    </div>`;
  paintAvatar(workerCard.querySelector("[data-worker-avatar]"), null, "普通助手");
  const openWorker = () => { location.hash = "#/settings/partners/worker"; };
  workerCard.addEventListener("click", openWorker);
  workerCard.addEventListener("keydown", (event) => {
    if (event.target !== workerCard) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openWorker();
  });
  box.append(workerCard);

  if (!partners.length) {
    const empty = document.createElement("div");
    empty.className = "card pt-empty";
    empty.innerHTML = `<p class="set-hint">还没有执事。新建一个，或给总管配个执事。</p>
      <button class="btn-primary" type="button" id="partner-empty-add">新建执事</button>`;
    box.append(empty);
    empty.querySelector("#partner-empty-add")?.addEventListener("click", () => openCreatePartnerModal());
    return;
  }
  // 招聘大厅（2026-11-15 执事招聘模板）：默认状态 = 只有总管、执事 0 个——正是新手
  // "不知道该建什么"的时刻，在最顶上摆模板卡墙。（开关 2026-11-21 退役，墙恒显示。）
  let hireWall = null;
  const hasButlers = partners.some((partner) => partner.id !== "chief");
  if (!hasButlers) {
    hireWall = document.createElement("div");
    hireWall.className = "card pt-hire is-loading";
    hireWall.innerHTML = `<p class="set-hint">招聘大厅…</p>`;
    box.append(hireWall);
  }
  for (const partner of partners) {
    const card = document.createElement("div");
    card.className = "card pt-card";
    const isChief = partner.id === "chief";
    const archived = partner.status === "archived";
    const nextStatus = partner.status === "active" ? "paused" : "active";
    const openProfile = () => {
      location.hash = `#/settings/partners/${encodeURIComponent(partner.id)}`;
    };
    // 整卡可点（2026-11-16）：头像 / 名字 / 留白都进同一份档案，卡面不再单独放编辑入口。
    // 用 div + role=button，不把 ⋯ 按钮包进 button（非法嵌套）。
    card.setAttribute("role", "button");
    card.tabIndex = 0;
    card.setAttribute("aria-label", `编辑「${partner.name || "执事"}」的人设`);
    // 卡片形状（2026-11-07 重排）：头像 + 名字/元信息在左，动作在右，一张卡两行。
    // active 不摆状态标签（默认态不值得占位），paused/archived 才标；状态圆点整列去掉。
    card.innerHTML = `
      <span class="pt-avatar pt-card-avatar" data-avatar-for="${attr(partner.id)}" aria-hidden="true"></span>
      <div class="pt-card-main">
        <div class="pt-card-name-row">
          <span class="row-label pt-name" data-tip="点击卡片打开这位执事的人设档案——人设、岗位、例行任务、技能都在里面。">${esc(partner.name || "")}</span>
          ${isChief && partner.name !== "总管" ? '<span class="pill-tag">总管</span>' : ""}
          ${partner.status === "active" ? "" : ptStatusPill(partner.status)}
        </div>
        <div class="pt-meta">
        </div>
      </div>
      <div class="pt-actions">
        <button class="pt-dots" type="button" data-pt-menu="${attr(partner.id)}"
                aria-haspopup="menu" aria-expanded="false"
                aria-label="${attr(`${partner.name || "执事"}的更多操作`)}" data-tip="更多操作">⋯</button>
      </div>`;
    box.append(card);
    // 头像只走 DOM 属性（不把 data URL 拼进 innerHTML）
    paintAvatar(
      card.querySelector("[data-avatar-for]"),
      partner.avatar || null,
      partner.name || "",
    );

    // 卡片自身可键盘聚焦：只有事件目标就是卡片时才吃 Enter/Space。
    // ⋯ 按钮上的按键（含 Space）让它自己处理，别把菜单操作变成跳转。
    card.addEventListener("click", (event) => {
      if (event.target instanceof Element && event.target.closest("button")) return;
      openProfile();
    });
    card.addEventListener("keydown", (event) => {
      if (event.target !== card) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault(); // Space 默认滚页
      openProfile();
    });

    // 卡头动作收进 ⋯（2026-11-15 用户口径：试跑/暂停不常驻，删除给入口）。
    // 菜单复用项目卡的 openProjMenu（挂 body + fixed，不吃容器的 overflow 裁切）。
    // 2026-11-16：整卡已可进档案，菜单去掉重复的「编辑这个人」。
    card.querySelector("[data-pt-menu]")?.addEventListener("click", (event) => {
      event.stopPropagation();
      const anchor = event.currentTarget;
      openProjMenu(anchor, [
        { label: "试跑", action: "run" },
        ...(archived ? [] : [{ label: partner.status === "active" ? "暂停" : "恢复", action: "toggle" }]),
        ...(isChief ? [] : [{ label: "删除执事", action: "delete", danger: true, separator: true }]),
      ], (action) => {
        if (action === "run") openRunPartnerModal(partner.id, partner.name || "");
        else if (action === "toggle") void ptTogglePartner(partner.id, nextStatus, null);
        else if (action === "delete") openDeletePartnerModal(partner);
      });
    });
  }
  if (hireWall) {
    renderHireWall(hireWall, (partnerId) => {
      void loadPartners();
      void loadRoster();
      location.hash = `#/settings/partners/${encodeURIComponent(partnerId)}`;
    });
  }
}

async function ptTogglePartner(id, nextStatus, button) {
  if (button) button.disabled = true;
  try {
    const response = await request(`/api/v1/partners/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ status: nextStatus }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) toast(`没切成：${data.message || data.error || response.status}`);
  } catch (error) {
    if (error.message !== "forbidden") toast(`没切成：${error.message}`);
  } finally {
    if (button) button.disabled = false;
    void loadPartners();
    void loadRoster(); // E4：侧栏花名册同步刷新
  }
}

/* ── 删除执事（2026-11-15 用户口径：列表卡 ⋯ 菜单给删除入口）──
   端点 DELETE /api/v1/partners/:id 早就有（连档案行/版本/会话链接/例行任务/群成员/家目录
   一起删），UI 一直没有入口。防误触照会话永久删除同一模式：输入名字确认。 */
function openDeletePartnerModal(partner) {
  openModal("删除执事", (body) => {
    body.innerHTML = `
      <p class="modal-desc">要把 <strong>${esc(partner.name || "")}</strong> 删掉。人设正文、岗位契约、
      口吻里子处境、技能、记忆、例行任务会跟着一起删，<strong>删了就找不回来</strong>。</p>
      <div class="modal-field">
        <span>输入他的名字确认</span>
        <input class="modal-input" id="pt-del-confirm" type="text" placeholder="${attr(partner.name || "")}" />
      </div>
      <p class="modal-hint" id="pt-del-hint"></p>
      <div class="modal-actions">
        <button class="ghost" type="button" data-modal-cancel>取消</button>
        <button class="modal-primary is-danger" id="pt-del-go" type="button" disabled>删除</button>
      </div>`;
    const input = body.querySelector("#pt-del-confirm");
    const hint = body.querySelector("#pt-del-hint");
    const go = body.querySelector("#pt-del-go");
    body.querySelector("[data-modal-cancel]")?.addEventListener("click", closeModal);
    const expected = String(partner.name || "").trim();
    input.addEventListener("input", () => {
      go.disabled = input.value.trim() !== expected;
      clearModalHint(hint);
    });
    go.addEventListener("click", async () => {
      if (go.disabled) return;
      go.disabled = true;
      setModalHint(hint, "删除中…", false);
      try {
        const response = await request(`/api/v1/partners/${encodeURIComponent(partner.id)}`, {
          method: "DELETE",
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          setModalHint(hint, data.message || data.error || `没删成：HTTP ${response.status}`, true);
          go.disabled = false;
          return;
        }
        closeModal();
        toast(`${partner.name || "执事"} 已删除`);
        // 正开着的档案页被删了就跳回列表，别留在一个已不存在的人的页面上
        if (location.hash === `#/settings/partners/${encodeURIComponent(partner.id)}`) {
          location.hash = "#/settings/partners";
        }
        void loadPartners();
        void loadRoster();
      } catch (error) {
        if (error.message === "forbidden") {
          closeModal();
          return;
        }
        setModalHint(hint, `没删成：${error.message}`, true);
        go.disabled = false;
      }
    });
  });
}

/* ── 新建执事模态（2026-11-15 二次重构：宽档 + 详细设置）──
 *
 * 用户口径：选模板 = 改个名字就能用；下面的详细设置（身份 / 口吻 / 里子 / 处境 / 契约）
 * 全部可选——选了模板就按模板预填，想改展开哪块改哪块；空白新建想细配也行。
 * 字段渲染与校验复用档案页的 PF_PERSONA_EDITORS / pfPersonaFieldMarkup / pfPersonaValue
 * （ESM 环：partner-profile 也 import 本文件，双方顶层只声明，运行时才互调）。
 * 提交统一走 applyTemplateChain 四步链：空白新建 = 一个空白伪模板。 */

const PT_BLANK_TPL = {
	id: "blank",
	card: "空白",
	preset: "work",
	modules: null,
	identity: "",
	contract: "",
	contents: null,
};

function openCreatePartnerModal() {
  openModal(
    "新建执事",
    (body) => {
      body.innerHTML = `
      <p class="modal-desc">挑个模板，改个名字就能用。下面的详细设置都是可选的——选了模板按模板填好，不改就入库。</p>
      <div class="pt-tpl-strip" id="pt-tpl-strip" hidden>
        <span class="pt-tpl-strip-label">从模板开始</span>
        ${PARTNER_TEMPLATES.map((tpl) => `<button class="pt-tpl-chip" type="button" data-pt-tpl="${attr(tpl.id)}" data-tip="${attr(tpl.desc)}">${esc(tpl.card)}</button>`).join("")}
      </div>
      <div class="modal-field">
        <span>名字（≤40 字）</span>
        <input class="modal-input" id="pt-new-name" type="text" maxlength="40" placeholder="例如：小助手" />
      </div>
      <p class="pf-group-title">详细设置（可选）</p>
      <details class="pf-new">
        <summary>${chevSvg("pf-new-chev chev")}<span>一句话身份</span></summary>
        <textarea class="pt-ta" id="pt-new-identity" rows="2" spellcheck="false"
                  placeholder="例如：你是替我整理资料的安静助手"></textarea>
      </details>
      <details class="pf-new">
        <summary>${chevSvg("pf-new-chev chev")}<span>口吻</span></summary>
        <div class="pf-edit-grid" id="pt-new-style"></div>
      </details>
      <details class="pf-new">
        <summary>${chevSvg("pf-new-chev chev")}<span>里子</span></summary>
        <div class="pf-edit-grid" id="pt-new-values"></div>
      </details>
      <details class="pf-new">
        <summary>${chevSvg("pf-new-chev chev")}<span>处境</span></summary>
        <div class="pf-edit-grid" id="pt-new-scenario"></div>
      </details>
      <details class="pf-new">
        <summary>${chevSvg("pf-new-chev chev")}<span>岗位契约</span></summary>
        <textarea class="pf-contract" id="pt-new-contract" rows="6" spellcheck="false" aria-label="岗位契约"
                  placeholder="写清管什么、怎么定、怎么验收、向谁汇报（四节）"></textarea>
      </details>
      <p class="modal-hint" id="pt-new-hint"></p>
      <div class="modal-actions">
        <button class="ghost" type="button" data-modal-cancel>取消</button>
        <button class="modal-primary" id="pt-new-go" type="button">新建</button>
      </div>`;

      const nameInput = body.querySelector("#pt-new-name");
      const identityInput = body.querySelector("#pt-new-identity");
      const contractInput = body.querySelector("#pt-new-contract");
      const hint = body.querySelector("#pt-new-hint");
      const go = body.querySelector("#pt-new-go");
      const strip = body.querySelector("#pt-tpl-strip");
      body.querySelector("[data-modal-cancel]")?.addEventListener("click", closeModal);

      // 详细设置三块的字段渲染（pf-edit-grid 同款）；选模板时按模板 current 重渲染。
      const paintBlock = (gridId, editorKey, current) => {
        const grid = body.querySelector(`#${gridId}`);
        const editor = PF_PERSONA_EDITORS[editorKey];
        grid.innerHTML = editor.fields.map((field) => pfPersonaFieldMarkup(field, current ?? {})).join("");
      };
      paintBlock("pt-new-style", "style", null);
      paintBlock("pt-new-values", "values", null);
      paintBlock("pt-new-scenario", "scenario", null);

      // 模板条。选中 = 名字/身份/口吻里子处境/契约全按模板预填，提交走四步链；
      // 再点一次同一张卡 = 取消选择，回空白。（开关 2026-11-21 退役，条恒显示。）
      let selectedTpl = null;
      strip.hidden = false;
      strip.addEventListener("click", (event) => {
        const chip = event.target.closest("[data-pt-tpl]");
        if (!chip) return;
        const tpl = PARTNER_TEMPLATES.find((item) => item.id === chip.dataset.ptTpl);
        if (!tpl) return;
        if (selectedTpl?.id === tpl.id) {
          selectedTpl = null;
          chip.setAttribute("aria-pressed", "false");
          return;
        }
        selectedTpl = tpl;
        for (const other of strip.querySelectorAll("[data-pt-tpl]")) {
          other.setAttribute("aria-pressed", String(other === chip));
        }
        if (tpl.name && !nameInput.value.trim()) nameInput.value = tpl.name;
        identityInput.value = tpl.identity;
        paintBlock("pt-new-style", "style", tpl.contents?.style ?? null);
        paintBlock("pt-new-values", "values", tpl.contents?.values ?? null);
        paintBlock("pt-new-scenario", "scenario", tpl.contents?.scenario ?? null);
        contractInput.value = tpl.contract ?? "";
        setModalHint(
          hint,
          `已选「${tpl.card}」：详细设置按模板填好了，不改就入库；要改展开对应块。`,
          false,
        );
      });

      // 收集一个内容块：有非空值的块返回 values（供覆盖），全空返回 null（不设）。
      const collectBlock = (gridId, editorKey) => {
        const grid = body.querySelector(`#${gridId}`);
        const fields = PF_PERSONA_EDITORS[editorKey].fields;
        const values = {};
        let hasAny = false;
        for (const field of fields) {
          const node = grid.querySelector(`[data-pf-field="${field.key}"]`);
          if (!node) continue;
          const parsed = pfPersonaValue(field, node.value);
          if (parsed.problem) {
            setModalHint(hint, parsed.problem, true);
            node.focus();
            return { problem: parsed.problem };
          }
          values[field.key] = parsed.value;
          const v = parsed.value;
          const filled = Array.isArray(v)
            ? v.length > 0
            : v !== undefined && String(v ?? "").trim() !== "" && String(v) !== "不限";
          if (filled) hasAny = true;
        }
        return hasAny ? { value: values } : { value: null };
      };

      const submit = async () => {
        if (go.disabled) return;
        const name = nameInput.value.trim();
        if (!name) { setModalHint(hint, "先起个名字。"); nameInput.focus(); return; }
        const identity = identityInput.value.trim();
        const contract = contractInput.value.trim();
        const style = collectBlock("pt-new-style", "style");
        if (style.problem) return;
        const values = collectBlock("pt-new-values", "values");
        if (values.problem) return;
        const scenario = collectBlock("pt-new-scenario", "scenario");
        if (scenario.problem) return;
        const contentsOverride = {};
        if (style.value) contentsOverride.style = style.value;
        if (values.value) contentsOverride.values = values.value;
        if (scenario.value) contentsOverride.scenario = scenario.value;
        const hasDetail =
          Boolean(identity) || Boolean(contract) || Object.keys(contentsOverride).length > 0;

        go.disabled = true;
        setModalHint(hint, "创建中…", false);
        try {
          const tpl = selectedTpl ?? PT_BLANK_TPL;
          // 四步链统一入口：模板走模板值 + 弹窗覆盖；空白走 work 预设 + 弹窗内容（有才发）。
          await applyTemplateChain(tpl, name, {
            soulOverride: identity,
            contentsOverride,
            contractOverride: contract,
          });
          closeModal();
          toast(hasDetail ? "执事已新建，人格已套上" : "执事已新建");
          void loadPartners();
          void loadRoster(); // E4：侧栏花名册同步刷新
        } catch (error) {
          if (error.message === "forbidden") { closeModal(); return; }
          setModalHint(hint, `没建成：${error.message}`);
        } finally {
          go.disabled = false;
        }
      };
      go.addEventListener("click", () => void submit());
      nameInput.addEventListener("input", () => clearModalHint(hint));
      nameInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") { event.preventDefault(); void submit(); }
      });
    },
    { className: "modal-wide" },
  );
}

/* ── 编辑执事模态（人设（含头像）/ 模型候选链 / 例行任务）──
 *
 * 2026-11-07 用户口径：**头像属于人设的一部分**——头像就是这个角色的脸，SOUL 是它的内核，
 * 两件事说的是同一个"你是谁"，不该在设置里分成两个入口（原来头像单开一个分区，
 * 用户得先在「头像」页选对象、再来「执事」页编辑）。
 * 所以：编辑弹窗里头像与 SOUL 合并成「人设」一段，头像在上、正文在下，同一次"保存人设"提交；
 * 弹窗加宽到 760px（原来 420px，SOUL 一列只能显示 30 来个字宽，长文很难读）。 */

const PARTNER_MODAL_CLASS = "modal-wide";

async function openEditPartnerModal(partnerId) {
  let detail;
  try {
    const response = await request(`/api/v1/partners/${encodeURIComponent(partnerId)}`, { cache: "no-store" });
    detail = await response.json().catch(() => ({}));
    if (!response.ok || !detail.ok) { toast("读不到执事详情"); return; }
  } catch (error) {
    if (error.message !== "forbidden") toast(`读不到执事详情：${error.message}`);
    return;
  }
  const name = String(detail.partner?.name || "").trim();
  openModal(name ? `人设 · ${name}` : "人设", (body) => ptBuildEditModal(body, partnerId, detail), {
    className: PARTNER_MODAL_CLASS,
  });
}

function ptBuildEditModal(body, partnerId, detail) {
  const partner = detail.partner || {};
  const soul = String(detail.soul ?? "");
  const chain = Array.isArray(detail.modelChain) ? detail.modelChain : [];
  body.innerHTML = `
    <div class="pt-edit">
      <!-- 人设（2026-11-07 合并）：头像 + SOUL 说的是同一件事「你是谁」。
           头部一行 = 头像（点开下拉选预设或本地文件）+ 说明 + 版本号，正文吃满宽度；
           一次「保存人设」同时提交 avatar 与 soul（PATCH 同对象，服务端本来就支持多槽位）。 -->
      <div class="pt-seg pt-instr">
        <div class="pt-instr-top">
          <button class="pt-avatar avatar-edit pt-portrait-btn" id="pt-avatar-preview" type="button"
                  aria-label="更换头像" title="更换头像" aria-haspopup="dialog" aria-expanded="false">
            <span class="pt-portrait-chev" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
            </span>
          </button>
          <div class="pt-instr-meta">
            <span class="pt-instr-label">它是谁、怎么说话、守什么规矩</span>
            <span class="pt-instr-sub" id="pt-portrait-caption">点头像换一张：30 张预设或本地图片</span>
          </div>
        </div>
        <textarea class="pt-ta is-soul" id="pt-soul" rows="6" spellcheck="false"
                  aria-label="人设正文"
                  placeholder="例：你叫阿岚，是这个家的管事。说话短、先给结论；不确定就直说，不要编。">${esc(soul)}</textarea>
        <p class="modal-hint" id="pt-instr-hint">头像和这段正文一起保存，下一轮起用。</p>
        <div class="pt-actions">
          <button class="ghost" id="pt-instr-reset" type="button" disabled>撤销改动</button>
          <button class="btn-primary" id="pt-instr-save" type="button" disabled>保存人设</button>
        </div>
      </div>

      <div class="pt-seg pt-basic">
        <div class="pt-seg-head">
          <span class="pt-seg-title">名字与领域</span>
          <span class="kv">领域只是备注，可留空、可改</span>
        </div>
        <div class="pt-basic-row">
          <label class="modal-field">
            <span>名字</span>
            <div class="modal-row">
              <input class="modal-input" id="pt-name" type="text" maxlength="40" value="${attr(partner.name || "")}" />
              <button class="ghost" id="pt-name-save" type="button">改名</button>
            </div>
          </label>
          <label class="modal-field">
            <span>领域标签（可选）</span>
            <div class="modal-row">
                     placeholder="留空也行，不影响派活" />
            </div>
          </label>
        </div>
        <p class="set-hint">领域只是一句备注（例如 frontend、写作），用来在任务列表里区分活是谁的。留空照样能派活。</p>
      </div>

      <div class="pt-seg">
        <div class="pt-seg-head">
          <span class="pt-seg-title">备选模型</span>
          <span class="kv">最多 5 条 · 只存变量名</span>
        </div>
        <p class="set-hint">只在试跑与例行任务轮次里生效：那一轮没应答且原因可切（超时 / 5xx / 限流 / 鉴权 / 模型下线）时，按顺序换下一条重跑；不改变主对话。</p>
        <div id="pt-chain-editor"></div>
      </div>

      <div class="pt-seg">
        <div class="pt-seg-head">
          <span class="pt-seg-title">定时任务</span>
          <button class="ghost" id="pt-routine-refresh" type="button">刷新</button>
        </div>
        <div class="pt-routine-list" id="pt-routine-list"><div class="set-hint">读取中…</div></div>
        ${ptRoutineFormMarkup()}
      </div>
    </div>`;

  const nameInput = body.querySelector("#pt-name");
  body.querySelector("#pt-name-save")?.addEventListener("click", () => void ptSaveName(partnerId, nameInput));

  void ptWireInstructionEditor(body, partnerId, partner, soul);

  // 备选链与抽屉的「模型 → 备选模型」共用同一个编辑器（2026-11-07）：
  // 两处都是「从已有模型里选」，不再手打 providerId|modelId|KEY_ENV。
  mountChainEditor(body.querySelector("#pt-chain-editor"), {
    partnerId,
    chain,
    onSaved: (next) => {
      if (cs.detail && cs.target === partnerId) cs.detail.modelChain = next;
    },
  });

  const listBox = body.querySelector("#pt-routine-list");
  body.querySelector("#pt-routine-refresh")?.addEventListener("click", () => void ptRenderRoutineList(listBox, partnerId));
  ptWireRoutineForm(body, partnerId, listBox);
  void ptRenderRoutineList(listBox, partnerId);
}

export { PARTNER_MODAL_CLASS, PT_RUN_STATUS, PT_STATUS, loadPartners, openCreatePartnerModal, openEditPartnerModal, ptBuildEditModal, ptHumanizeTrigger, ptStatusDot, ptStatusPill, ptTogglePartner, renderPartnerList };
