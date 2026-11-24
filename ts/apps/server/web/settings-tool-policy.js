/**
 * 插件页「工具与命令」组 + 工具异常处理弹层（2026-11-24 M4）
 *
 * 口径见 docs/设计方案/2026-11-24-工具异常处理与超时转后台.md §4（UI）与 §3.5（端点）：
 * - 数据：`GET /api/v1/agent/tool-policy`；**404 = 总开关 TOOL_TIMEOUT_POLICY 关**，
 *   这时只画「未启用」占位卡，入口不消失（总开关卡本身由 flags 渲染，不在本模块）。
 * - 可配的只有「真有 I/O 等待、且能中止」的工具；其余工具逐条列出并写明为什么锁定，
 *   没有输入框——不造一个填了不生效的假开关。
 * - 保存走 `PUT /tool-policy`（局部更新；`null` = 删掉该条、回继承）。
 *   错误 toast 用服务端 message（tool_locked / on_timeout_unsupported / bad_timeout …）。
 *
 * 本模块是工具策略在前端的唯一编辑入口：
 * - 插件页：`renderToolPolicySection(container)` 由 settings-switches.js 在 flags 画完后调一次；
 *   `refreshToolPolicySection({enabled})` 由 toggleFlag 在总开关拨动后调（开 → 就地画，关 → 换占位卡）；
 *   组内顺序：说明卡 → 可配工具卡 → 锁定卡 → 注入卡（每轮记忆轻召回，只有预算一个字段）；
 * - 总开关浮层：`renderInlinePolicyPanel(container)` 列四个可配工具 + 轻召回，点「调整」复用同一弹层；
 * - 注入 → 工具：`toolPolicyLine(name)` 只读回显 + `openToolPolicyModal(name)` 打开同一个弹层。
 */

import { attr, esc } from "./markdown.js";
import { request } from "./net.js";
import { mountSegmented, switchMarkup, syncSegmented } from "./settings-atoms.js";
import { closeModal, openModal, toast } from "./ui-atoms.js";

const TOOL_POLICY_PATH = "/api/v1/agent/tool-policy";

/** 超时后的三种结算方式（服务端枚举，见方案 §5.1）。 */
const ON_TIMEOUT_LABEL = { fail: "失败", background: "转后台", cancel: "取消" };

/** effective.source 的人话（方案 §3.3）。 */
const SOURCE_LABEL = {
  tool: "本工具已设",
  group: "本组默认",
  legacy: "继承自记忆库设置",
  default: "代码默认",
};

/** 服务端没给 message 时的兜底文案（错误码见方案 §3.5）。 */
const ERROR_TEXT = {
  bad_request: "请求格式不对",
  unknown_tool: "服务端不认识这个工具",
  unknown_group: "服务端不认识这个能力组",
  unknown_injection: "服务端不认识这个注入项",
  tool_locked: "这个工具不提供超时",
  on_timeout_unsupported: "这个工具不支持所选的超时处理方式",
  bad_timeout: "超时时间不是有效数字",
  bad_notify: "完成通知必须是布尔值",
};

/* ── 数据缓存 ─────────────────────────────────────────────
 * 一次 GET 的结果服务两个页面：插件页卡片（工具 + 注入）与工具页只读回显。
 * 只有 404 会把缓存置空（= 总开关关）；读失败不覆盖上一次的成功结果，
 * 免得一次网络抖动把已画出来的卡片判成「未启用」。 */
let payloadCache = null;
let inflight = null;
/** name → GET 的 tools[] 条目；随 payloadCache 一起换。 */
let toolMap = new Map();
/** name → GET 的 injections[] 条目（当前只有每轮记忆轻召回）；随 payloadCache 一起换。 */
let injectionMap = new Map();

function storePayload(payload) {
  payloadCache = payload && typeof payload === "object" ? payload : null;
  if (!payloadCache) {
    toolMap = new Map();
    injectionMap = new Map();
    return payloadCache;
  }
  // 契约上 PUT 回 GET 同形；真回残缺时保留上一份名单，别让卡面瞬间失去数据。
  if (Array.isArray(payloadCache.tools)) {
    toolMap = new Map();
    for (const entry of payloadCache.tools) {
      if (entry && typeof entry.name === "string") toolMap.set(entry.name, entry);
    }
  }
  if (Array.isArray(payloadCache.injections)) {
    injectionMap = new Map();
    for (const entry of payloadCache.injections) {
      if (entry && typeof entry.name === "string") injectionMap.set(entry.name, entry);
    }
  }
  return payloadCache;
}

/** 读一次策略：404（总开关关）→ null；其它失败抛错。fresh=true 跳过进程内缓存。 */
async function loadToolPolicy({ fresh = false } = {}) {
  if (payloadCache && !fresh) return payloadCache;
  if (inflight) return inflight;
  inflight = (async () => {
    const response = await request(TOOL_POLICY_PATH, { cache: "no-store" });
    if (response.status === 404) return storePayload(null);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      throw new Error(String(data.message || `HTTP ${response.status}`));
    }
    return storePayload(data);
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

function toolPolicyEntry(name) {
  return toolMap.get(String(name || "")) || null;
}

function toolPolicyConfigurable(name) {
  return toolPolicyEntry(name)?.capabilities?.configurable === true;
}

/** 毫秒 → 展示秒数（整秒不带小数；8.5s 这类保留一位，与记忆页口径一致）。
 *  null = 显式不设默认（AGENT_BASH_TIMEOUT_S=0 的 legacy 形态），不假装成一个数字。 */
function secondsText(ms) {
  if (ms === null || ms === undefined) return "未设";
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return "—";
  const seconds = value / 1000;
  return `${Number.isInteger(seconds) ? seconds : Number(seconds.toFixed(1))}s`;
}

/** 卡面摘要：`900s · 转后台`。 */
function summaryOf(entry) {
  const effective = entry?.effective || {};
  const mode = ON_TIMEOUT_LABEL[effective.onTimeout] || String(effective.onTimeout || "—");
  return `${secondsText(effective.timeoutMs)} · ${mode}`;
}

function injectionEntry(name) {
  return injectionMap.get(String(name || "")) || null;
}

/** 注入卡面摘要：注入项不是工具调用，只有预算一个数（`8s`）。 */
function injectionSummaryOf(entry) {
  return secondsText(entry?.effective?.timeoutMs);
}

/**
 * 注入 → 工具页那一行只读文本（空串 = 不显示这一行）。
 * 可配工具给「900s · 转后台」；锁定工具按类别给一句最短的原因，完整 lockedReason 在插件页卡片上。
 */
function toolPolicyLine(name) {
  const entry = toolPolicyEntry(name);
  if (!entry || payloadCache?.enabled === false) return "";
  if (entry.capabilities?.configurable === true) return summaryOf(entry);
  if (entry.capabilities?.backgroundable === true) return "已是后台，超时在派活页";
  if (entry.category === "interactive" || entry.name === "ask_user") return "必须人答，不提供超时";
  return "本地同步，不提供超时";
}

/* ── 插件页「工具与命令」组 ─────────────────────────────── */

/** 本次渲染的代际：flags 整页重画后，上一轮 GET 回来不能往新 DOM 里插旧结果。 */
let renderToken = 0;
/** 浮层内嵌面板的代际：浮层里连拨总开关时，旧请求不能覆盖新状态。 */
let inlineToken = 0;

function policyGroupTitle(title) {
  return `<div class="flag-group-head">
    <div class="flag-group-title" data-tip="${attr(
      "按工具逐个设「等多久、超时后怎么办、完成要不要通知」。只有真有等待面、且能中止的工具可配；其余逐条写清为什么不给——填了不生效的开关比没有更糟。",
    )}">${esc(title)}</div>
    <div class="flag-group-count" data-policy-count></div>
  </div>`;
}

function toolCardMarkup(entry) {
  const name = String(entry.name || "");
  const label = entry.label && entry.label !== name ? String(entry.label) : "";
  return `<div class="card tool-policy-item">
    <button class="tool-policy-item-main" type="button" data-tool-policy-detail="${attr(name)}"
      aria-haspopup="dialog" aria-label="调整 ${attr(label || name)} 的异常处理">
      <span class="tool-policy-head">
        <span class="tool-policy-name">${esc(name)}</span>
        ${label ? `<span class="tool-policy-label">${esc(label)}</span>` : ""}
        <span class="tool-policy-summary" data-tool-policy-summary="${attr(name)}">${esc(summaryOf(entry))}</span>
        <span class="tool-policy-more" aria-hidden="true">›</span>
      </span>
    </button>
  </div>`;
}

function lockedCardMarkup(entry) {
  const name = String(entry.name || "");
  const label = entry.label && entry.label !== name ? String(entry.label) : "";
  return `<div class="card tool-policy-item is-locked">
    <div class="tool-policy-item-body">
      <span class="tool-policy-head">
        <span class="tool-policy-name">${esc(name)}</span>
        ${label ? `<span class="tool-policy-label">${esc(label)}</span>` : ""}
        <span class="flag-tag">锁定</span>
      </span>
      <span class="tool-policy-reason">${esc(String(entry.lockedReason || "这个工具没有可中止的等待面，不提供超时。"))}</span>
    </div>
  </div>`;
}

/** 注入项卡（当前只有「每轮记忆轻召回」）：不是工具调用，卡面只有一个预算数字。 */
function injectionCardMarkup(entry) {
  const name = String(entry.name || "");
  const label = String(entry.label || name);
  const desc = String(entry.desc || "");
  return `<div class="card tool-policy-item is-injection">
    <button class="tool-policy-item-main" type="button" data-tool-policy-injection="${attr(name)}"
      aria-haspopup="dialog" aria-label="调整 ${attr(label)} 的预算">
      <span class="tool-policy-head">
        <span class="tool-policy-name">${esc(label)}</span>
        <span class="tool-policy-summary" data-tool-policy-injection-summary="${attr(name)}">${esc(
          injectionSummaryOf(entry),
        )}</span>
        <span class="tool-policy-more" aria-hidden="true">›</span>
      </span>
      ${desc ? `<span class="tool-policy-reason">${esc(desc)}</span>` : ""}
    </button>
  </div>`;
}

function sectionHtml(payload, error) {
  const tools = Array.isArray(payload?.tools) ? payload.tools : [];
  const configurable = tools.filter((entry) => entry?.capabilities?.configurable === true);
  const locked = tools.filter((entry) => entry?.capabilities?.configurable !== true);
  const injections = Array.isArray(payload?.injections) ? payload.injections : [];
  const cards = error
    ? `<div class="card tool-policy-note">
        <span class="tool-policy-note-title">工具异常处理</span>
        <span class="tool-policy-note-text is-error">读不到工具策略：${esc(error)}</span>
      </div>`
    : [
        `<div class="card tool-policy-note">
          <span class="tool-policy-note-title">工具异常处理</span>
          <span class="tool-policy-note-text">超时后失败 / 转后台 / 取消，按工具分别设。</span>
        </div>`,
        ...configurable.map(toolCardMarkup),
        ...locked.map(lockedCardMarkup),
        ...injections.map(injectionCardMarkup),
        tools.length ? "" : `<div class="card tool-policy-note">
          <span class="tool-policy-note-text">服务端没有回工具清单。</span>
        </div>`,
      ].join("");
  return `<section class="flag-section tool-policy-section" id="tool-policy-section">
    ${policyGroupTitle("工具与命令")}
    <div class="flag-grid">${cards}</div>
  </section>`;
}

/** 「始终开启」组是既有渲染器画的；新组插在它前面（方案 §4.2 的位置口径）。 */
function alwaysOnSection(container) {
  for (const section of container.querySelectorAll("section.flag-section")) {
    const title = section.querySelector(".flag-group-title")?.textContent?.trim();
    if (title === "始终开启") return section;
  }
  return null;
}

/** 把一段 section HTML 插在「始终开启」之前（没有就追加），并接上事件。 */
function insertPolicySection(container, html) {
  const wrapper = document.createElement("div");
  wrapper.innerHTML = html.trim();
  const section = wrapper.firstElementChild;
  if (!section) return null;
  const anchor = alwaysOnSection(container);
  if (anchor) container.insertBefore(section, anchor);
  else container.append(section);
  wirePolicySection(section);
  return section;
}

/** 总开关关（GET 404）时的占位组：入口不消失。点卡滚到「自主与派活」里的总开关，只指路、不改值。 */
function disabledSectionHtml() {
  return `<section class="flag-section tool-policy-section" id="tool-policy-section">
    ${policyGroupTitle("工具与命令")}
    <div class="flag-grid">
      <div class="card tool-policy-item is-off">
        <button class="tool-policy-item-main" type="button" data-tool-policy-enable
          aria-label="去打开「工具异常处理」总开关">
          <span class="tool-policy-head">
            <span class="tool-policy-name">工具异常处理 · 未启用</span>
            <span class="tool-policy-more" aria-hidden="true">›</span>
          </span>
          <span class="tool-policy-reason">先在插件页打开「工具异常处理」，再回来这里按工具配置</span>
        </button>
      </div>
    </div>
  </section>`;
}

/** 占位卡点开：滚到总开关卡并闪一下；搜索藏着它时先临时显出来（下次输入会重新过滤）。 */
function revealToolPolicyFlag() {
  const main = document.querySelector('[data-flag-detail="TOOL_TIMEOUT_POLICY"]');
  const card = main instanceof Element ? main.closest(".flag-item") : null;
  if (!card) {
    toast("先到「自主与派活」组打开「工具异常处理」");
    return;
  }
  card.hidden = false;
  const section = card.closest("section.flag-section");
  if (section) section.hidden = false;
  card.scrollIntoView({ block: "center" });
  card.classList.add("is-flash-hit");
  window.setTimeout(() => card.classList.remove("is-flash-hit"), 1800);
  if (main instanceof HTMLElement) main.focus({ preventScroll: true });
}

function wirePolicySection(section) {
  const count = section.querySelector("[data-policy-count]");
  if (count) count.textContent = String(section.querySelectorAll(".tool-policy-item").length);
  section.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("[data-tool-policy-enable]")) {
      revealToolPolicyFlag();
      return;
    }
    const injectionButton = target?.closest("[data-tool-policy-injection]");
    if (injectionButton) {
      const name = injectionButton.getAttribute("data-tool-policy-injection");
      const entry = name ? injectionEntry(name) : null;
      if (entry) openInjectionModal(entry);
      return;
    }
    const button = target?.closest("[data-tool-policy-detail]");
    if (!button) return;
    const name = button.getAttribute("data-tool-policy-detail");
    if (name) void openToolPolicyModal(name);
  });
}

/** settings-switches.js 在 flags 画完后调用一次：自己找位置、自己决定画什么。 */
async function renderToolPolicySection(container) {
  if (!(container instanceof HTMLElement)) return;
  const token = ++renderToken;
  let payload = null;
  let error = "";
  try {
    payload = await loadToolPolicy({ fresh: true });
  } catch (err) {
    if (err?.message === "forbidden") return;
    error = String(err?.message || err);
  }
  if (token !== renderToken || !container.isConnected) return;
  container.querySelector("#tool-policy-section")?.remove();
  // 404 / enabled:false = 总开关关：组不消失，画占位卡（入口不能看着像功能挂了）。
  if (!error && (!payload || payload.enabled === false)) {
    insertPolicySection(container, disabledSectionHtml());
    return;
  }
  insertPolicySection(container, sectionHtml(payload, error));
}

/**
 * 总开关拨动后的即时刷新（settings-switches.toggleFlag 调用，2026-11-24 体验项）。
 * - 开：拉一次 GET 就地插入「工具与命令」组（工具卡 + 注入卡）；
 * - 关：作废在途的开启请求，立刻换成「未启用」占位卡（组不消失）。
 * 不整页重画 flags——卡片墙的滚动位置与其它开关的显隐都保持不动。
 */
async function refreshToolPolicySection({ enabled } = {}) {
  const container = document.getElementById("flags-card");
  if (!(container instanceof HTMLElement)) return;
  if (enabled === false) {
    // 关：不等网络，直接换占位卡；缓存清空，工具页的只读回显随之消失。
    ++renderToken;
    storePayload(null);
    container.querySelector("#tool-policy-section")?.remove();
    insertPolicySection(container, disabledSectionHtml());
    return;
  }
  await renderToolPolicySection(container);
}

/** 保存 / 恢复默认后，原地刷新卡面摘要（工具与注入）与工具页只读行（不整页重画）。 */
function refreshPolicyViews() {
  for (const node of document.querySelectorAll("[data-tool-policy-summary]")) {
    if (!(node instanceof HTMLElement)) continue;
    const entry = toolPolicyEntry(node.dataset.toolPolicySummary);
    if (entry) node.textContent = summaryOf(entry);
  }
  for (const node of document.querySelectorAll("[data-tool-policy-injection-summary]")) {
    if (!(node instanceof HTMLElement)) continue;
    const entry = injectionEntry(node.dataset.toolPolicyInjectionSummary);
    if (entry) node.textContent = injectionSummaryOf(entry);
  }
  for (const node of document.querySelectorAll("[data-tool-policy-line]")) {
    if (!(node instanceof HTMLElement)) continue;
    node.textContent = toolPolicyLine(node.dataset.toolPolicyLine);
  }
}

/* ── 弹层（插件页与工具页共用）──────────────────────────── */

/** 一句后果说明：选哪个 onTimeout 就说什么后果，不写泛泛的「超时会被处理」。 */
function effectText(entry, onTimeout, seconds, notify) {
  if (onTimeout === "background") {
    return `超时后把同一条命令转到后台重跑；前 ${seconds || "—"} 秒的输出不会带过去，完成时${
      notify ? "在会话里留一条记录" : "只写进后台任务列表，不打扰会话"
    }。`;
  }
  if (onTimeout === "cancel") {
    return "超时后按策略取消，模型会被告知不要重试；能中止的就中止（kill 子进程 / 断开请求）。";
  }
  if (entry?.category === "evidence") {
    return "超时后这次调用按失败结算，模型会看到「超时」说明；检索 / 搜索结果是当轮回答的证据，不会转后台。";
  }
  return "超时后这次调用按失败结算，模型会收到可行动的「超时」说明；能中止的就中止，不能中止的只是不再等。";
}

function openLockedModal(entry) {
  const name = String(entry.name || "");
  const label = entry.label && entry.label !== name ? String(entry.label) : name;
  openModal(`异常处理 · ${label}`, (body) => {
    body.innerHTML = `<div class="tool-policy-lockbox">
      <p class="tool-policy-meta">为什么不提供超时</p>
      <p class="tool-policy-effect">${esc(
        String(entry.lockedReason || "这个工具没有可中止的等待面；加超时只能「不再等」，停不下手里的活。"),
      )}</p>
      <p class="tool-policy-meta">如果它真的很慢：先查磁盘 / 网络盘 / 上游，不要靠超时兜底。</p>
    </div>
    <div class="modal-actions"><button class="ghost" type="button" data-modal-ok>关闭</button></div>`;
    body.querySelector("[data-modal-ok]")?.addEventListener("click", closeModal);
  });
}

function openEditableModal(entry) {
  const name = String(entry.name || "");
  const label = entry.label && entry.label !== name ? String(entry.label) : name;
  const capabilities = entry.capabilities || {};
  const effective = entry.effective || {};
  const ranges = entry.ranges || {};
  const minSeconds = Math.max(1, Math.ceil((Number(ranges.min) || 1000) / 1000));
  const maxSeconds = Math.max(minSeconds, Math.floor((Number(ranges.max) || 120000) / 1000));
  const clamp = (seconds) => Math.min(maxSeconds, Math.max(minSeconds, seconds));
  // effective.timeoutMs 可以是 null（显式不设默认，仅 AGENT_BASH_TIMEOUT_S=0 的 legacy 形态）：
  // 输入框留空，保存时不带 timeoutMs，保持「不设默认」而不是偷偷换成范围下限。
  const initialMs = Number(effective.timeoutMs);
  let seconds = Number.isFinite(initialMs) && initialMs > 0 ? clamp(Math.round(initialMs / 1000)) : 0;
  const secondsValue = seconds > 0 ? String(seconds) : "";
  // fail 恒有；background / cancel 只给 shell 那类工具。catalog 里 recall / web_search 虽然
  // abortable，但 allowedOnTimeout 是 fail-only（payload 不带这个字段），多画一个选项只会在
  // PUT 换回 on_timeout_unsupported —— 2026-11-24 读 tool-policy.ts 实现核对。
  const modes = ["fail"];
  if (capabilities.backgroundable === true) {
    modes.push("background");
    if (capabilities.abortable === true) modes.push("cancel");
  }
  let onTimeout = modes.includes(effective.onTimeout) ? effective.onTimeout : "fail";
  let notify = effective.notify === true;
  const source = SOURCE_LABEL[effective.source] || "";

  openModal(`异常处理 · ${label}`, (body) => {
    body.innerHTML = `<div class="tool-policy-form">
      <div class="tool-policy-field">
        <span class="tool-policy-field-label" id="tool-policy-timeout-label">超时</span>
        <span class="tool-policy-field-control">
          <input class="set-input tool-policy-seconds" id="tool-policy-seconds" type="number" inputmode="numeric"
            min="${minSeconds}" max="${maxSeconds}" step="1" value="${secondsValue}" placeholder="不设"
            aria-labelledby="tool-policy-timeout-label">
          <span class="tool-policy-unit">秒</span>
        </span>
      </div>
      <div class="tool-policy-field">
        <span class="tool-policy-field-label">超时后</span>
        <div class="segmented slide" role="radiogroup" aria-label="超时后怎么处理" data-policy-modes>
          ${modes
            .map(
              (mode) =>
                `<button type="button" data-on-timeout="${attr(mode)}" aria-checked="${onTimeout === mode}">${esc(
                  ON_TIMEOUT_LABEL[mode] || mode,
                )}</button>`,
            )
            .join("")}
        </div>
      </div>
      <div class="tool-policy-field">
        <span class="tool-policy-field-label">完成通知</span>
        ${switchMarkup(notify, { label: "完成通知", attrs: "data-policy-notify" })}
      </div>
      <p class="tool-policy-effect" data-policy-effect></p>
      <p class="tool-policy-meta">完成通知只对「转后台」有意义：开着会在完成时写回会话并唤醒；关掉只留后台任务列表。${
        source ? `当前值来自：${esc(source)}。` : ""
      }</p>
      <div class="modal-actions">
        <button class="ghost" type="button" data-policy-restore>恢复默认</button>
        <button class="modal-primary" type="button" data-policy-save>保存</button>
      </div>
    </div>`;

    const input = body.querySelector("#tool-policy-seconds");
    const effect = body.querySelector("[data-policy-effect]");
    const modesBox = body.querySelector("[data-policy-modes]");
    const notifySwitch = body.querySelector("[data-policy-notify]");
    const save = body.querySelector("[data-policy-save]");
    const restore = body.querySelector("[data-policy-restore]");

    const paintEffect = () => {
      if (effect) effect.textContent = effectText(entry, onTimeout, seconds, notify);
    };
    paintEffect();

    input?.addEventListener("input", () => {
      const value = Math.round(Number(input.value));
      seconds = Number.isFinite(value) ? value : 0;
      paintEffect();
    });

    for (const button of modesBox?.querySelectorAll("[data-on-timeout]") || []) {
      button.addEventListener("click", () => {
        onTimeout = button.dataset.onTimeout || "fail";
        for (const item of modesBox.querySelectorAll("[data-on-timeout]")) {
          item.setAttribute("aria-checked", String(item === button));
        }
        syncSegmented(modesBox);
        paintEffect();
      });
    }
    if (modesBox) mountSegmented(modesBox);

    notifySwitch?.addEventListener("click", () => {
      notify = notifySwitch.getAttribute("aria-checked") !== "true";
      notifySwitch.setAttribute("aria-checked", String(notify));
      paintEffect();
    });

    save?.addEventListener("click", () => {
      const text = String(input?.value ?? "").trim();
      // 空 = 不设默认（effective.timeoutMs === null 的形态）：只存另外两个字段。
      if (!text) {
        seconds = 0;
        void savePolicyPatch("tools", name, { onTimeout, notify }, body);
        return;
      }
      const raw = Math.round(Number(text));
      if (!Number.isFinite(raw) || raw <= 0) {
        toast("超时时间要填秒数（正整数）；留空 = 不设默认");
        input?.focus();
        return;
      }
      const clamped = clamp(raw);
      if (input) input.value = String(clamped);
      seconds = clamped;
      void savePolicyPatch("tools", name, { timeoutMs: clamped * 1000, onTimeout, notify }, body);
    });
    restore?.addEventListener("click", () => void savePolicyPatch("tools", name, null, body));
  });
}

/**
 * 注入项弹层（当前只有每轮记忆轻召回）：不是工具调用，只有「超时」一个字段。
 * 到点静默跳过本轮，没有失败 / 转后台 / 取消——不要在这里画不存在的选项。
 */
function openInjectionModal(entry) {
  const name = String(entry.name || "");
  const label = String(entry.label || name);
  const ranges = entry.ranges || {};
  const minMs = Number(ranges.min) > 0 ? Number(ranges.min) : 500;
  const maxMs = Math.max(minMs, Number(ranges.max) > 0 ? Number(ranges.max) : 30000);
  const clampMs = (ms) => Math.min(maxMs, Math.max(minMs, ms));
  const effective = entry.effective || {};
  const initialMs = clampMs(Number(effective.timeoutMs) || 8000);
  // 秒展示：min 可能是 500ms，所以保留小数（整秒不带 .0）。
  const secondsLabel = (ms) => {
    const seconds = ms / 1000;
    return Number.isInteger(seconds) ? String(seconds) : String(Number(seconds.toFixed(2)));
  };

  openModal(`预算 · ${label}`, (body) => {
    body.innerHTML = `<div class="tool-policy-form">
      <div class="tool-policy-field">
        <span class="tool-policy-field-label" id="tool-policy-injection-label">超时</span>
        <span class="tool-policy-field-control">
          <input class="set-input tool-policy-seconds" id="tool-policy-injection-seconds" type="number"
            inputmode="decimal" min="${secondsLabel(minMs)}" max="${secondsLabel(maxMs)}" step="0.5"
            value="${secondsLabel(initialMs)}" aria-labelledby="tool-policy-injection-label">
          <span class="tool-policy-unit">秒</span>
        </span>
      </div>
      <p class="tool-policy-effect">${esc(
        String(entry.desc || "每轮注入的检索预算；超时会静默跳过本轮，不打断对话。"),
      )}</p>
      <p class="tool-policy-meta">只有预算一个字段：到点静默跳过本轮，不打断对话；没有失败 / 转后台 / 取消。保存后下一轮生效。</p>
      <div class="modal-actions">
        <button class="ghost" type="button" data-policy-restore>恢复默认</button>
        <button class="modal-primary" type="button" data-policy-save>保存</button>
      </div>
    </div>`;

    const input = body.querySelector("#tool-policy-injection-seconds");
    body.querySelector("[data-policy-save]")?.addEventListener("click", () => {
      const raw = Number(String(input?.value ?? "").trim());
      if (!Number.isFinite(raw) || raw <= 0) {
        toast("超时时间要填秒数（可以带小数）");
        input?.focus();
        return;
      }
      const ms = clampMs(Math.round(raw * 1000));
      if (input) input.value = secondsLabel(ms);
      void savePolicyPatch("injections", name, { timeoutMs: ms }, body);
    });
    body.querySelector("[data-policy-restore]")?.addEventListener("click", () => {
      void savePolicyPatch("injections", name, null, body);
    });
  });
}

/** 保存一条策略：namespace = "tools" | "injections"；policy=null = 删条目、回继承。 */
async function savePolicyPatch(namespace, name, policy, body) {
  const save = body.querySelector("[data-policy-save]");
  const restore = body.querySelector("[data-policy-restore]");
  for (const button of [save, restore]) if (button) button.disabled = true;
  if (save && policy) save.textContent = "保存中…";
  try {
    const response = await request(TOOL_POLICY_PATH, {
      method: "PUT",
      body: JSON.stringify({ [namespace]: { [name]: policy } }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      // 错误码由服务端定；message 人话优先，码只做兜底（方案 §3.5）。
      toast(String(data.message || ERROR_TEXT[data.error] || `没存成：HTTP ${response.status}`));
      return;
    }
    storePayload(data);
    closeModal();
    toast(policy ? "已保存，下一轮生效" : "已恢复默认（回继承）");
    refreshPolicyViews();
  } catch (error) {
    if (error.message !== "forbidden") toast(`没存成：${error.message}`);
  } finally {
    for (const button of [save, restore]) if (button) button.disabled = false;
    if (save && policy) save.textContent = "保存";
  }
}

/**
 * 总开关浮层里的内嵌快捷面板（2026-11-24）：点开总开关卡就能看到四个可配工具 + 轻召回，
 * 点「调整」复用插件页同一个弹层。master 关（GET 404）只给一行提示。
 * 容器随浮层关闭被移除：await 前后各判断一次 isConnected，别往已卸载的 DOM 里写。
 */
async function renderInlinePolicyPanel(container) {
  if (!(container instanceof HTMLElement)) return;
  const token = ++inlineToken;
  let payload = null;
  let error = "";
  try {
    payload = await loadToolPolicy({ fresh: true });
  } catch (err) {
    if (err?.message === "forbidden") return;
    error = String(err?.message || err);
  }
  if (token !== inlineToken || !container.isConnected) return;
  if (error) {
    container.innerHTML = `<p class="set-hint is-error">读不到工具策略：${esc(error)}</p>`;
    return;
  }
  if (!payload || payload.enabled === false) {
    container.innerHTML = `<p class="set-hint">打开上面的开关后，可在这里按工具配置超时与超时后行为。</p>`;
    return;
  }
  const tools = (Array.isArray(payload.tools) ? payload.tools : []).filter(
    (entry) => entry?.capabilities?.configurable === true,
  );
  const injections = Array.isArray(payload.injections) ? payload.injections : [];
  const rows = [
    ...tools.map(
      (entry) => `<button class="tool-policy-inline-row" type="button" data-inline-tool="${attr(entry.name)}">
        <span class="tool-policy-inline-name">${esc(String(entry.label || entry.name))}</span>
        <span class="tool-policy-inline-summary">${esc(summaryOf(entry))}</span>
        <span class="tool-policy-inline-more">调整 ›</span>
      </button>`,
    ),
    ...injections.map(
      (entry) => `<button class="tool-policy-inline-row is-injection" type="button" data-inline-injection="${attr(
        entry.name,
      )}">
        <span class="tool-policy-inline-name">${esc(String(entry.label || entry.name))}</span>
        <span class="tool-policy-inline-summary">${esc(injectionSummaryOf(entry))}</span>
        <span class="tool-policy-inline-more">调整 ›</span>
      </button>`,
    ),
  ];
  container.innerHTML = rows.length
    ? `<div class="tool-policy-inline">${rows.join("")}</div>`
    : `<p class="set-hint">服务端没有回可配置的工具。</p>`;
  if (container.dataset.inlineWired === "1") return;
  container.dataset.inlineWired = "1";
  container.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const tool = target?.closest("[data-inline-tool]");
    if (tool) {
      void openToolPolicyModal(tool.getAttribute("data-inline-tool") || "");
      return;
    }
    const injection = target?.closest("[data-inline-injection]");
    if (!injection) return;
    const entry = injectionEntry(injection.getAttribute("data-inline-injection") || "");
    if (entry) openInjectionModal(entry);
  });
}

/** 打开某个工具的异常处理弹层（插件页卡片与工具页「调整」共用）。 */
async function openToolPolicyModal(name) {
  if (!name) return;
  let payload = null;
  try {
    payload = await loadToolPolicy();
  } catch (error) {
    if (error.message !== "forbidden") toast(`读不到工具策略：${error.message}`);
    return;
  }
  if (!payload || payload.enabled === false) {
    toast("工具异常处理没启用：先去插件页打开总开关");
    return;
  }
  const entry = toolMap.get(String(name));
  if (!entry) {
    toast("服务端没有这个工具的策略");
    return;
  }
  if (entry.capabilities?.configurable === true) openEditableModal(entry);
  else openLockedModal(entry);
}

export {
  loadToolPolicy,
  openToolPolicyModal,
  refreshToolPolicySection,
  renderInlinePolicyPanel,
  renderToolPolicySection,
  toolPolicyConfigurable,
  toolPolicyLine,
};
