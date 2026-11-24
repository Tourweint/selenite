/**
 * 供应商 id / keyEnv / 模型编辑
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { attr } from "./markdown.js";
import { request } from "./net.js";
import { setModalHint } from "./project-modal.js";
import { parseModelText } from "./provider-save.js";
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, currentProviderFormTarget, formatTokenCount, providerErrorText, templateLabel, templatePlan, templatePlanByBaseUrl, templatePlans } from "./providers.js";
import { mountSegmented, syncSegmented } from "./settings-atoms.js";
import { THINKING_LABELS, THINKING_LEVELS } from "./shell.js";
import { state } from "./state.js";
import { closeModal, openModal } from "./ui-atoms.js";


/* ── 供应商 id / keyEnv 的前端生成（2026-11-05 H1）────────
 * keyEnv 要写成 LIFEDIARY_KEY_<ID大写>，而直填密钥必须先知道 id；
 * 所以新建时就按服务端 slugify / uniqueId 的同一规则先把 id 定下来，
 * POST 时显式带上（服务端已有同名 id 就按更新处理，这里先去重）。
 * 连字符转下划线是因为环境变量名只允许 [A-Z0-9_]。 */
const PROVIDER_RESERVED_IDS = new Set(["faux", "mock"]);

function providerSlug(name) {
  const base = String(name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  if (base) return base;
  // 中文名 slug 为空时给一个稳定兜底（不能用时间戳：同一次保存里要算两次 id）
  let hash = 0;
  for (const char of String(name || "")) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return `provider-${hash.toString(36)}`;
}

/** `preferred` = 模板自带的 id（deepseek / zhipu…）：用它 keyEnv 才干净
 *  （LIFEDIARY_KEY_DEEPSEEK 而不是从中文名哈希出来的 provider-xxxx）；被占了就退回 slug。 */
function nextProviderId(name, preferred = "") {
  const taken = new Set((state.providers || []).map((provider) => provider.id));
  const wanted = String(preferred || "");
  if (wanted && !PROVIDER_RESERVED_IDS.has(wanted) && !taken.has(wanted)) return wanted;
  let base = providerSlug(name);
  if (PROVIDER_RESERVED_IDS.has(base)) base = `${base}-provider`;
  if (!taken.has(base)) return base;
  let index = 2;
  while (taken.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

/** 同一个模板可以建第二家（比如再接一个本地网关的另一档端口）。
 *  名字重了就给「 2 / 3…」后缀——左栏两行同名、id 又藏起来了，不区分根本点不清谁是谁。 */
function nextProviderName(name) {
  const base = String(name || "").trim();
  if (!base) return base;
  const used = new Set((state.providers || []).map((provider) => String(provider.name || "").trim()));
  if (!used.has(base)) return base;
  let index = 2;
  while (used.has(`${base} ${index}`)) index += 1;
  return `${base} ${index}`;
}

function providerKeyEnv(id) {
  return `LIFEDIARY_KEY_${String(id).toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/** 表单骨架：结构只建一次，之后切供应商只填值（不重建 = 不闪） */
function providerFormMarkup() {
  return `<div class="svc-form">
    <div class="svc-form-head">
      <button class="svc-back" type="button" id="pv-back" aria-label="返回模板选择" title="返回模板选择" hidden>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="m12 19-7-7 7-7"/>
          <path d="M19 12H5"/>
        </svg>
      </button>
      <div class="row-main">
        <div class="set-card-title" data-tip="供应商的地址与密钥：API Key 只落本机环境变量，不写进档案；标「默认」的是新对话默认用的那家。"><span id="pv-title">供应商</span><span class="pill-tag" id="pv-default" hidden>默认</span></div>
        <div class="set-hint" id="pv-new-hint" hidden></div>
      </div>
    </div>
    <label class="field"><span>名称</span>
      <input id="pv-name" type="text" maxlength="80" placeholder="例如：百炼" />
    </label>
    <div class="field" id="pv-plan-field" hidden><span>套餐</span>
      <div class="segmented slide" id="pv-plan" role="radiogroup" aria-label="套餐"></div>
    </div>
    <label class="field"><span>Base URL</span>
      <input id="pv-base" type="text" spellcheck="false" placeholder="https://api.example.com/v1" />
    </label>
    <div class="field" id="pv-key-api">
      <span>API Key<a class="field-link" id="pv-keylink" href="#" target="_blank" rel="noreferrer" hidden>获取 Key ↗</a></span>
      <div class="secret-wrap">
        <input id="pv-apikey" type="password" autocomplete="new-password" spellcheck="false"
               aria-label="API Key" placeholder="sk-…" />
        <button class="secret-eye" type="button" id="pv-eye" aria-label="显示密钥" title="显示密钥" aria-pressed="false">
          <svg class="eye-show" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
          <svg class="eye-hide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" hidden>
            <path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/>
            <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/>
            <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/>
            <path d="m2 2 20 20"/>
          </svg>
        </button>
      </div>
    </div>
    <label class="field" id="pv-key-env" hidden><span>密钥环境变量名</span>
      <input id="pv-keyenv" class="is-mono" type="text" spellcheck="false" placeholder="DASHSCOPE_API_KEY" />
      <span class="field-hint">这版服务端还没开放密钥直填：变量名填这里，值写进 .env。</span>
    </label>
    <div class="field">
      <div class="field-head">
        <span>模型</span>
        <button class="ghost svc-model-add" type="button" id="pv-add-model">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
          添加模型
        </button>
      </div>
      <div class="svc-model-list" id="pv-model-list"></div>
    </div>
    <div class="svc-form-actions">
      <span class="set-hint" id="pv-hint"></span>
      <button class="ghost is-danger" type="button" id="pv-delete" hidden>删除</button>
      <button class="ghost" type="button" id="pv-cancel">取消</button>
      <button class="btn-primary" type="button" id="pv-save">保存</button>
    </div>
  </div>`;
}

/** 原位填值：只改 value / checked / 文本，不动 DOM 结构（滑行/展开动画都还在） */
function fillProviderForm(host, provider, template) {
  const isTemplate = Boolean(template && template.id !== "custom");
  const isEdit = Boolean(provider);
  // 套餐（按量 / Token Plan / Coding Plan…）：同一家的不同套餐是不同端点、不同 Key。
  // 只在新建时给选择器；编辑既有供应商只看 Base URL，不让人手滑把地址换掉。
  const plans = isTemplate ? templatePlans(template) : [];
  if (!isEdit && isTemplate && state.providerPlanTemplate !== template.id) {
    state.providerPlanTemplate = template.id;
    state.providerPlanId = plans[0] ? plans[0].id : "";
  }
  const plan = templatePlan(template, state.providerPlanId);
  const name = provider ? provider.name : isTemplate ? nextProviderName(template.name) : "";
  const baseUrl = provider ? provider.baseUrl : isTemplate ? plan.baseUrl : "";
  const id = provider
    ? provider.id
    : nextProviderId(name || "provider", isTemplate ? template.id : "");
  const q = (selector) => host.querySelector(selector);
  const setValue = (selector, value) => {
    const node = q(selector);
    if (node && node.value !== value) node.value = value;
  };

  const back = q("#pv-back");
  if (back) back.hidden = isEdit;
  const title = q("#pv-title");
  if (title) title.textContent = isEdit ? "编辑供应商" : "新建供应商";
  const badge = q("#pv-default");
  if (badge) badge.hidden = !(isEdit && provider.isDefault);
  const newHint = q("#pv-new-hint");
  if (newHint) {
    // 自建供应商没有可说的：Key 落哪是本机常识，不占一行
    newHint.hidden = isEdit || !isTemplate;
    if (isTemplate) {
      // 套餐自带清单的不拉；按量没清单的靠保存后拉 /models——先说清楚，别让人以为漏填
      newHint.textContent = (plan.models || []).length
        ? `基于「${templateLabel(template, plan)}」，保存前都能改`
        : `基于「${template.name}」模板：粘上 Key 保存，模型清单自动从上游拉`;
    }
  }

  // 套餐选择器：只有一档（或地址型的自定义模板）就整行藏掉
  const planField = q("#pv-plan-field");
  const planBox = q("#pv-plan");
  if (planField && planBox) {
    const showPlans = !isEdit && plans.length > 1;
    planField.hidden = !showPlans;
    if (showPlans) {
      const signature = plans.map((item) => item.id).join("|");
      if (planBox.dataset.plans !== signature) {
        planBox.dataset.plans = signature;
        planBox.replaceChildren(
          ...plans.map((item) => {
            const button = document.createElement("button");
            button.type = "button";
            button.dataset.plan = item.id;
            button.setAttribute("role", "radio");
            button.setAttribute("aria-checked", "false");
            button.textContent = item.name;
            return button;
          }),
        );
        mountSegmented(planBox);
      }
      for (const button of planBox.querySelectorAll("button")) {
        button.setAttribute("aria-checked", String(button.dataset.plan === plan.id));
      }
      syncSegmented(planBox, { animate: false });
    }
  }

  // 申请 Key 的入口：套餐 / 模板（或地址对得上的老供应商）给了就给，不用用户自己找控制台
  const keyLink = q("#pv-keylink");
  if (keyLink) {
    const matched = isTemplate
      ? { plan, template }
      : provider
        ? templatePlanByBaseUrl(provider.baseUrl)
        : null;
    const keyUrl = (matched && (matched.plan.keyUrl || matched.template.keyUrl)) || "";
    keyLink.hidden = !keyUrl;
    if (keyUrl) keyLink.href = keyUrl;
  }

  setValue("#pv-name", name);
  setValue("#pv-base", baseUrl);
  setValue("#pv-keyenv", provider ? provider.keyEnv || providerKeyEnv(id) : providerKeyEnv(id));
  // 换了一家 / 换模板才重建模型草稿；同一家刷新只重绘，不丢正在编辑的列表
  const nextFormFor = isEdit ? `form:${id}` : `new:${isTemplate ? template.id : "custom"}`;
  if (host.dataset.formFor !== nextFormFor) hydrateProviderModels(provider, template, plan);
  host.dataset.formFor = nextFormFor;
  renderProviderModelList(host);

  // 明文永不跨供应商保留：每次填表都把 Key 输入框清空，只留占位提示
  const api = q("#pv-apikey");
  if (api) {
    api.value = "";
    api.type = "password";
    api.placeholder = isEdit && provider.hasKey ? "已设置（留空保持不变）" : "sk-…";
  }
  const eye = q("#pv-eye");
  if (eye) {
    eye.setAttribute("aria-pressed", "false");
    eye.setAttribute("aria-label", "显示密钥");
    eye.title = "显示密钥";
    const showIcon = eye.querySelector(".eye-show");
    const hideIcon = eye.querySelector(".eye-hide");
    if (showIcon) showIcon.hidden = false;
    if (hideIcon) hideIcon.hidden = true;
  }

  // 表单换人时重建模型草稿；同一个人只做原位填值，不动正在编辑的列表
  host.dataset.formFor = isEdit ? `form:${id}` : `new:${isTemplate ? template.id : "custom"}`;

  const del = q("#pv-delete");
  if (del) {
    // 和保存 / 取消同一行（2026-11-13）：删除是这家供应商自己的动作，不再单独占一条危险区
    // 默认 / 在用也照样能删（2026-11-23）：删掉后默认顺延到下一家，没有就落 mock
    del.hidden = !isEdit;
    del.disabled = false;
    del.title = "";
  }

  applyProviderSecretMode(host);
  setProviderHint(host, "", false);
}

/** 从服务端投影 / 模板重建模型草稿（上下文与档位缺省 = 服务端缺省） */
function hydrateProviderModels(provider, template, plan) {
  const ids = provider
    ? [...(provider.models || [])]
    : plan
      ? parseModelText(plan.models)
      : template && template.models
        ? parseModelText(template.models)
        : [];
  state.providerModels = ids.map((id) => {
    const meta = (provider && provider.modelMeta && provider.modelMeta[id]) || {};
    const levels =
      provider && provider.modelThinkingLevels ? provider.modelThinkingLevels[id] : null;
    return {
      id,
      contextWindow: Number.isFinite(meta.contextWindow) ? meta.contextWindow : null,
      maxTokens: Number.isFinite(meta.maxTokens) ? meta.maxTokens : null,
      thinkingLevels: Array.isArray(levels) && levels.length ? [...levels] : null,
    };
  });
}

/** 没声明过档位 = 服务端缺省域（off/low/high，刻意不含 medium） */
function effectiveThinkingLevels(model) {
  return model && Array.isArray(model.thinkingLevels) && model.thinkingLevels.length
    ? model.thinkingLevels
    : ["off", "low", "high"];
}

function renderProviderModelList(host) {
  const box = host && host.querySelector("#pv-model-list");
  if (!box) return;
  const list = state.providerModels || [];
  box.replaceChildren();
  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "svc-model-empty";
    // 新建且清单空：保存时服务端会代拉 /models，先把这个预期说清楚
    const creating = (state.providerView || {}).mode === "new";
    empty.textContent = creating
      ? "还没有模型。填了 Key 保存时会自动从上游拉；也可以现在点「添加模型」手填。"
      : "还没有模型。点右上「添加模型」，填 ID 后可自动检测。";
    box.append(empty);
    return;
  }
  const icon = (path) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  list.forEach((model, index) => {
    const row = document.createElement("div");
    row.className = "svc-model-row";

    const main = document.createElement("div");
    main.className = "svc-model-main";
    const idLine = document.createElement("div");
    idLine.className = "svc-model-id";
    idLine.textContent = model.id;
    const metaLine = document.createElement("div");
    metaLine.className = "svc-model-meta";
    // 行尾只留两个数字（2026-11-12 M1）：原来一行"上下文 131K · 输出 4K · 思考 关/低/中/高"
    // 每行重复三遍，十几行就把右栏写成一段说明文。思考档仍可从编辑弹窗看/改，
    // 完整口径放 title，悬停即得。
    const contextText = formatTokenCount(model.contextWindow ?? DEFAULT_CONTEXT_WINDOW);
    const outputText = formatTokenCount(model.maxTokens ?? DEFAULT_MAX_TOKENS);
    metaLine.textContent = `${contextText} · ${outputText}`;
    metaLine.title = [
      `上下文 ${contextText}`,
      `输出 ${outputText}`,
      `思考 ${effectiveThinkingLevels(model)
        .map((level) => THINKING_LABELS[level] || level)
        .join("/")}`,
    ].join(" · ");
    main.append(idLine, metaLine);

    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "svc-model-act";
    edit.title = `编辑 ${model.id}`;
    edit.setAttribute("aria-label", `编辑 ${model.id}`);
    edit.innerHTML = icon('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>');
    edit.addEventListener("click", () => openProviderModelDialog(host, index));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "svc-model-act is-danger";
    remove.title = `移除 ${model.id}`;
    remove.setAttribute("aria-label", `移除 ${model.id}`);
    remove.innerHTML = icon('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>');
    remove.addEventListener("click", () => {
      state.providerModels.splice(index, 1);
      renderProviderModelList(host);
      setProviderHint(host, "模型列表已修改，点「保存」写回", false);
    });

    row.append(main, edit, remove);
    box.append(row);
  });
}

/** 空 / 非正整数 → null；有值但不是正整数 → NaN（保存时拦下） */
function parseTokenField(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const number = Number(text);
  return Number.isInteger(number) && number > 0 ? number : Number.NaN;
}

/**
 * 添加 / 编辑模型的弹窗（2026-11-05）：
 * 只填 ID → 点「检测」真打一次上游，回填上下文 / 最大输出 / 思考档 → 用户确认后进草稿。
 * 未保存的新供应商不能检测（端点按 provider id 找 key），提示先保存。
 */
function openProviderModelDialog(host, index) {
  const editing = Number.isInteger(index) && index >= 0;
  const model = editing
    ? { ...state.providerModels[index] }
    : { id: "", contextWindow: null, maxTokens: null, thinkingLevels: null };
  const { provider } = currentProviderFormTarget();
  const levelsFor = effectiveThinkingLevels(model);

  openModal(editing ? "编辑模型" : "添加模型", (body) => {
    body.innerHTML = `
      <div class="modal-field">
        <span>模型 ID</span>
        <div class="modal-row">
          <input class="modal-input is-mono" id="pm-id" type="text" spellcheck="false"
                 placeholder="例如 deepseek-v4.1-flash" value="${attr(model.id)}" />
          <button class="ghost" type="button" id="pm-detect"${provider ? "" : " disabled"}>检测</button>
        </div>
        <p class="modal-hint" id="pm-detect-hint">${
          provider
            ? "填模型 ID 后点「检测」：会真打一次上游，顺便拉上下文与思考档"
            : "先保存供应商基础信息，再回来检测；现在可以先手填"
        }</p>
      </div>
      <div class="modal-field">
        <span>上下文窗口（tokens）</span>
        <input class="modal-input" id="pm-ctx" type="text" inputmode="numeric" spellcheck="false"
               placeholder="${DEFAULT_CONTEXT_WINDOW}" value="${model.contextWindow ?? ""}" />
      </div>
      <div class="modal-field">
        <span>最大输出（tokens）</span>
        <input class="modal-input" id="pm-max" type="text" inputmode="numeric" spellcheck="false"
               placeholder="${DEFAULT_MAX_TOKENS}" value="${model.maxTokens ?? ""}" />
      </div>
      <div class="modal-field">
        <span>思考强度</span>
        <div class="pm-levels">
          ${THINKING_LEVELS.map(
            (level) => `<label class="pm-level-opt">
              <input class="pm-level" type="checkbox" value="${level}"${levelsFor.includes(level) ? " checked" : ""} />
              <span>${THINKING_LABELS[level]}</span>
            </label>`,
          ).join("")}
        </div>
      </div>
      <p class="modal-hint" id="pm-hint"></p>
      <div class="modal-actions">
        <button class="ghost" type="button" data-modal-cancel>取消</button>
        <button class="modal-primary" type="button" id="pm-save">保存</button>
      </div>`;

    const hint = body.querySelector("#pm-hint");
    const detectHint = body.querySelector("#pm-detect-hint");
    const idInput = body.querySelector("#pm-id");
    const ctxInput = body.querySelector("#pm-ctx");
    const maxInput = body.querySelector("#pm-max");
    const levelBoxes = [...body.querySelectorAll(".pm-level")];
    const detect = body.querySelector("#pm-detect");
    const save = body.querySelector("#pm-save");

    body.querySelector("[data-modal-cancel]")?.addEventListener("click", closeModal);

    detect?.addEventListener("click", async () => {
      const modelId = idInput.value.trim();
      if (!modelId) {
        setModalHint(hint, "先填模型 ID");
        idInput.focus();
        return;
      }
      if (!provider) return;
      detect.disabled = true;
      save.disabled = true;
      setModalHint(hint, "检测中：会真打一次上游…", false);
      try {
        const response = await request(
          `/api/v1/agent/providers/${encodeURIComponent(provider.id)}/models/detect`,
          { method: "POST", body: JSON.stringify({ modelId }) },
        );
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          setModalHint(hint, providerErrorText(data, response.status));
          return;
        }
        const detection = data.detection || {};
        if (Number.isFinite(detection.contextWindow)) ctxInput.value = String(detection.contextWindow);
        if (Number.isFinite(detection.maxTokens)) maxInput.value = String(detection.maxTokens);
        if (Array.isArray(detection.thinkingLevels)) {
          for (const box of levelBoxes) box.checked = detection.thinkingLevels.includes(box.value);
        }
        if (!detection.reachable) {
          setModalHint(hint, detection.message || "没连上");
          return;
        }
        const latency = Number.isFinite(detection.latencyMs) ? `（${detection.latencyMs}ms）` : "";
        const contextText = Number.isFinite(detection.contextWindow)
          ? `上下文 ${formatTokenCount(detection.contextWindow)}`
          : "上游没给上下文，请手填";
        const unknown = Object.entries(detection.levels || {})
          .filter(([, verdict]) => verdict === "unknown")
          .map(([level]) => THINKING_LABELS[level] || level);
        setModalHint(
          hint,
          `已连通${latency}；${contextText}${unknown.length ? `；${unknown.join("/")} 档未确认` : ""}`,
          false,
        );
        if (detectHint) {
          detectHint.textContent = detection.message || "检测完成，确认下面的值后保存";
        }
      } catch (error) {
        if (error.message === "forbidden") {
          closeModal();
          return;
        }
        setModalHint(hint, `检测失败：${error.message}`);
      } finally {
        detect.disabled = false;
        save.disabled = false;
      }
    });

    save?.addEventListener("click", () => {
      const modelId = idInput.value.trim();
      if (!modelId) {
        setModalHint(hint, "模型 ID 不能为空");
        idInput.focus();
        return;
      }
      if ((state.providerModels || []).some((item, itemIndex) => item.id === modelId && itemIndex !== index)) {
        setModalHint(hint, "这个模型已经在列表里");
        return;
      }
      const contextWindow = parseTokenField(ctxInput.value);
      const maxTokens = parseTokenField(maxInput.value);
      if (Number.isNaN(contextWindow) || Number.isNaN(maxTokens)) {
        setModalHint(hint, "上下文 / 最大输出只能是正整数（留空 = 用默认值）");
        return;
      }
      const thinkingLevels = levelBoxes.filter((box) => box.checked).map((box) => box.value);
      if (!thinkingLevels.length) {
        setModalHint(hint, "至少选一个思考档（不想思考就只留「关」）");
        return;
      }
      const next = { id: modelId, contextWindow, maxTokens, thinkingLevels };
      if (editing) state.providerModels[index] = next;
      else state.providerModels.push(next);
      renderProviderModelList(host);
      setProviderHint(host, "模型列表已修改，点「保存」写回", false);
      closeModal();
    });
  });
}

function setProviderHint(host, text, isError = true) {
  const node = host && host.querySelector("#pv-hint");
  if (!node) return;
  node.textContent = text;
  node.classList.toggle("is-error", Boolean(isError) && Boolean(text));
}

/** api=直填（PUT /secret）；env=后端没这个接口时的退回形态（只填变量名） */
function applyProviderSecretMode(host) {
  const envMode = state.providerSecretMode === "env";
  const apiField = host.querySelector("#pv-key-api");
  const envField = host.querySelector("#pv-key-env");
  if (apiField) apiField.hidden = envMode;
  if (envField) envField.hidden = !envMode;
}

export { PROVIDER_RESERVED_IDS, applyProviderSecretMode, effectiveThinkingLevels, fillProviderForm, hydrateProviderModels, nextProviderId, nextProviderName, openProviderModelDialog, parseTokenField, providerFormMarkup, providerKeyEnv, providerSlug, renderProviderModelList, setProviderHint };
