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
 *   ② 每个可选 CLI 一张卡：模型输入 + 清单下拉 + 权限档（按该 CLI 实际支持的档位画；
 *     2026-11-23 起用服务端 `permissionOptions`，没有该字段回落旧的 `permissions`）
 *   ③ 一个保存按钮：改完一次提交；下一次派活生效（续跑沿用原单快照）
 */

import { chevDownSvg } from "./icons.js";
import { esc, attr } from "./markdown.js";
import { request } from "./net.js";
import { mountSegmented, sectionMarkup, syncSegmented } from "./settings-atoms.js";
import { toast } from "./ui-atoms.js";

const PERMISSION_LABEL = {
  read: "只读",
  edit: "可改",
  full: "全权",
};

// 2026-11-21（箭头统一批）：内联 arrowDown → icons.js 的 chevDownSvg（挂 .chev-ud，
// 面板开合时由 aria-expanded 驱动翻 180°，行为在 style-27）
const ARROW_SVG = chevDownSvg("chev-ud");

let current = null;
let dirty = false;
/** 每个 CLI 拉到的清单：kind → { models, message }；没拉过就不在 Map 里。 */
const modelLists = new Map();
/** 清单请求去重（同一 kind 并发只发一次）。 */
const pendingLists = new Set();
/**
 * 本机内核的干活模型清单（2026-11-19 模型分工）：来自服务端已连接供应商目录，
 * 不是 CLI 探测。`entries` = [{ providerId, providerName, modelId, hasKey }]。
 */
let poolCatalog = null;
let poolCatalogPending = false;
/** 当前打开的 { menu, kind, trigger, box }；面板挂在 body 下，关 = 藏起来。
 *  trigger = 开它的按钮（aria-expanded 挂这上面）；box = 触发区域（点里面不算外点）。 */
let openMenu = null;

export function executorSectionMarkup() {
  // 2026-11-18：左栏分区已经写着「派活」，节标题改成这一页真正的对象「执行器」，
  // 不再和分区名重复（2026-11-21 起 Agent 分区只剩这一页，逻辑不变）。
  return sectionMarkup(
    "执行器",
    `<div class="card">
      <div class="row">
        <div class="row-main">
          <div class="row-label" data-tip="任务中心的活默认交给哪个工人。换默认只影响新单；续跑沿用原单的工人。">默认派给谁</div>
          <div class="row-hint" id="executor-hint" hidden>读取中…</div>
        </div>
        <div class="row-control">
          <div class="executor-kind-box" id="executor-kind-box">
            <!-- 2026-11-21（箭头统一批）：原生 select（系统灰三角 + 原生菜单，和同页自绘
                 模型面板两套语言、箭头也转不了）→ 自绘面板：按钮 + 挂 body 的 fixed 菜单，
                 箭头开合翻 180°（行为在 style-27），面板定位与关闭手势跟模型清单共用 -->
            <button class="set-input executor-select executor-kind-btn" id="executor-kind" type="button"
                    aria-haspopup="listbox" aria-expanded="false" aria-label="默认派给谁" disabled>
              <span id="executor-kind-label">读取中…</span>${chevDownSvg("chev-ud")}
            </button>
            <div class="executor-model-menu executor-kind-menu" id="executor-kind-menu" hidden></div>
          </div>
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
  const kindLabel = document.getElementById("executor-kind-label");
  const profiles = document.getElementById("executor-profiles");
  const hint = document.getElementById("executor-hint");
  const save = document.getElementById("executor-save");
  if (!select || !kindLabel || !profiles || !hint || !save) return;
  // 上一次进页可能把默认派给谁的面板关在 body 下（closeModelMenu 只藏不回盒）：
  // section 静态标记每次进页都重建一份新的，旧孤儿不清会顶着重名的 id 躺着
  for (const orphan of document.querySelectorAll("body > #executor-kind-menu")) {
    orphan.remove();
  }
  // 每次进页现拉本机模型清单：供应商可能刚改过。
  poolCatalog = null;
  poolCatalogPending = false;

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
    // 上一次 paint 的面板可能还挂在 body 下（卡片被整体重画，孤儿要摘掉）。
    // 默认派给谁的面板是常驻节点（在 section 静态标记里），收回去而不是删掉。
    for (const stale of document.querySelectorAll("body > .executor-model-menu")) {
      if (stale.id === "executor-kind-menu") continue;
      stale.remove();
    }
    const kindMenuEl = document.getElementById("executor-kind-menu");
    const kindBoxEl = document.getElementById("executor-kind-box");
    if (kindMenuEl && kindBoxEl && !kindBoxEl.contains(kindMenuEl)) {
      kindMenuEl.hidden = true;
      kindBoxEl.append(kindMenuEl);
    }

    const kinds = Array.isArray(data.kinds) ? data.kinds : [];
    const selectable = kinds.filter((kind) => kind.selectable);
    // 2026-11-21（箭头统一批）：原生 select → 自绘按钮。当前值落在按钮 dataset 与
    // 文字上；phone / mcp 这类部署形态锁定时按钮禁用、文字照常显示当前项。
    const employeeKind = kinds.find((kind) => kind.id === data.employee);
    select.dataset.value = data.employee;
    kindLabel.textContent = employeeKind?.label || data.employee;
    select.disabled = data.locked === true || data.enabled === false;
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
    // 本机池的供应商 id 挂在 input 上（2026-11-19）；保存时原样带回，回显时用来对勾。
    for (const input of profiles.querySelectorAll("[data-model]")) {
      const kind = input.dataset.model || "";
      if (kind === "pool") input.dataset.providerId = data.profiles?.[kind]?.providerId || "";
    }
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
        // 手打模型名 = 供应商不再确定；从清单点选时会在 dispatch 之后补回 providerId。
        if (input.dataset.model === "pool") delete input.dataset.providerId;
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

  /* ── 默认派给谁：自绘面板（2026-11-21 箭头统一批）──
     面板行 = kinds 逐个一项：selectable 的可点；phone / mcp 摆进来让用户看见当前项
     但点不了（部署形态固定，跟旧 select 的 disabled option 同义）。 */
  const renderKindMenu = () => {
    const menu = document.getElementById("executor-kind-menu");
    if (!menu || menu.hidden || !current) return;
    menu.replaceChildren();
    const kinds = Array.isArray(current.kinds) ? current.kinds : [];
    for (const kind of kinds) {
      const row = document.createElement("div");
      row.className = "model-row";
      const item = document.createElement("button");
      item.type = "button";
      item.className = "model-item";
      item.setAttribute("role", "option");
      if (kind.id === current.employee) item.setAttribute("aria-checked", "true");
      const name = document.createElement("span");
      name.className = "model-name";
      name.textContent = kind.label || kind.id;
      item.append(name);
      if (kind.selectable === true) {
        item.addEventListener("click", () => {
          select.dataset.value = kind.id;
          kindLabel.textContent = kind.label || kind.id;
          for (const other of menu.querySelectorAll(".model-item")) {
            other.setAttribute("aria-checked", String(other === item));
          }
          markDirty();
          closeModelMenu();
        });
      } else {
        item.disabled = true;
        item.title = "部署形态固定，界面不改";
      }
      row.append(item);
      menu.append(row);
    }
  };

  const openKindMenu = () => {
    closeModelMenu();
    const menu = document.getElementById("executor-kind-menu");
    if (!menu || !current || select.disabled) return;
    menu.hidden = false;
    document.body.append(menu);
    placeMenu(menu, select.getBoundingClientRect(), 240);
    select.setAttribute("aria-expanded", "true");
    openMenu = { menu, kind: "__kind__", trigger: select };
    renderKindMenu();
  };

  select.addEventListener("click", () => {
    if (openMenu?.kind === "__kind__") {
      closeModelMenu();
      return;
    }
    openKindMenu();
  });

  save.addEventListener("click", async () => {
    if (!current || dirty === false) return;
    const payload = { employee: select.dataset.value || "", profiles: {} };
    for (const kind of current.kinds.filter((item) => item.selectable)) {
      // 本机池也存 model（2026-11-16 批1）；2026-11-19 起留空 = 跟随默认模型，
      // 选中清单里的模型时再带供应商 id（只给服务端解析 baseUrl/keyEnv 用）。
      const input = document.querySelector(`[data-model="${cssEscape(kind.id)}"]`);
      const seg = document.querySelector(`[data-perm="${cssEscape(kind.id)}"]`);
      const profile = { model: input?.value ?? "" };
      if (kind.id === "pool") profile.providerId = input?.dataset.providerId || "";
      const checked = seg?.querySelector('button[aria-checked="true"]');
      if (checked?.dataset.value) {
        profile.permission = checked.dataset.value;
      } else {
        // 老配置的值不在当前档位里（如豆包 read / OpenCode edit）：界面不画它，
        // 保存时原样带回，避免「只改了模型」却把权限静默改成 env 缺省（2026-11-23）。
        const previous = current.profiles?.[kind.id]?.permission;
        if (previous) profile.permission = previous;
      }
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

/** 本机池的清单来自已连接供应商目录（`GET /agent/model`），不 spawn CLI。 */
async function ensurePoolCatalog() {
  if (poolCatalog || poolCatalogPending) return;
  poolCatalogPending = true;
  try {
    const response = await request("/api/v1/agent/model", { cache: "no-store" });
    if (!response.ok) throw new Error(String(response.status));
    const body = await response.json().catch(() => ({}));
    const providers = Array.isArray(body.providers) ? body.providers : [];
    const entries = [];
    for (const provider of providers) {
      if (!provider || !Array.isArray(provider.models)) continue;
      for (const raw of provider.models) {
        const modelId = typeof raw === "string" ? raw : raw?.id;
        if (typeof modelId !== "string" || !modelId) continue;
        entries.push({
          providerId: String(provider.id || ""),
          providerName: String(provider.name || provider.id || ""),
          modelId,
          hasKey: provider.hasKey !== false,
        });
      }
    }
    poolCatalog = {
      entries,
      current: body.current || null,
      message: entries.length ? "" : "还没有已连接的模型：先到设置 → 模型里配供应商",
    };
  } catch (error) {
    poolCatalog = {
      entries: [],
      current: null,
      message:
        error.message === "forbidden"
          ? "没有权限读取模型清单"
          : "取清单失败，稍后再试",
    };
  } finally {
    poolCatalogPending = false;
    if (openMenu?.kind === "pool") renderModelMenu("pool");
  }
}

/** 拉清单（空 model = 只列清单，不真调模型）；同一 kind 并发去重。 */
async function ensureList(kind) {
  if (kind === "pool") {
    void ensurePoolCatalog();
    return;
  }
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

/** 把挂 body 的 fixed 面板贴到锚点正下方（放不下且上方够放就朝上开）。
 *  2026-11-21 从 openModelMenu 抽出来：默认派给谁的自绘面板共用同一条路。 */
function placeMenu(menu, rect, preferredWidth) {
  const width = Math.min(Math.max(rect.width, preferredWidth), window.innerWidth - 16);
  menu.style.width = `${Math.round(width)}px`;
  menu.style.left = `${Math.max(8, Math.min(Math.round(rect.left), window.innerWidth - width - 8))}px`;
  // 下方放不下（面板 300 高 + 间距）且上方够放就朝上开；否则朝下，让视口自己裁
  const openUp = window.innerHeight - rect.bottom < 316 && rect.top > 316;
  menu.style.top = `${Math.round(openUp ? rect.top - 6 : rect.bottom + 6)}px`;
  menu.style.transform = openUp ? "translateY(-100%)" : "";
}

function openModelMenu(kind) {
  closeModelMenu();
  const box = document.querySelector(`[data-model-box="${cssEscape(kind)}"]`);
  const menu = document.querySelector(`[data-model-menu="${cssEscape(kind)}"]`);
  if (!box || !menu) return;
  const trigger = box.querySelector("[data-model-toggle]");
  menu.hidden = false;
  document.body.append(menu);
  placeMenu(menu, box.getBoundingClientRect(), 340);
  // 2026-11-21（箭头统一批）：开合状态落在触发钮的 aria-expanded 上，箭头跟着翻
  trigger?.setAttribute("aria-expanded", "true");
  openMenu = { menu, kind, trigger, box };
  renderModelMenu(kind);
  void ensureList(kind);
}

function closeModelMenu() {
  if (!openMenu) return;
  openMenu.menu.hidden = true;
  openMenu.trigger?.setAttribute("aria-expanded", "false");
  openMenu = null;
}

function renderModelMenu(kind) {
  const menu = document.querySelector(`[data-model-menu="${cssEscape(kind)}"]`);
  if (!menu || menu.hidden) return;
  if (kind === "pool") {
    renderPoolModelMenu(menu);
    return;
  }
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

/**
 * 本机池的模型清单（2026-11-19 模型分工）：
 * 第一行「跟随默认模型」= 留空；其余行来自已连接供应商，点选后把 providerId 记到 input 上。
 */
function renderPoolModelMenu(menu) {
  const input = document.querySelector('[data-model="pool"]');
  menu.replaceChildren();
  const note = document.createElement("div");
  note.className = "executor-model-note";
  if (!poolCatalog) {
    note.textContent = "取清单中…";
    menu.append(note);
    return;
  }
  const filter = (input?.value ?? "").trim().toLowerCase();
  const entries = poolCatalog.entries.filter((entry) => {
    if (!filter) return true;
    return (
      entry.modelId.toLowerCase().includes(filter) ||
      entry.providerName.toLowerCase().includes(filter)
    );
  });
  const shown = entries.slice(0, 800);
  note.textContent = filter
    ? `匹配 ${entries.length} / ${poolCatalog.entries.length} 个`
    : poolCatalog.entries.length
      ? `共 ${poolCatalog.entries.length} 个已连接模型`
      : poolCatalog.message || "还没有已连接的模型";
  menu.append(note);

  if (!filter) {
    const follow = document.createElement("div");
    follow.className = "model-row";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "model-item";
    button.setAttribute("role", "option");
    const selected = (input?.value ?? "").trim() === "";
    button.setAttribute("aria-checked", String(selected));
    const name = document.createElement("span");
    name.className = "model-name";
    name.textContent = "跟随默认模型";
    const meta = document.createElement("span");
    meta.className = "model-meta";
    meta.textContent = poolCatalog.current?.modelId || "设置 → 模型";
    button.append(name, meta);
    button.addEventListener("click", () => {
      if (input) {
        input.value = "";
        delete input.dataset.providerId;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      closeModelMenu();
    });
    follow.append(button);
    menu.append(follow);
  }

  if (poolCatalog.entries.length > 0 && entries.length === 0) {
    menu.append(menuNote("没有匹配的模型名"));
    return;
  }
  const pickedModel = (input?.value ?? "").trim();
  const pickedProvider = input?.dataset.providerId || "";
  for (const entry of shown) {
    const row = document.createElement("div");
    row.className = "model-row";
    const item = document.createElement("button");
    item.type = "button";
    item.className = "model-item";
    item.setAttribute("role", "option");
    const selected =
      entry.modelId === pickedModel &&
      (!pickedProvider || entry.providerId === pickedProvider);
    item.setAttribute("aria-checked", String(selected));
    const name = document.createElement("span");
    name.className = "model-name";
    name.textContent = entry.modelId;
    const meta = document.createElement("span");
    meta.className = "model-meta";
    meta.textContent = entry.hasKey
      ? entry.providerName
      : `${entry.providerName} · 无 key`;
    item.append(name, meta);
    item.addEventListener("click", () => {
      if (input) {
        input.value = entry.modelId;
        // dispatch 的 input 监听会清掉 providerId（手打语义）；点选之后再补回来。
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dataset.providerId = entry.providerId;
      }
      closeModelMenu();
    });
    row.append(item);
    menu.append(row);
  }
  if (entries.length > shown.length) {
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
  // 触发区（模型输入框整块 / 默认派给谁的按钮）里按下不算外点：模型菜单在输入框
  // 打字要当筛选词用，不能把手按下去就关；触发钮自己再点一下走各自 click 的开合
  if (openMenu.box?.contains(target)) return;
  if (openMenu.trigger?.contains(target)) return;
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
  // 2026-11-23 按厂商收口：优先用服务端给的 permissionOptions（value 仍是内部三值，
  // label 是该 CLI 自己的档名）；没有该字段时回落旧的 permissions 三段，行为不变。
  const options =
    Array.isArray(kind.permissionOptions) && kind.permissionOptions.length > 0
      ? kind.permissionOptions
      : Array.isArray(kind.permissions)
        ? kind.permissions.map((value) => ({ value, label: PERMISSION_LABEL[value] || value }))
        : null;
  const permissionRow = options
    ? `<div class="divider"></div>
       <div class="row">
         <div class="row-main">
           <div class="row-label" data-tip="按该 CLI 实际支持的档位选择；不同 CLI 的档名与含义不同。">权限</div>
         </div>
         <div class="row-control">
           <div class="segmented slide" role="radiogroup" data-perm="${attr(kind.id)}" aria-label="${attr(kind.label)} 权限">
             ${options
               .map(
                 (option) =>
                   `<button type="button" data-value="${attr(option.value)}"${
                     option.hint ? ` data-tip="${attr(`${option.label}：${option.hint}`)}"` : ""
                   } aria-checked="${profile.permission === option.value}">${esc(option.label)}</button>`,
               )
               .join("")}
           </div>
         </div>
       </div>`
    : `<div class="divider"></div>
       <div class="row">
         <div class="row-main">
           <div class="row-label" data-tip="${attr(
             kind.id === "pool"
               ? "权限由池内工具白名单管：read / write / edit / bash / escalate。"
               : kind.note || "",
           )}">权限</div>
         </div>
         <div class="row-control"><span class="set-hint">${esc(
           kind.id === "pool" ? "池白名单管" : "固定全权",
         )}</span></div>
       </div>`;

  // 卡片标题的解释（额度 / 边界 / 留空语义）全收进 data-tip，不常驻。
  // 本机池的留空语义由服务端 kind.note 给（2026-11-19 模型分工），别在两端各写一份。
  const labelTips = [];
  if (kind.note) labelTips.push(kind.note);
  if (kind.id !== "pool") labelTips.push("模型留空 = 跟随该 CLI 自己的配置。");

  return `<div class="card executor-card" data-executor-card="${attr(kind.id)}">
    <div class="row">
      <div class="row-main">
        <div class="row-label" data-tip="${attr(labelTips.join("\n"))}">${esc(kind.label)}<span class="flag-tag accent" data-current-tag${isCurrent ? "" : " hidden"}>当前</span></div>
      </div>
      <div class="row-control">
        ${
          kind.id === "pool"
            ? `<div class="executor-model-row">
                 <div class="executor-model-box" data-model-box="${attr(kind.id)}">
                   <input class="set-input executor-model" data-model="${attr(kind.id)}"
                          value="${attr(profile.model ?? "")}"
                          placeholder="留空跟随默认模型"
                          aria-label="${attr(kind.label)} 的模型"
                          autocomplete="off" spellcheck="false" />
                   <button class="executor-model-toggle" type="button" data-model-toggle="${attr(kind.id)}"
                           aria-label="展开本机执行器池的模型清单"
                           data-tip="从已连接的供应商里选干活模型；第一行「跟随默认模型」= 跟设置 → 模型的默认。在输入框打字可筛选">${ARROW_SVG}</button>
                   <div class="executor-model-menu" data-model-menu="${attr(kind.id)}" hidden></div>
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
                 <button class="ghost executor-probe executor-probe-btn" type="button" data-probe="${attr(kind.id)}"
                         data-tip="填了模型就真调一次该 CLI 验证可用性（很小的请求，可能耗一点额度）；留空只拉清单">检测</button>
               </div>`
        }
      </div>
    </div>
    ${
      kind.id === "pool"
        ? ""
        : `<div class="set-hint executor-probe-status" data-probe-status="${attr(kind.id)}" hidden></div>`
    }
    ${permissionRow}
  </div>`;
}

function cssEscape(value) {
  return String(value).replace(/["\\]/g, "\\$&");
}
