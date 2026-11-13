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
import { attr, esc } from "./markdown.js";
import { request } from "./net.js";
import { ptSaveName, ptWireInstructionEditor } from "./partner-editor.js";
import { openRunPartnerModal, ptRenderRoutineList, ptRoutineFormMarkup, ptWireRoutineForm } from "./partner-routines.js";
import { loadRoster, syncChiefAvatar } from "./partners-status.js";
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
  if (!partners.length) {
    const empty = document.createElement("div");
    empty.className = "card pt-empty";
    empty.innerHTML = `<p class="set-hint">还没有执事。新建一个，或给总管配个执事。</p>
      <button class="btn-primary" type="button" id="partner-empty-add">新建执事</button>`;
    box.append(empty);
    empty.querySelector("#partner-empty-add")?.addEventListener("click", () => openCreatePartnerModal());
    return;
  }
  for (const partner of partners) {
    const card = document.createElement("div");
    card.className = "card pt-card";
    const isChief = partner.id === "chief";
    const archived = partner.status === "archived";
    const nextStatus = partner.status === "active" ? "paused" : "active";
    // 卡片形状（2026-11-07 重排）：头像 + 名字/元信息在左，动作在右，一张卡两行。
    // 原来头像被塞在名字行里、标签和状态点又各占一个位置，一行里五个东西抢视线。
    card.innerHTML = `
      <span class="pt-avatar pt-card-avatar" data-avatar-for="${attr(partner.id)}" aria-hidden="true"></span>
      <div class="pt-card-main">
        <div class="pt-card-name-row">
          <span class="row-label pt-name">${esc(partner.name || "")}</span>
          ${isChief && partner.name !== "总管" ? '<span class="pill-tag">总管</span>' : ""}
          ${ptStatusPill(partner.status)}
          ${ptStatusDot(partner.status, partner.id)}
        </div>
        <div class="pt-meta">
          <span class="kv">人设 v${esc(String(partner.soulVersion ?? "—"))}</span>
          ${partner.domain ? `<span class="pt-domain kv">领域 · ${esc(String(partner.domain))}</span>` : ""}
        </div>
      </div>
      <div class="pt-actions">
        <button class="ghost" type="button" data-pt-edit="${attr(partner.id)}">改人设</button>
        <button class="ghost" type="button" data-pt-run="${attr(partner.id)}" data-pt-run-name="${attr(partner.name || "")}">试跑</button>
        ${archived ? "" : `<button class="ghost" type="button" data-pt-toggle="${attr(partner.id)}" data-pt-next="${attr(nextStatus)}">${partner.status === "active" ? "暂停" : "恢复"}</button>`}
      </div>`;
    box.append(card);
    // 头像只走 DOM 属性（不把 data URL 拼进 innerHTML）
    paintAvatar(
      card.querySelector("[data-avatar-for]"),
      partner.avatar || null,
      partner.name || "",
    );

    card.querySelector("[data-pt-edit]")?.addEventListener("click", () => void openEditPartnerModal(partner.id));
    card.querySelector("[data-pt-run]")?.addEventListener("click", () =>
      openRunPartnerModal(partner.id, partner.name || ""),
    );
    if (!archived) {
      card.querySelector("[data-pt-toggle]")?.addEventListener("click", () => {
        const button = card.querySelector("[data-pt-toggle]");
        void ptTogglePartner(partner.id, button.dataset.ptNext, button);
      });
    }
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

/* ── 新建执事模态 ────────────────────────────────────── */

function openCreatePartnerModal() {
  openModal("新建执事", (body) => {
    body.innerHTML = `
      <p class="modal-desc">给执事起个名字就行。领域只是一句备注，可以不填、以后也能改，不影响派活。</p>
      <div class="modal-field">
        <span>名字（≤40 字）</span>
        <input class="modal-input" id="pt-new-name" type="text" maxlength="40" placeholder="例如：小助手" />
      </div>
      <div class="modal-field">
        <span>领域标签（可选）</span>
        <input class="modal-input is-mono" id="pt-new-domain" type="text" spellcheck="false"
               placeholder="例如 frontend、写作；不填也行" />
      </div>
      <div class="modal-field">
        <span>一句话身份（可选）</span>
        <textarea class="pt-ta" id="pt-new-identity" rows="2" spellcheck="false"
                  placeholder="例如：你是替我整理资料的安静助手"></textarea>
      </div>
      <p class="modal-hint" id="pt-new-hint"></p>
      <div class="modal-actions">
        <button class="ghost" type="button" data-modal-cancel>取消</button>
        <button class="modal-primary" id="pt-new-go" type="button">新建</button>
      </div>`;

    const nameInput = body.querySelector("#pt-new-name");
    const domainInput = body.querySelector("#pt-new-domain");
    const identityInput = body.querySelector("#pt-new-identity");
    const hint = body.querySelector("#pt-new-hint");
    const go = body.querySelector("#pt-new-go");
    body.querySelector("[data-modal-cancel]")?.addEventListener("click", closeModal);

    const submit = async () => {
      if (go.disabled) return;
      const name = nameInput.value.trim();
      if (!name) { setModalHint(hint, "先起个名字。"); nameInput.focus(); return; }
      const domain = domainInput.value.trim();
      const identity = identityInput.value.trim();
      go.disabled = true;
      setModalHint(hint, "创建中…", false);
      try {
        const response = await request("/api/v1/partners", {
          method: "POST",
          // E2 #0：soul 随建档一次提交（后端 bumpSoul 落成 v2 自定义版本），
          // 收敛掉 E1「建完补 PATCH」的两段式；不带 identity 时请求形状与旧版一致。
          body: JSON.stringify({
            name,
            ...(domain ? { domain } : {}),
            ...(identity ? { soul: identity } : {}),
          }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          setModalHint(hint, data.message || data.error || `没建成：HTTP ${response.status}`);
          return;
        }
        closeModal();
        toast("执事已新建");
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
  });
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
          <span class="kv" id="pt-soul-version">人设 v${esc(String(detail.soulVersion ?? "—"))}</span>
        </div>
        <textarea class="pt-ta is-soul" id="pt-soul" rows="6" spellcheck="false"
                  aria-label="人设正文"
                  placeholder="例：你叫阿岚，是这个家的管事。说话短、先给结论；不确定就直说，不要编。">${esc(soul)}</textarea>
        <p class="modal-hint" id="pt-instr-hint">头像和这段正文一起保存，作为新版本生效（下一轮起用）。</p>
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
              <input class="modal-input is-mono" id="pt-domain" type="text" value="${attr(partner.domain || "")}"
                     placeholder="留空也行，不影响派活" />
              <button class="ghost" id="pt-domain-save" type="button">保存</button>
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
          <span class="pt-seg-title">例行任务</span>
          <button class="ghost" id="pt-routine-refresh" type="button">刷新</button>
        </div>
        <div class="pt-routine-list" id="pt-routine-list"><div class="set-hint">读取中…</div></div>
        ${ptRoutineFormMarkup()}
      </div>
    </div>`;

  const nameInput = body.querySelector("#pt-name");
  body.querySelector("#pt-name-save")?.addEventListener("click", () => void ptSaveName(partnerId, nameInput));

  // 领域标签（2026-11-07）：可留空、可改。空串 = 清掉标签（回到"普通执事"）。
  const domainInput = body.querySelector("#pt-domain");
  body.querySelector("#pt-domain-save")?.addEventListener("click", () => {
    void (async () => {
      const value = String(domainInput?.value || "").trim();
      const res = await request(`/api/v1/partners/${encodeURIComponent(partnerId)}`, {
        method: "PATCH",
        body: JSON.stringify({ domain: value }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        addNotice(data.message || "领域标签没保存成功。");
        return;
      }
      partner.domain = value || null;
      addNotice(value ? `领域标签已改成 ${value}。` : "领域标签已清空，不影响派活。");
    })();
  });

  void ptWireInstructionEditor(body, partnerId, partner, soul, detail.soulVersion ?? null);

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
