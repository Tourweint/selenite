/**
 * 二级页 · 普通助手人设（2026-11-16）
 *
 * 所有 Worker 共用一份人设，设置 → 人设 → 普通助手 改；改完下一轮生效。
 * 只有一块「人设正文」——不复制执事那套人格模块 / 纪律 / 工具勾选。
 * 入口 #/settings/partners/worker；端点 GET/PUT /api/v1/agent/worker-persona。
 */

import { el } from "./dom.js";
import { esc } from "./markdown.js";
import { request } from "./net.js";
import { currentPartnerProfileId } from "./route.js";
import { setSwitchChecked, switchMarkup } from "./settings-atoms.js";
import { toast } from "./ui-atoms.js";

// 与服务端 workerPersonaDefault() 同一份文本（固定字节）；改默认文案两处要同步。
// 2026-11-16 批2 拆层：这里只有身份与作风（会话与派活工人同吃）；
// remember / recall / set_reminder 的工具提示只在会话里由服务端追加，不进文件。
const WORKER_DEFAULT = "你是一个普通任务助手，负责把交到你手上的具体事情办完。交代的事一定办到底：不推、不挑、不抱怨；办不成要说清卡在哪一步、缺什么。说话直接、克制、就事论事，给结论也给依据；不冒充总管，也不代表任何执事。涉及真实文件、真实数据、真实日程或当前时间的事，必须先用工具去看，不许凭印象回答或编造；看不到就说明缺什么。做不到、做不完或做偏了就如实说，不硬凑结果，更不谎报完成。没有预设的私人档案，也不主动建立执事身份。";

const WF_ENDPOINT = "/api/v1/agent/worker-persona";
const WF_MEMORY_FLAG = "DELEGATION_PROJECT_MEMORY";

function wfMarkup(data) {
  const readOnly = data.editable === false;
  return `
  <div class="pf">
    <button class="pf-back" type="button" id="wf-back">← 总管与执事</button>
    <header class="pf-hero">
      <h1 class="pf-title">普通助手</h1>
      <div class="pf-meta">全部 Worker 共用（会话与派活工人同吃）· 下一轮生效</div>
    </header>

    <section class="pf-sec">
      <div class="pf-sec-head">
        <h2 class="pf-sec-title">人设正文</h2>
        <span class="pf-sec-note" id="wf-count">${data.chars} 字</span>
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
        <p class="wf-note">Worker 会话与派活工人（native / 外部 CLI）共用这份人设，派活的进任务书「你是谁」段；remember / recall / set_reminder 的工具提示只在会话里追加。Worker 不参与执事的人格模块、记忆召回与工具勾选。</p>
      </div>
    </section>

    <section class="pf-sec" id="wf-tools-sec" hidden>
      <div class="pf-sec-head">
        <h2 class="pf-sec-title">能用的工具</h2>
        <span class="pf-sec-note" id="wf-tools-note"></span>
      </div>
      <div class="card pf-panel">
        <div id="wf-tools-rows"></div>
        <p class="wf-note is-error" id="wf-tools-warn" hidden></p>
        <p class="wf-note">只对本机派活的工人生效；外部 CLI 用它们自己的工具，Worker 会话不在此列。</p>
      </div>
    </section>

    <section class="pf-sec" id="wf-dispatch-sec" hidden>
      <div class="pf-sec-head">
        <h2 class="pf-sec-title">派活</h2>
        <span class="pf-sec-note">父闸：派活（宰相）</span>
      </div>
      <div class="card pf-panel">
        <div class="row">
          <div class="row-main" data-tip="派出去的工人（native 与外部 CLI）在任务书里带上单子所属项目的长期记忆（16 条 / 2000 字，经拆单器转述，不逐字保证）；只取项目记忆，不带 global / 执事记忆。记忆总闸关着时同样不注入。">
            <div class="row-label">派活带项目记忆</div>
          </div>
          <div class="row-control" id="wf-memory-control"></div>
        </div>
        <p class="wf-note">项目在派单时指定（delegate 的 project 参数），Worker 设置里不绑项目。</p>
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
  root.querySelector("#wf-back")?.addEventListener("click", () => {
    location.hash = "#/settings/partners";
  });
  void wfWireDispatchMemory(root);
  void wfWireTools(root);

  const text = root.querySelector("#wf-text");
  const count = root.querySelector("#wf-count");
  const hint = root.querySelector("#wf-hint");
  const reset = root.querySelector("#wf-reset");
  const restore = root.querySelector("#wf-default");
  const save = root.querySelector("#wf-save");
  let loaded = String(data.persona ?? "");
  const editable = data.editable !== false;

  const refresh = () => {
    const value = text.value;
    if (count) count.textContent = `${value.length} 字`;
    const changed = value !== loaded;
    if (reset) reset.disabled = !changed;
    if (save) save.disabled = !changed;
    if (hint && editable) hint.textContent = "";
  };

  text?.addEventListener("input", refresh);
  reset?.addEventListener("click", () => {
    text.value = loaded;
    refresh();
  });
  // 只把默认正文填进 textarea，不直接保存——用户再点「保存」才落盘。
  restore?.addEventListener("click", () => {
    text.value = WORKER_DEFAULT;
    text.focus();
    refresh();
  });
  save?.addEventListener("click", async () => {
    if (save.disabled) return;
    save.disabled = true;
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
        save.disabled = false;
        return;
      }
      toast("已保存，下一轮生效");
      loaded = body.persona;
      text.value = body.persona;
      refresh();
    } catch (error) {
      if (error.message === "forbidden") return;
      if (hint) hint.textContent = `保存失败：${error.message}`;
      save.disabled = false;
    }
  });
}

/** 派活带项目记忆（2026-11-16 批3）：开关本体在插件页清单里（DELEGATION_PROJECT_MEMORY），
 *  这里只是同一颗开关的便捷入口。父闸 = 派活（宰相），关着时显示关、拨不动；
 *  开关页没开（AGENT_FLAGS_UI=false）就整段隐藏，用户走 env 管。 */
async function wfWireDispatchMemory(root) {
  const section = root.querySelector("#wf-dispatch-sec");
  const control = root.querySelector("#wf-memory-control");
  if (!section || !control) return;
  let flag;
  try {
    const response = await request("/api/v1/agent/flags", { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json().catch(() => ({}));
    flag = (Array.isArray(data.flags) ? data.flags : []).find(
      (item) => item && item.key === WF_MEMORY_FLAG,
    );
  } catch {
    return; // 403 / 网络错误：整段保持隐藏，不挡人设编辑
  }
  if (!flag) return;
  section.hidden = false;
  const locked = Boolean(flag.lockedBy);
  const on = (flag.effectiveValue ?? flag.value) === "true" && !locked;
  control.innerHTML = locked
    ? switchMarkup(false, {
        label: "派活带项目记忆（随总闸关闭）",
        attrs: `disabled aria-disabled="true" data-tip="由「${flag.lockedByLabel || "派活（宰相）"}」关闭：显示关、拨不动；存储值保留，总闸重开后恢复。"`,
      })
    : switchMarkup(on, { label: "派活带项目记忆", attrs: `data-wf-memory-switch="1"` });
  const sw = control.querySelector("[data-wf-memory-switch]");
  sw?.addEventListener("click", async () => {
    const next = sw.getAttribute("aria-checked") !== "true";
    sw.disabled = true;
    try {
      const response = await request(`/api/v1/agent/flags/${encodeURIComponent(WF_MEMORY_FLAG)}`, {
        method: "PUT",
        body: JSON.stringify({ value: String(next) }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        toast(body.message || `没存成：HTTP ${response.status}`);
        return;
      }
      setSwitchChecked(sw, next);
      toast(next ? "已开，下一次派活生效" : "已关，下一次派活生效");
    } catch (error) {
      if (error.message !== "forbidden") toast("没存成，稍后再试");
    } finally {
      sw.disabled = false;
    }
  });
}

/** 能用的工具（2026-11-17 批4）：只管本机 native 工人（canonical 四件，存取消名单）。
 *  外部 CLI 与 Worker 会话不在此列；一件不剩时给出诚实警告（工人交不出 REPORT.md）。 */
async function wfWireTools(root) {
  const section = root.querySelector("#wf-tools-sec");
  const rowsBox = root.querySelector("#wf-tools-rows");
  const note = root.querySelector("#wf-tools-note");
  const warn = root.querySelector("#wf-tools-warn");
  if (!section || !rowsBox) return;
  let data;
  try {
    const response = await request("/api/v1/agent/worker-tools", { cache: "no-store" });
    if (!response.ok || response.json === undefined) throw new Error(`HTTP ${response.status}`);
    data = await response.json();
    if (data?.ok !== true) throw new Error("bad payload");
  } catch (error) {
    if (error.message === "forbidden") return;
    return; // 读不到就不渲染这区，不挡人设编辑
  }
  section.hidden = false;
  let disabled = Array.isArray(data.disabled) ? [...data.disabled] : [];
  const catalog = Array.isArray(data.catalog) ? data.catalog : [];

  const grantedText = (granted) =>
    granted.length > 0 ? `实际下发：${granted.join("、")}` : "实际下发：无";
  const paint = (granted) => {
    if (note) note.textContent = grantedText(granted);
    if (warn) warn.hidden = granted.length > 0;
    rowsBox.replaceChildren();
    for (const item of catalog) {
      const row = document.createElement("div");
      row.className = "row";
      const main = document.createElement("div");
      main.className = "row-main";
      main.dataset.tip = `${item.note || ""}${item.name === "write" ? "。交付契约要求工人写 REPORT.md，关掉后只能靠 bash 凑合，多数任务会交不了差" : item.name === "read" ? "。关掉后工人看不了材料，只能凭任务书正文干活" : ""}`;
      const label = document.createElement("div");
      label.className = "row-label";
      label.textContent = item.label;
      main.append(label);
      const control = document.createElement("div");
      control.className = "row-control";
      control.innerHTML = switchMarkup(!disabled.includes(item.name), {
        label: `${item.label}开关`,
        attrs: `data-wf-tool="${item.name}"`,
      });
      row.append(main, control);
      rowsBox.append(row);
    }
    for (const sw of rowsBox.querySelectorAll("[data-wf-tool]")) {
      sw.addEventListener("click", () => void toggleTool(sw.dataset.wfTool, sw));
    }
  };
  paint(Array.isArray(data.granted) ? data.granted : []);

  async function toggleTool(name, sw) {
    const turningOff = !disabled.includes(name);
    const next = turningOff
      ? [...disabled, name]
      : disabled.filter((item) => item !== name);
    sw.disabled = true;
    try {
      const response = await request("/api/v1/agent/worker-tools", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disabled: next }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body?.ok !== true) {
        toast(body.message || `没存成：HTTP ${response.status}`);
        return;
      }
      disabled = Array.isArray(body.disabled) ? [...body.disabled] : next;
      paint(Array.isArray(body.granted) ? body.granted : []);
      toast("已保存，下一次派活生效");
    } catch (error) {
      if (error.message !== "forbidden") toast("没存成，稍后再试");
    } finally {
      sw.disabled = false;
    }
  }
}

export { renderWorkerProfilePage };
