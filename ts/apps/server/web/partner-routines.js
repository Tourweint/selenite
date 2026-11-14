/**
 * 例行任务 + 试跑
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { attr, esc } from "./markdown.js";
import { request } from "./net.js";
import { PT_RUN_STATUS, openEditPartnerModal, ptHumanizeTrigger } from "./partner-modals.js";
import { clearModalHint, setModalHint } from "./project-modal.js";
import { mountSegmented, syncSegmented } from "./settings-atoms.js";
import { closeModal, openModal, toast } from "./ui-atoms.js";


/* ── 例行任务（编辑模态第三段）───────────────────────── */

function ptRoutineFormMarkup() {
  return `
    <div class="pt-new">
      <div class="pt-seg-title">新建例行任务</div>
      <label class="modal-field">
        <span>名称（≤40 字）</span>
        <input class="modal-input" id="pt-r-name" type="text" maxlength="40" placeholder="例如：每晚整理" />
      </label>
      <label class="modal-field">
        <span>指令 prompt</span>
        <textarea class="pt-ta" id="pt-r-prompt" rows="3" spellcheck="false" placeholder="到点要它做什么"></textarea>
      </label>
      <div class="modal-field">
        <span>触发器类型</span>
        <div class="segmented slide" id="pt-r-trigger" role="radiogroup" aria-label="触发器类型">
          <button type="button" data-trigger="cron" aria-checked="true">cron</button>
          <button type="button" data-trigger="interval" aria-checked="false">interval</button>
          <button type="button" data-trigger="once" aria-checked="false">once</button>
          <button type="button" data-trigger="event" aria-checked="false">event</button>
        </div>
      </div>
      <div class="modal-field pt-trigger-input" data-trigger-input="cron">
        <span>cron 原文（5 段：分 时 日 月 周）</span>
        <input class="modal-input is-mono" id="pt-r-cron" type="text" spellcheck="false" placeholder="30 21 * * *" />
      </div>
      <div class="modal-field pt-trigger-input" data-trigger-input="interval" hidden>
        <span>间隔秒数（≥60）</span>
        <input class="modal-input is-mono" id="pt-r-interval" type="number" min="60" placeholder="3600" />
      </div>
      <div class="modal-field pt-trigger-input" data-trigger-input="once" hidden>
        <span>一次性时间</span>
        <input class="modal-input" id="pt-r-once" type="datetime-local" />
      </div>
      <div class="modal-field pt-trigger-input" data-trigger-input="event" hidden>
        <span>事件 kind</span>
        <select class="modal-input" id="pt-r-kind">
          <option value="delegation">delegation</option>
          <option value="tool">tool</option>
          <option value="phase">phase</option>
        </select>
        <span>match（可选，单行 k=v，多组用逗号）</span>
        <input class="modal-input is-mono" id="pt-r-match" type="text" spellcheck="false" placeholder="phase=done" />
      </div>
      <div class="pt-mode-row">
        <span class="set-hint">会话方式</span>
        <button class="switch" id="pt-r-mode" type="button" role="switch" aria-checked="false" aria-label="每次新开">
          <span class="switch-thumb" aria-hidden="true"></span>
        </button>
        <span class="set-hint" id="pt-r-mode-label">接着聊</span>
      </div>
      <div class="pt-actions">
        <button class="btn-primary" id="pt-r-create" type="button">新建例行任务</button>
      </div>
      <p class="modal-hint" id="pt-r-hint"></p>
    </div>`;
}

function ptWireRoutineForm(body, partnerId, listBox) {
  const seg = body.querySelector("#pt-r-trigger");
  if (seg) mountSegmented(seg);
  const showTrigger = (type) => {
    for (const node of body.querySelectorAll("[data-trigger-input]")) {
      node.hidden = node.dataset.triggerInput !== type;
    }
  };
  showTrigger("cron");
  for (const button of seg ? seg.querySelectorAll("[data-trigger]") : []) {
    button.addEventListener("click", () => {
      for (const other of seg.querySelectorAll("[data-trigger]")) {
        other.setAttribute("aria-checked", String(other === button));
      }
      syncSegmented(seg);
      showTrigger(button.dataset.trigger);
    });
  }

  const mode = body.querySelector("#pt-r-mode");
  const modeLabel = body.querySelector("#pt-r-mode-label");
  mode?.addEventListener("click", () => {
    const next = mode.getAttribute("aria-checked") !== "true";
    mode.setAttribute("aria-checked", String(next));
    if (modeLabel) modeLabel.textContent = next ? "每次新开" : "接着聊";
  });

  const hint = body.querySelector("#pt-r-hint");
  body.querySelector("#pt-r-create")?.addEventListener("click", () =>
    void ptCreateRoutine(body, partnerId, listBox, hint),
  );
  body.querySelector("#pt-r-name")?.addEventListener("input", () => clearModalHint(hint));
}

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
    const response = await request(`/api/v1/routines?partnerId=${encodeURIComponent(partnerId)}`, { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(String(response.status));
    const routines = data.routines || [];
    box.replaceChildren();
    if (!routines.length) {
      box.innerHTML = `<div class="set-hint">还没有例行任务</div>`;
      return;
    }
    for (const routine of routines) {
      const row = document.createElement("div");
      row.className = "pt-routine";
      const triggers = Array.isArray(routine.triggers) ? routine.triggers : [];
      row.innerHTML = `
        <div class="pt-routine-head">
          <span class="row-label">${esc(routine.name || "")}</span>
          <div class="pt-routine-actions">
            <button class="switch" type="button" role="switch" aria-label="启用"
                    aria-checked="${routine.enabled ? "true" : "false"}" data-pt-enabled="${attr(routine.id)}">
              <span class="switch-thumb" aria-hidden="true"></span>
            </button>
            <button class="ghost" type="button" data-pt-run-now="${attr(routine.id)}">立即跑</button>
            <button class="ghost" type="button" data-pt-history="${attr(routine.id)}">展开历史</button>
            <button class="ghost" type="button" data-pt-del-routine="${attr(routine.id)}" data-pt-del-name="${attr(routine.name || "")}">删除</button>
          </div>
        </div>
        <div class="row-hint pt-trigger">${triggers.length ? triggers.map(ptHumanizeTrigger).join("；") : "—"}</div>
        <div class="pt-runs" data-pt-runs-for="${attr(routine.id)}" hidden></div>`;
      box.append(row);

      row.querySelector("[data-pt-enabled]")?.addEventListener("click", () => {
        const sw = row.querySelector("[data-pt-enabled]");
        void ptToggleRoutine(routine.id, sw);
      });
      row.querySelector("[data-pt-run-now]")?.addEventListener("click", () => {
        const runButton = row.querySelector("[data-pt-run-now]");
        void ptRunNow(routine.id, runButton, row.querySelector("[data-pt-runs-for]"));
      });
      row.querySelector("[data-pt-history]")?.addEventListener("click", () => {
        const historyButton = row.querySelector("[data-pt-history]");
        void ptToggleHistory(routine.id, historyButton, row.querySelector("[data-pt-runs-for]"));
      });
      row.querySelector("[data-pt-del-routine]")?.addEventListener("click", () =>
        ptConfirmDeleteRoutine(partnerId, routine.id, routine.name || "", options),
      );
    }
  } catch (error) {
    if (error.message === "forbidden") return;
    box.innerHTML = `<div class="set-hint is-error">读不到例行任务：${esc(error.message)}</div>`;
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
