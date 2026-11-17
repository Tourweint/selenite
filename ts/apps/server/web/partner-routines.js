/**
 * 例行任务 + 试跑
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 2026-11-17 定时任务重做：例行列表与提醒共用 renderScheduledTaskList（同一套行/动作/历史），
 * 新建走 openScheduledTaskModal —— 不再暴露 cron / interval / once / event 原始字段。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { attr, esc } from "./markdown.js";
import { request } from "./net.js";
import { PT_RUN_STATUS, openEditPartnerModal, ptHumanizeTrigger } from "./partner-modals.js";
import { clearModalHint, setModalHint } from "./project-modal.js";
import { mountSegmented, syncSegmented } from "./settings-atoms.js";
import {
  openScheduledTaskModal,
  reminderTaskItem,
  renderScheduledTaskList,
  routineTaskItem,
} from "./settings-reminders.js";
import { state } from "./state.js";
import { closeModal, openModal, toast } from "./ui-atoms.js";


/* ── 例行任务（编辑模态第三段）───────────────────────── */

function ptRoutineFormMarkup() {
  return `
    <div class="pt-new">
      <div class="pt-seg-title">新建定时任务</div>
      <p class="set-hint">到点后 TA 会拿你写的指令自己跑一轮；内容、时间、暂停都能创建后再改。</p>
      <div class="pt-actions">
        <button class="btn-primary" id="pt-r-new" type="button">手动设置</button>
      </div>
    </div>`;
}

function ptWireRoutineForm(body, partnerId, listBox, options = {}) {
  body.querySelector("#pt-r-new")?.addEventListener("click", () => {
    openScheduledTaskModal({ mode: "create", partnerId, lockPartner: true }, () => {
      // 编辑器会替换当前弹层：有回调就交回调用方重开任务清单，没有就退回旧的重拉列表。
      if (typeof options.onChanged === "function") options.onChanged();
      else void ptRenderRoutineList(listBox, partnerId);
    });
  });
}

// 2026-11-17：旧页内表单（cron/interval/once/event 原文）退役，统一走 openScheduledTaskModal。
// 以下 ptCreateRoutine 不再有调用点，暂留只为旧引用不炸；不要在新代码里接它。
async function ptCreateRoutine(body, partnerId, listBox, hint) {
  const name = body.querySelector("#pt-r-name")?.value.trim() || "";
  const prompt = body.querySelector("#pt-r-prompt")?.value || "";
  const type = body.querySelector("#pt-r-trigger [data-trigger][aria-checked='true']")?.dataset.trigger || "cron";
  const fresh = body.querySelector("#pt-r-mode")?.getAttribute("aria-checked") === "true";
  const sessionMode = fresh ? "fresh" : "persistent";

  if (!name) { setModalHint(hint, "先给例行任务起个名字。"); return; }
  if (!prompt.trim()) { setModalHint(hint, "指令 prompt 不能为空。"); return; }

  let trigger;
  if (type === "cron") {
    const expr = (body.querySelector("#pt-r-cron")?.value || "").trim();
    if (expr.split(/\s+/).length !== 5) { setModalHint(hint, "cron 要 5 段：分 时 日 月 周"); return; }
    trigger = { type: "cron", expr };
  } else if (type === "interval") {
    const seconds = Number(body.querySelector("#pt-r-interval")?.value);
    if (!Number.isFinite(seconds) || seconds < 60) { setModalHint(hint, "间隔秒数至少 60"); return; }
    trigger = { type: "interval", seconds };
  } else if (type === "once") {
    const raw = body.querySelector("#pt-r-once")?.value || "";
    const at = new Date(raw);
    if (!raw || Number.isNaN(at.getTime())) { setModalHint(hint, "选一个合法时间"); return; }
    trigger = { type: "once", at: at.toISOString() };
  } else {
    const kind = body.querySelector("#pt-r-kind")?.value || "delegation";
    const matchText = (body.querySelector("#pt-r-match")?.value || "").trim();
    trigger = { type: "event", kind };
    if (matchText) {
      const match = {};
      for (const pair of matchText.split(",")) {
        const index = pair.indexOf("=");
        if (index > 0) match[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
      }
      if (Object.keys(match).length) trigger.match = match;
    }
  }

  const button = body.querySelector("#pt-r-create");
  if (button) button.disabled = true;
  setModalHint(hint, "新建中…", false);
  try {
    const response = await request("/api/v1/routines", {
      method: "POST",
      body: JSON.stringify({ partnerId, name, prompt, triggers: [trigger], sessionMode }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { setModalHint(hint, data.message || data.error || `没建成：HTTP ${response.status}`); return; }
    setModalHint(hint, "", false);
    toast("例行任务已新建");
    const nameNode = body.querySelector("#pt-r-name");
    const promptNode = body.querySelector("#pt-r-prompt");
    if (nameNode) nameNode.value = "";
    if (promptNode) promptNode.value = "";
    void ptRenderRoutineList(listBox, partnerId);
  } catch (error) {
    if (error.message === "forbidden") { closeModal(); return; }
    setModalHint(hint, `没建成：${error.message}`);
  } finally {
    if (button) button.disabled = false;
  }
}

async function ptRenderRoutineList(box, partnerId, options = {}) {
  if (!box) return;
  try {
    const [routinesResponse, remindersResponse] = await Promise.all([
      request(`/api/v1/routines?partnerId=${encodeURIComponent(partnerId)}`, { cache: "no-store" }),
      request("/api/v1/agent/reminders?includePaused=1", { cache: "no-store" }).catch(() => null),
    ]);
    const routinesData = await routinesResponse.json().catch(() => ({}));
    if (!routinesResponse.ok) throw new Error(String(routinesResponse.status));
    const remindersData = remindersResponse ? await remindersResponse.json().catch(() => ({})) : {};
    const nameById = new Map(
      (state.partners || []).map((entry) => [entry.id, entry.name || entry.id]),
    );
    const routines = Array.isArray(routinesData.routines) ? routinesData.routines : [];
    const reminders = (Array.isArray(remindersData.reminders) ? remindersData.reminders : []).filter(
      (reminder) => {
        if (reminder.status === "terminal") return false;
        if (partnerId === "chief") return !reminder.partnerId || reminder.partnerId === "chief";
        return reminder.partnerId === partnerId;
      },
    );
    const items = [
      ...routines.map((routine) => routineTaskItem(routine, nameById)),
      ...reminders.map((reminder) => reminderTaskItem(reminder, nameById)),
    ];
    renderScheduledTaskList(box, items, {
      showFilter: false,
      emptyText: "还没有定时任务",
      onChanged:
        typeof options.onChanged === "function"
          ? options.onChanged
          : () => {
              void ptRenderRoutineList(box, partnerId, options);
              if (typeof options.onDone === "function") options.onDone();
            },
    });
    if (typeof options.onCount === "function") options.onCount(items.length);
  } catch (error) {
    if (error.message === "forbidden") return;
    box.innerHTML = `<div class="set-hint is-error">读不到定时任务：${esc(error.message)}</div>`;
  }
}

async function ptToggleRoutine(id, sw) {
  const next = sw.getAttribute("aria-checked") !== "true";
  sw.disabled = true;
  try {
    const response = await request(`/api/v1/routines/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: next }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { toast(`没切换：${data.message || data.error || response.status}`); return; }
    sw.setAttribute("aria-checked", String(next));
  } catch (error) {
    if (error.message !== "forbidden") toast(`没切换：${error.message}`);
  } finally {
    sw.disabled = false;
  }
}

async function ptRunNow(id, button, runsBox) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "跑中…";
  try {
    const response = await request(`/api/v1/routines/${encodeURIComponent(id)}/run_now`, { method: "POST" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      toast(`没跑成：${data.error || data.message || response.status}`);
    } else {
      toast("已跑完一轮");
      if (runsBox) await ptLoadRuns(id, runsBox, true);
    }
  } catch (error) {
    if (error.message !== "forbidden") toast(`没跑成：${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function ptToggleHistory(id, button, runsBox) {
  if (!runsBox) return;
  if (!runsBox.hidden) {
    runsBox.hidden = true;
    button.textContent = "展开历史";
    return;
  }
  button.textContent = "收起";
  await ptLoadRuns(id, runsBox, true);
}

async function ptLoadRuns(id, box, show) {
  if (show) box.hidden = false;
  box.innerHTML = `<div class="set-hint">读取中…</div>`;
  try {
    const response = await request(`/api/v1/routines/${encodeURIComponent(id)}/runs`, { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(String(response.status));
    const runs = (data.runs || []).slice(0, 10);
    if (!runs.length) { box.innerHTML = `<div class="set-hint">还没有执行记录。</div>`; return; }
    box.innerHTML = runs
      .map((run) => {
        const info = PT_RUN_STATUS[run.status] || { text: run.status || "未知", cls: "" };
        const summary = String(run.summary || run.error || "").slice(0, 80);
        const at = run.endedAt || run.startedAt;
        const time = at ? new Date(at).toLocaleString("zh-CN") : "";
        return `<div class="pt-run">
          <span class="pill-tag ${info.cls}">${esc(info.text)}</span>
          <span class="pt-run-trigger">${esc(String(run.trigger || ""))}</span>
          <span class="pt-run-summary">${esc(summary)}</span>
          <span class="pt-run-time">${esc(time)}</span>
        </div>`;
      })
      .join("");
  } catch (error) {
    if (error.message === "forbidden") return;
    box.innerHTML = `<div class="set-hint is-error">读不到历史：${esc(error.message)}</div>`;
  }
}

function ptConfirmDeleteRoutine(partnerId, routineId, name, options = {}) {
  // 单一 modal 宿主：确认弹层会替换编辑模态，答复后要「回到编辑面」。
  // 2026-11-14：编辑面从弹窗换成二级页之后，回跳动作由调用方给（onDone），
  // 没给就退回落旧行为（重开编辑弹窗），弹窗自己那条路径不断。
  const onDone = typeof options.onDone === "function" ? options.onDone : null;
  const finish = () => {
    if (!onDone) {
      void openEditPartnerModal(partnerId);
      return;
    }
    closeModal();
    onDone();
  };
  openModal("删除例行任务", (body) => {
    body.innerHTML = `
      <p class="modal-desc">确定删除「${esc(name)}」？在飞的任务会自动作废（没有取消 API，不残留）。</p>
      <div class="modal-actions">
        <button class="ghost" type="button" data-modal-cancel>取消</button>
        <button class="modal-danger" type="button" id="pt-del-go">删除</button>
      </div>`;
    body.querySelector("[data-modal-cancel]")?.addEventListener("click", finish);
    body.querySelector("#pt-del-go")?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const response = await request(`/api/v1/routines/${encodeURIComponent(routineId)}`, { method: "DELETE" });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          toast(`没删成：${data.message || data.error || response.status}`);
          button.disabled = false;
          return;
        }
        toast("已删除");
        finish();
      } catch (error) {
        if (error.message === "forbidden") { closeModal(); return; }
        toast(`没删成：${error.message}`);
        button.disabled = false;
      }
    });
  });
}

/* ── 试跑（执事卡动作 #3）───────────────────────────── */

function openRunPartnerModal(partnerId, partnerName) {
  openModal(`试跑 · ${partnerName || "执事"}`, (body) => {
    body.innerHTML = `
      <p class="modal-desc">给这个执事发一句话，走完整链路跑一轮；faux 下会拿到假模型应答。</p>
      <div class="modal-field">
        <span>说一句</span>
        <input class="modal-input" id="pt-run-text" type="text" placeholder="例如：帮我记一句今天的事" />
      </div>
      <pre class="pt-result" id="pt-run-result" hidden></pre>
      <p class="modal-hint" id="pt-run-hint"></p>
      <div class="modal-actions">
        <button class="ghost" type="button" data-modal-cancel>关闭</button>
        <button class="modal-primary" id="pt-run-go" type="button">运行</button>
      </div>`;
    const textInput = body.querySelector("#pt-run-text");
    const result = body.querySelector("#pt-run-result");
    const hint = body.querySelector("#pt-run-hint");
    const go = body.querySelector("#pt-run-go");
    body.querySelector("[data-modal-cancel]")?.addEventListener("click", closeModal);
    const submit = async () => {
      if (go.disabled) return;
      const text = textInput.value.trim();
      if (!text) { setModalHint(hint, "先写一句话。"); return; }
      go.disabled = true; // 防重复点击
      result.hidden = true;
      setModalHint(hint, "跑中…", false);
      try {
        const response = await request(`/api/v1/partners/${encodeURIComponent(partnerId)}/run`, {
          method: "POST",
          body: JSON.stringify({ text }),
        });
        const data = await response.json().catch(() => ({}));
        const shown = data.ok ? (data.text || "（没有正文）") : (data.error || data.text || "这一轮没跑完");
        result.textContent = shown;
        result.classList.toggle("is-error", !data.ok);
        result.hidden = false;
        setModalHint(hint, "", false);
      } catch (error) {
        if (error.message === "forbidden") { closeModal(); return; }
        setModalHint(hint, `没跑成：${error.message}`);
      } finally {
        go.disabled = false;
      }
    };
    go.addEventListener("click", () => void submit());
    textInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); void submit(); }
    });
    textInput.addEventListener("input", () => clearModalHint(hint));
  });
}

export { openRunPartnerModal, ptConfirmDeleteRoutine, ptCreateRoutine, ptLoadRuns, ptRenderRoutineList, ptRoutineFormMarkup, ptRunNow, ptToggleHistory, ptToggleRoutine, ptWireRoutineForm };
