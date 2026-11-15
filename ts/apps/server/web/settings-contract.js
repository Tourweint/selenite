/**
 * 岗位契约 / 当前目标
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { request } from "./net.js";
import { cs, csCard } from "./settings-drawer.js";

/* ── 岗位契约 / 当前目标编辑卡（2026-11-08 员工人格化刀三）──────────────
 * 照 SOUL 卡同一套 csCard / cs-field / cs-textarea.is-soul / cs-hint / cs-actions 模式，
 * 不引新类、不加全局样式。服务端能力刀一 / 刀二已就绪，这里只做界面：
 *   PUT   /api/v1/partners/:id/contract       → { ok, contract, contractVersion }
 *   PATCH /api/v1/partners/:id { currentGoal } → { ok, partner, currentGoal }
 * detail 只在 PARTNER_CONTRACT 开时带 contract / contractVersion 两列；关掉
 * （或 PUT 回 400「未启用」）时降级为同一段只读提示，不摆编辑器。
 * 两卡各自独立保存（不与人设卡共用一次 PATCH），保存只就地改 DOM、不整体重画，
 * 其它卡里没提交的草稿不会被冲掉。
 */

const CS_CONTRACT_DESC = "调岗用：职责/决策分级/验收标准/汇报对象，改完下一轮生效";
const CS_CONTRACT_OFF = "岗位契约未启用（PARTNER_CONTRACT=false），暂不可编辑。";
// 四节标题逐字照服务端固定小节；新建执事播种的就是只有这四节标题的空模板。
const CS_CONTRACT_TEMPLATE =
  "## 职责范围\n管什么、不管什么\n\n" +
  "## 决策分级\n哪些自己定 / 哪些办完通知 / 哪些必须先申请\n\n" +
  "## 验收标准\n交给他的活怎么算好\n\n" +
  "## 汇报对象\n向谁汇报、周期是什么";

/** 开关关 / PUT 400「未启用」时的只读降级卡：与 detail 无契约列的空态合并为同一份 */
function csContractDisabledCard() {
  const card = csCard("岗位契约");
  const desc = document.createElement("div");
  desc.className = "cs-hint";
  desc.style.padding = "0 14px";
  desc.textContent = CS_CONTRACT_DESC;
  const note = document.createElement("p");
  note.className = "cs-note";
  note.style.padding = "0 14px 12px";
  note.textContent = CS_CONTRACT_OFF;
  card.append(desc, note);
  return card;
}

function appendCsContractCard(body) {
  // detail 无契约列（PARTNER_CONTRACT=false）：空态 = 只读提示，不摆编辑器
  if (!("contract" in cs.detail)) {
    body.append(csContractDisabledCard());
    return;
  }

  const contract = String(cs.detail.contract ?? "");

  const card = csCard("岗位契约");
  const desc = document.createElement("div");
  desc.className = "cs-hint";
  desc.style.padding = "0 14px";
  desc.textContent = CS_CONTRACT_DESC;
  card.append(desc);

  const field = document.createElement("div");
  field.className = "cs-field";
  const area = document.createElement("textarea");
  area.className = "cs-textarea is-soul";
  area.id = "cs-persona-contract";
  area.rows = 8;
  area.spellcheck = false;
  area.value = contract;
  area.style.minHeight = "168px";
  area.style.fontFamily = "inherit";
  area.style.fontSize = "13px";
  area.style.lineHeight = "1.7";
  area.setAttribute("aria-label", "岗位契约正文");
  area.placeholder = CS_CONTRACT_TEMPLATE;
  field.append(area);
  card.append(field);

  const versionNode = document.createElement("div");
  versionNode.className = "cs-hint";
  versionNode.style.padding = "0 14px";
  // 快照退役（2026-11-15）：不再展示版本号，只说生效时机
  versionNode.textContent = "下一轮生效";
  card.append(versionNode);

  const hint = document.createElement("div");
  hint.className = "cs-hint";
  hint.id = "cs-persona-contract-hint";
  hint.style.padding = "0 14px";
  card.append(hint);

  const actions = document.createElement("div");
  actions.className = "cs-actions";
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "ghost";
  reset.id = "cs-persona-contract-reset";
  reset.textContent = "撤销改动";
  reset.disabled = true;
  const save = document.createElement("button");
  save.type = "button";
  save.className = "btn-primary";
  save.id = "cs-persona-contract-save";
  save.textContent = "保存";
  save.disabled = true;
  actions.append(reset, save);
  card.append(actions);
  body.append(card);

  let original = contract;
  let saving = false;
  const isDirty = () => area.value !== original;
  const refresh = () => {
    const dirty = isDirty();
    save.disabled = saving || !dirty;
    reset.disabled = saving || !dirty;
    area.disabled = saving;
  };
  const setHint = (text, isError) => {
    hint.textContent = text;
    hint.classList.toggle("is-error", Boolean(isError));
  };
  refresh();

  area.addEventListener("input", () => {
    setHint("");
    refresh();
  });
  reset.addEventListener("click", () => {
    area.value = original;
    setHint("");
    refresh();
  });

  save.addEventListener("click", async () => {
    if (saving) return;
    const next = area.value;
    saving = true;
    refresh();
    setHint("保存中…", false);
    try {
      const response = await request(
        `/api/v1/partners/${encodeURIComponent(cs.target)}/contract`,
        { method: "PUT", body: JSON.stringify({ contract: next }) },
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        // 开关在两次请求之间被关掉：降级为只读提示，与 detail 无契约列的空态同一份
        if (response.status === 400 && String(data.message || "").includes("未启用")) {
          delete cs.detail.contract;
          delete cs.detail.contractVersion;
          card.replaceWith(csContractDisabledCard());
          return;
        }
        // 64KB 超限等：服务端中文文案原样透出
        setHint(data.message || data.error || `没存成：HTTP ${response.status}`, true);
        return;
      }
      original = next;
      cs.detail.contract = data.contract ?? next;
      cs.detail.contractVersion = data.contractVersion ?? cs.detail.contractVersion;
      versionNode.textContent = "下一轮生效";
      setHint("已保存，下一轮生效。", false);
      refresh();
    } catch (error) {
      if (error.message === "forbidden") return;
      setHint(`没存成：${error.message}`, true);
    } finally {
      saving = false;
      refresh();
    }
  });
}

function appendCsGoalCard(body) {
  const goal = cs.detail.currentGoal != null ? String(cs.detail.currentGoal) : "";
  const card = csCard("当前目标");
  const desc = document.createElement("div");
  desc.className = "cs-hint";
  desc.style.padding = "0 14px";
  desc.textContent = "现在在奔什么；下次对话生效，留空保存 = 清除目标";
  card.append(desc);

  const field = document.createElement("div");
  field.className = "cs-field";
  const input = document.createElement("input");
  input.className = "cs-input";
  input.id = "cs-persona-goal";
  input.type = "text";
  input.maxLength = 1000;
  input.value = goal;
  input.placeholder = "这阵子在奔什么？留空=无目标";
  input.setAttribute("aria-label", "当前目标");
  field.append(input);
  card.append(field);

  const hint = document.createElement("div");
  hint.className = "cs-hint";
  hint.id = "cs-persona-goal-hint";
  hint.style.padding = "0 14px";
  card.append(hint);

  const actions = document.createElement("div");
  actions.className = "cs-actions";
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "ghost";
  reset.id = "cs-persona-goal-reset";
  reset.textContent = "撤销改动";
  reset.disabled = true;
  const save = document.createElement("button");
  save.type = "button";
  save.className = "btn-primary";
  save.id = "cs-persona-goal-save";
  save.textContent = "保存";
  save.disabled = true;
  actions.append(reset, save);
  card.append(actions);
  body.append(card);

  let original = goal;
  let saving = false;
  const isDirty = () => input.value !== original;
  const refresh = () => {
    const dirty = isDirty();
    save.disabled = saving || !dirty;
    reset.disabled = saving || !dirty;
    input.disabled = saving;
  };
  const setHint = (text, isError) => {
    hint.textContent = text;
    hint.classList.toggle("is-error", Boolean(isError));
  };
  refresh();

  input.addEventListener("input", () => {
    setHint("");
    refresh();
  });
  reset.addEventListener("click", () => {
    input.value = original;
    setHint("");
    refresh();
  });

  save.addEventListener("click", async () => {
    if (saving) return;
    const next = input.value;
    saving = true;
    refresh();
    setHint("保存中…", false);
    try {
      // 空串 = 清除目标（服务端 trim 后存 null）；目标不版本化，现取现用
      const response = await request(`/api/v1/partners/${encodeURIComponent(cs.target)}`, {
        method: "PATCH",
        body: JSON.stringify({ currentGoal: next }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setHint(data.message || data.error || `没存成：HTTP ${response.status}`, true);
        return;
      }
      original = next;
      if ("currentGoal" in data) cs.detail.currentGoal = data.currentGoal;
      // 目标不版本化：成功提示不写版本号
      setHint("已保存，下次对话起生效。", false);
      refresh();
    } catch (error) {
      if (error.message === "forbidden") return;
      setHint(`没存成：${error.message}`, true);
    } finally {
      saving = false;
      refresh();
    }
  });
}

export { CS_CONTRACT_DESC, CS_CONTRACT_OFF, CS_CONTRACT_TEMPLATE, appendCsContractCard, appendCsGoalCard, csContractDisabledCard };
