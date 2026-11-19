/**
 * 设置 → 派活（2026-11-16 多 CLI 打手适配；同日二改：模型换自定义下拉 + 文案收口）
 *
 * 用户口径：桌面端要能选"默认派给谁"，并给每个 CLI 配模型 / 权限。
 * 「执行器」这个词太硬——它就是一个普通工人，界面统一说「默认派给谁」；
 * 解释性文字不常驻，全收进标签的 data-tip（全局 hover-tip 小黑块）。
 *
 * 模型选择不用 <datalist>（原生下拉箭头丑、清单窗口也窄）：输入框内嵌自画箭头 +
 * 面板挂 body 用 fixed 定位——`.card` 是 overflow:hidden，absolute 弹层会被裁掉，
 * 与 hover-tip 同一个绕法。清单来自 probe 端点（空 model = 只拉清单，不耗模型额度），
 * 点箭头或点「检测」才拉，不在进页时自动跑。
 *
 * 数据：`GET/PUT /api/v1/agent/executor`（落 `.data/executor.json`，见 executor-config.ts）。
 *
 * 页面结构：
 *   ① 默认派给谁（下拉；phone/mcp 锁定只读）
 *   ② 每个可选 CLI 一张卡：模型输入 + 清单下拉 + 权限三档（该 CLI 不支持权限就写"固定"）
 *   ③ 一个保存按钮：改完一次提交；下一次派活生效（续跑沿用原单快照）
 */

import { esc, attr } from "./markdown.js";
import { request } from "./net.js";
import { mountSegmented, sectionMarkup, syncSegmented } from "./settings-atoms.js";
import { toast } from "./ui-atoms.js";

const PERMISSION_LABEL = {
  read: "只读",
  edit: "可改",
  full: "全权",
};

// Lucide arrowDown（同 icons.js 的路径，这里内联一份避免拉整个图标表）
const ARROW_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

let current = null;
let dirty = false;
/** 每个 CLI 拉到的清单：kind → { models, message }；没拉过就不在 Map 里。 */
const modelLists = new Map();
/** 清单请求去重（同一 kind 并发只发一次）。 */
const pendingLists = new Set();
/** 当前打开的 { menu, kind }；面板挂在 body 下，关 = 藏起来。 */
let openMenu = null;

export function executorSectionMarkup() {
  // 2026-11-18：四张导航卡已经写着「派活」，节标题改成这一页真正的对象「执行器」，
  // 不再和 tab 名重复。
  return sectionMarkup(
    "执行器",
    `<div class="card">
      <div class="row">
        <div class="row-main">
          <div class="row-label" data-tip="任务中心的活默认交给哪个工人。换默认只影响新单；续跑沿用原单的工人。">默认派给谁</div>
          <div class="row-hint" id="executor-hint" hidden>读取中…</div>
        </div>
        <div class="row-control">
          <select class="set-input executor-select" id="executor-kind" aria-label="默认派给谁" disabled></select>
        </div>
      </div>
      <div class="row">
        <div class="row-main">
          <div class="row-label" data-tip="工人自报完成后怎么验收：内部一次请求 = chancellor 内部一次纯文本请求判（现状，默认）；派质检 worker = 再派一单质检工人，亲自验证产物后给 DONE / CONTINUE / BLOCKED 结论（更可靠，多花一单的工时）。换方式只影响新单。">质检方式</div>
        </div>
        <div class="row-control">
          <select class="set-input executor-select" id="executor-qa" aria-label="质检方式" disabled>
            <option value="internal">内部一次请求（现状）</option>
            <option value="qa-worker">派质检 worker（新）</option>
          </select>
        </div>
      </div>
    </div>
    <div class="executor-profiles" id="executor-profiles"></div>`,
    "",
    `<button class="ghost" id="executor-save" type="button" disabled>保存</button>`,
  );
}

export async function wireExecutorSettings() {
  const select = document.getElementById("executor-kind");
  const qaSelect = document.getElementById("executor-qa");
  const profiles = document.getElementById("executor-profiles");
  const hint = document.getElementById("executor-hint");
  const save = document.getElementById("executor-save");
  if (!select || !profiles || !hint || !save) return;

  /** 行内小字只放状态与报错；解释一律进 data-tip。 */
  const setHint = (text) => {
    hint.hidden = text === "";
    hint.textContent = text;
  };

  const paint = (data) => {
    current = data;
    dirty = false;
    save.disabled = true;
    closeModelMenu();
    // 上一次 paint 的面板可能还挂在 body 下（卡片被整体重画，孤儿要摘掉）
    for (const stale of document.querySelectorAll("body > .executor-model-menu")) {
      stale.remove();
    }

    const kinds = Array.isArray(data.kinds) ? data.kinds : [];
    const selectable = kinds.filter((kind) => kind.selectable);
    select.replaceChildren();
    for (const kind of selectable) {
      const option = document.createElement("option");
      option.value = kind.id;
      option.textContent = kind.label;
      select.append(option);
    }
    // phone / mcp 是部署形态：补一个禁用的当前项，别让下拉显示成空白。
    if (!selectable.some((kind) => kind.id === data.employee)) {
      const locked = kinds.find((kind) => kind.id === data.employee);
      const option = document.createElement("option");
      option.value = data.employee;
      option.textContent = locked?.label || data.employee;
      option.disabled = true;
      select.prepend(option);
    }
    select.value = data.employee;
    select.disabled = data.locked === true || data.enabled === false;
    // 质检方式（批2）：回显 + 随派活设置一起禁用/启用。
    if (qaSelect) {
      qaSelect.value = data.qa === "qa-worker" ? "qa-worker" : "internal";
      qaSelect.disabled = data.enabled === false;
    }
    save.disabled = true;
    setHint("");

    if (data.locked) {
      setHint(data.lockedReason || "默认派给谁由 .env 指定，界面不改。");
      profiles.innerHTML = `<div class="card"><div class="row"><div class="row-main">
        <div class="row-label">当前默认</div>
        <div class="row-hint">${esc(data.lockedReason || "由 .env 指定")}</div>
      </div></div></div>`;
      return;
    }

    profiles.innerHTML = selectable
      .map((kind) => profileCard(kind, data.profiles?.[kind.id] || {}, kind.id === data.employee))
      .join("");
    for (const seg of profiles.querySelectorAll(".segmented")) mountSegmented(seg);
    for (const seg of profiles.querySelectorAll("[data-perm]")) {
      for (const button of seg.querySelectorAll("button")) {
        button.addEventListener("click", () => {
          for (const other of seg.querySelectorAll("button")) {
            other.setAttribute("aria-checked", String(other === button));
          }
          syncSegmented(seg);
          markDirty();
        });
      }
    }
    for (const input of profiles.querySelectorAll("[data-model]")) {
      input.addEventListener("input", () => {
        markDirty();
        // 面板开着时把输入当筛选词用
        if (openMenu?.kind === input.dataset.model) renderModelMenu(input.dataset.model);
      });
    }
    for (const button of profiles.querySelectorAll("[data-model-toggle]")) {
      button.addEventListener("click", () => {
        const kind = button.dataset.modelToggle || "";
        if (openMenu?.kind === kind) {
          closeModelMenu();
          return;
        }
        openModelMenu(kind);
      });
    }
    for (const button of profiles.querySelectorAll("[data-probe]")) {
      button.addEventListener("click", () => void runProbe(button));
    }
    if (data.enabled === false) {
      setHint("派活设置已关闭（EXECUTOR_CONFIG=false），当前值由 .env 决定。");
      for (const input of profiles.querySelectorAll("[data-model]")) input.disabled = true;
      for (const button of profiles.querySelectorAll("[data-perm] button")) button.disabled = true;
      for (const button of profiles.querySelectorAll("[data-probe]")) button.disabled = true;
      for (const button of profiles.querySelectorAll("[data-model-toggle]")) button.disabled = true;
      select.disabled = true;
    }
  };

  const markDirty = () => {
    dirty = true;
    save.disabled = false;
  };

  /**
   * 检测：填了模型 = 真跑一次极小请求验证；留空 = 只拉清单。
   * 显式人工动作；填了模型可能消耗一次很小的模型调用；结果只回分类，不回原始 stderr。
   */
  const runProbe = async (button) => {
    const kind = button.dataset.probe || "";
    const input = profiles.querySelector(`[data-model="${cssEscape(kind)}"]`);
    const status = profiles.querySelector(`[data-probe-status="${cssEscape(kind)}"]`);
    button.disabled = true;
    if (status) {
      status.hidden = false;
      status.classList.remove("is-error");
      status.textContent = input?.value.trim()
        ? "检测中…（会真实调用一次 CLI）"
        : "取清单中…";
    }
    try {
      const response = await request("/api/v1/agent/executor/probe", {
        method: "POST",
        body: JSON.stringify({
          employee: kind,
          model: input instanceof HTMLInputElement ? input.value.trim() : "",
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (status) {
          status.textContent = body.message || `检测失败：HTTP ${response.status}`;
          status.classList.add("is-error");
        }
        return;
      }
      modelLists.set(kind, {
        models: Array.isArray(body.models) ? body.models.map(String) : [],
        message: body.message || "",
      });
      if (openMenu?.kind === kind) renderModelMenu(kind);
      if (status) {
        status.textContent = body.message || (body.ok ? "可用" : "检测失败");
        status.classList.toggle("is-error", body.ok !== true);
      }
    } catch (error) {
      if (error.message !== "forbidden" && status) {
        status.hidden = false;
        status.textContent = "检测失败，稍后再试";
        status.classList.add("is-error");
      }
    } finally {
      button.disabled = false;
    }
  };

  select.addEventListener("change", () => {
    if (!current) return;
    markDirty();
  });
  if (qaSelect) {
    qaSelect.addEventListener("change", () => {
      if (!current) return;
      markDirty();
    });
  }

  save.addEventListener("click", async () => {
    if (!current || dirty === false) return;
    const payload = { employee: select.value, profiles: {} };
    if (qaSelect) payload.qa = qaSelect.value === "qa-worker" ? "qa-worker" : "internal";
    for (const kind of current.kinds.filter((item) => item.selectable)) {
      // native 也存 model（2026-11-16 批1）：留空 = 跟随启动 env，native.ts 不做覆盖。
      const input = document.querySelector(`[data-model="${cssEscape(kind.id)}"]`);
      const seg = document.querySelector(`[data-perm="${cssEscape(kind.id)}"]`);
      const profile = { model: input?.value ?? "" };
      const checked = seg?.querySelector('button[aria-checked="true"]');
      if (checked?.dataset.value) profile.permission = checked.dataset.value;
      payload.profiles[kind.id] = profile;
    }
    save.disabled = true;
    try {
      const response = await request("/api/v1/agent/executor", {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        toast(body.message || `没存成：HTTP ${response.status}`);
        save.disabled = false;
        return;
      }
      paint(body);
      toast("已保存，下一次派活生效");
    } catch (error) {
      if (error.message !== "forbidden") toast("没存成，稍后再试");
      save.disabled = false;
    }
  });

  try {
    const response = await request("/api/v1/agent/executor", { cache: "no-store" });
    if (!response.ok) throw new Error(String(response.status));
    paint(await response.json());
  } catch (error) {
    if (error.message === "forbidden") return;
    setHint("读不到派活设置，稍后再试。");
    hint.classList.add("is-error");
  }
}

/* ---- 模型清单下拉（面板挂 body，fixed 定位绕开 .card 的 overflow 裁切） ---- */

/** 拉清单（空 model = 只列清单，不真调模型）；同一 kind 并发去重。 */
async function ensureList(kind) {
  if (modelLists.has(kind) || pendingLists.has(kind)) return;
  pendingLists.add(kind);
  try {
    const response = await request("/api/v1/agent/executor/probe", {
      method: "POST",
      body: JSON.stringify({ employee: kind, model: "" }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      modelLists.set(kind, {
        models: [],
        message: body.message || `取清单失败：HTTP ${response.status}`,
      });
    } else {
      modelLists.set(kind, {
        models: Array.isArray(body.models) ? body.models.map(String) : [],
        message: body.message || "",
      });
    }
  } catch (error) {
    if (error.message !== "forbidden") {
      modelLists.set(kind, { models: [], message: "取清单失败，稍后再试" });
    }
  } finally {
    pendingLists.delete(kind);
    if (openMenu?.kind === kind) renderModelMenu(kind);
  }
}

function openModelMenu(kind) {
  closeModelMenu();
  const box = document.querySelector(`[data-model-box="${cssEscape(kind)}"]`);
  const menu = document.querySelector(`[data-model-menu="${cssEscape(kind)}"]`);
  if (!box || !menu) return;
  menu.hidden = false;
  document.body.append(menu);
  const rect = box.getBoundingClientRect();
  const width = Math.min(Math.max(rect.width, 340), window.innerWidth - 16);
  menu.style.width = `${Math.round(width)}px`;
  menu.style.left = `${Math.max(8, Math.min(Math.round(rect.left), window.innerWidth - width - 8))}px`;
  // 下方放不下（面板 300 高 + 间距）且上方够放就朝上开；否则朝下，让视口自己裁
  const openUp = window.innerHeight - rect.bottom < 316 && rect.top > 316;
  menu.style.top = `${Math.round(openUp ? rect.top - 6 : rect.bottom + 6)}px`;
  menu.style.transform = openUp ? "translateY(-100%)" : "";
  openMenu = { menu, kind };
  renderModelMenu(kind);
  void ensureList(kind);
}

function closeModelMenu() {
  if (!openMenu) return;
  openMenu.menu.hidden = true;
  openMenu = null;
}

function renderModelMenu(kind) {
  const menu = document.querySelector(`[data-model-menu="${cssEscape(kind)}"]`);
  if (!menu || menu.hidden) return;
  const input = document.querySelector(`[data-model="${cssEscape(kind)}"]`);
  const entry = modelLists.get(kind);
  menu.replaceChildren();
  const note = document.createElement("div");
  note.className = "executor-model-note";
  if (!entry) {
    note.textContent = "取清单中…";
    menu.append(note);
    return;
  }
  const filter = (input?.value ?? "").trim().toLowerCase();
  const filtered = filter
    ? entry.models.filter((model) => model.toLowerCase().includes(filter))
    : entry.models;
  const shown = filtered.slice(0, 800);
  if (filter) {
    note.textContent = `匹配 ${filtered.length} / ${entry.models.length} 个`;
  } else if (entry.message) {
    note.textContent = entry.message;
  } else {
    note.textContent = `共 ${entry.models.length} 个模型`;
  }
  menu.append(note);
  if (entry.models.length > 0 && filtered.length === 0) {
    menu.append(menuNote("没有匹配的模型名"));
    return;
  }
  const current = (input?.value ?? "").trim();
  for (const model of shown) {
    const row = document.createElement("div");
    row.className = "model-row";
    const item = document.createElement("button");
    item.type = "button";
    item.className = "model-item";
    item.setAttribute("role", "option");
    if (model === current) item.setAttribute("aria-checked", "true");
    const name = document.createElement("span");
    name.className = "model-name";
    name.textContent = model;
    item.append(name);
    item.addEventListener("click", () => {
      if (input) input.value = model;
      // dirty 立起来：save 闭包在 wireExecutorSettings 里，借 input 事件冒出去
      input?.dispatchEvent(new Event("input", { bubbles: true }));
      closeModelMenu();
    });
    row.append(item);
    menu.append(row);
  }
  if (filtered.length > shown.length) {
    menu.append(menuNote(`只显示前 ${shown.length} 个；在上面的输入框打字筛选`));
  }
}

function menuNote(text) {
  const div = document.createElement("div");
  div.className = "executor-model-note";
  div.textContent = text;
  return div;
}

// 关闭手势：点外面 / Escape / 页面滚动（fixed 定位会跟滚动脱节，直接关）。
// 挂模块顶层一次，wireExecutorSettings 每次进页都跑也不叠加。
document.addEventListener("pointerdown", (event) => {
  if (!openMenu) return;
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  if (openMenu.menu.contains(target)) return;
  if (target.closest(`[data-model-box="${cssEscape(openMenu.kind)}"]`)) return;
  closeModelMenu();
});
document.addEventListener(
  "keydown",
  (event) => {
    if (!openMenu || event.key !== "Escape") return;
    // 面板开着时 Escape 只关面板：捕获阶段截下，不让全局手势抢走（2026-11-16 实测会连设置页一起退回）
    event.stopImmediatePropagation();
    event.preventDefault();
    closeModelMenu();
  },
  true,
);
window.addEventListener(
  "scroll",
  (event) => {
    if (!openMenu) return;
    // 面板自己的列表滚动不算页面滚动
    if (event.target instanceof Node && openMenu.menu.contains(event.target)) return;
    closeModelMenu();
  },
  true,
);

function profileCard(kind, profile, isCurrent) {
  const permissions = Array.isArray(kind.permissions) ? kind.permissions : null;
  const permissionRow = permissions
    ? `<div class="divider"></div>
       <div class="row">
         <div class="row-main">
           <div class="row-label" data-tip="只读不改文件；可改能写项目；全权连命令都不问。">权限</div>
         </div>
         <div class="row-control">
           <div class="segmented slide" role="radiogroup" data-perm="${attr(kind.id)}" aria-label="${attr(kind.label)} 权限">
             ${permissions
               .map(
                 (value) =>
                   `<button type="button" data-value="${attr(value)}" aria-checked="${profile.permission === value}">${esc(PERMISSION_LABEL[value] || value)}</button>`,
               )
               .join("")}
           </div>
         </div>
       </div>`
    : `<div class="divider"></div>
       <div class="row">
         <div class="row-main">
           <div class="row-label" data-tip="${attr(kind.note || "")}">权限</div>
         </div>
         <div class="row-control"><span class="set-hint">${esc(
           kind.id === "native" ? "本机策略管" : "固定全权",
         )}</span></div>
       </div>`;

  // 卡片标题的解释（额度 / 边界 / 留空语义）全收进 data-tip，不常驻
  const labelTips = [];
  if (kind.id === "native") {
    labelTips.push("不是外部 CLI；模型留空走启动 env（LLM_MODEL，默认 deepseek-v4.1-flash），填了则 native 工人用该模型；权限由本机内核权限策略管。");
  }
  if (kind.note) labelTips.push(kind.note);
  if (kind.id !== "native") labelTips.push("模型留空 = 跟随该 CLI 自己的配置。");

  return `<div class="card executor-card" data-executor-card="${attr(kind.id)}">
    <div class="row">
      <div class="row-main">
        <div class="row-label" data-tip="${attr(labelTips.join("\n"))}">${esc(kind.label)}<span class="flag-tag accent" data-current-tag${isCurrent ? "" : " hidden"}>当前</span></div>
      </div>
      <div class="row-control">
        ${
          kind.id === "native"
            ? `<div class="executor-model-row">
                 <div class="executor-model-box" data-model-box="${attr(kind.id)}">
                   <input class="set-input executor-model" data-model="${attr(kind.id)}"
                          value="${attr(profile.model ?? "")}"
                          placeholder="${attr(kind.modelHint || "留空跟随启动 env")}"
                          aria-label="${attr(kind.label)} 的模型"
                          autocomplete="off" spellcheck="false" />
                 </div>
               </div>`
            : `<div class="executor-model-row">
                 <div class="executor-model-box" data-model-box="${attr(kind.id)}">
                   <input class="set-input executor-model" data-model="${attr(kind.id)}"
                          value="${attr(profile.model ?? "")}"
                          placeholder="${attr(kind.modelHint || "留空跟随 CLI 配置")}"
                          aria-label="${attr(kind.label)} 的模型"
                          autocomplete="off" spellcheck="false" />
                   <button class="executor-model-toggle" type="button" data-model-toggle="${attr(kind.id)}"
                           aria-label="展开${attr(kind.label)}的模型清单"
                           data-tip="拉取该 CLI 的完整模型清单（清单命令不耗模型额度）；在输入框打字可筛选">${ARROW_SVG}</button>
                   <div class="executor-model-menu" data-model-menu="${attr(kind.id)}" hidden></div>
                 </div>
                 <button class="ghost executor-probe" type="button" data-probe="${attr(kind.id)}"
                         data-tip="填了模型就真调一次该 CLI 验证可用性（很小的请求，可能耗一点额度）；留空只拉清单">检测</button>
               </div>`
        }
      </div>
    </div>
    ${
      kind.id === "native"
        ? ""
        : `<div class="set-hint executor-probe-status" data-probe-status="${attr(kind.id)}" hidden></div>`
    }
    ${permissionRow}
  </div>`;
}

function cssEscape(value) {
  return String(value).replace(/["\\]/g, "\\$&");
}
