/**
 * 供应商表单接线 / 保存 / 删除 / 密钥
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { el } from "./dom.js";
import { fetchModelCatalog, refreshModelPill } from "./hover-tip.js";
import { esc } from "./markdown.js";
import { request } from "./net.js";
import { setModalHint } from "./project-modal.js";
import { applyProviderSecretMode, fillProviderForm, hydrateProviderModels, nextProviderId, openProviderModelDialog, providerKeyEnv, renderProviderModelList, setProviderHint } from "./provider-form.js";
import { currentProviderFormTarget, loadProviders, providerById, providerErrorText, providerSecretErrorText, renderProviderDetail, renderProviderNav, showProviderTemplates, templateLabel, templatePlan } from "./providers.js";
import { go } from "./route.js";
import { syncSegmented } from "./settings-atoms.js";
import { renderDefaultModelRow } from "./settings-reminders.js";
import { sidebarOpen, toggleSidebar } from "./shell.js";
import { state } from "./state.js";
import { closeModal, openModal, toast } from "./ui-atoms.js";

function wireProviderForm(host) {
  const hint = (text, isError = true) => setProviderHint(host, text, isError);
  const clear = () => hint("", false);

  for (const node of host.querySelectorAll("input, textarea")) {
    node.addEventListener("input", clear);
  }

  // 套餐切换（2026-11-13）：换地址 + 换套餐自带的模型清单 + 换申请 Key 的入口
  host.querySelector("#pv-plan")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-plan]");
    if (!button || button.getAttribute("aria-checked") === "true") return;
    const { template } = currentProviderFormTarget();
    if (!template) return;
    state.providerPlanId = button.dataset.plan;
    const plan = templatePlan(template, state.providerPlanId);
    for (const item of host.querySelectorAll("#pv-plan button")) {
      item.setAttribute("aria-checked", String(item === button));
    }
    syncSegmented(host.querySelector("#pv-plan"));
    const base = host.querySelector("#pv-base");
    if (base) base.value = plan.baseUrl;
    hydrateProviderModels(null, template, plan);
    renderProviderModelList(host);
    const link = host.querySelector("#pv-keylink");
    const keyUrl = plan.keyUrl || template.keyUrl || "";
    if (link) {
      link.hidden = !keyUrl;
      if (keyUrl) link.href = keyUrl;
    }
    const note = host.querySelector("#pv-new-hint");
    if (note) {
      note.textContent = (plan.models || []).length
        ? `基于「${templateLabel(template, plan)}」，保存前都能改`
        : `基于「${template.name}」模板：粘上 Key 保存，模型清单自动从上游拉`;
    }
    hint("", false);
  });

  // 眼睛：按住时不让输入框失焦，点一下在 password / text 之间切
  host.querySelector("#pv-eye")?.addEventListener("mousedown", (event) => event.preventDefault());
  host.querySelector("#pv-eye")?.addEventListener("click", (event) => {
    const button = event.currentTarget;
    const input = host.querySelector("#pv-apikey");
    if (!input) return;
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    button.setAttribute("aria-pressed", String(show));
    button.setAttribute("aria-label", show ? "隐藏密钥" : "显示密钥");
    button.title = show ? "隐藏" : "显示";
    const showIcon = button.querySelector(".eye-show");
    const hideIcon = button.querySelector(".eye-hide");
    if (showIcon) showIcon.hidden = show;
    if (hideIcon) hideIcon.hidden = !show;
  });

  host.querySelector("#pv-back")?.addEventListener("click", () => showProviderTemplates());
  host.querySelector("#pv-cancel")?.addEventListener("click", () => {
    const { provider } = currentProviderFormTarget();
    if (provider) {
      // 编辑态取消 = 丢掉未保存输入，回到磁盘上的那份（原位填回，不重建）
      hydrateProviderModels(provider, null, null);
      fillProviderForm(host, provider, null);
      renderProviderModelList(host);
      return;
    }
    showProviderTemplates();
  });

  host.querySelector("#pv-add-model")?.addEventListener("click", () => openProviderModelDialog(host, -1));
  host.querySelector("#pv-save")?.addEventListener("click", () => void saveProviderFlow());

  host.querySelector("#pv-delete")?.addEventListener("click", () => {
    const { provider } = currentProviderFormTarget();
    if (!provider) return;
    confirmDeleteProvider(provider);
  });
}

/**
 * 保存编排（2026-11-05，2026-11-13 补 ③）：
 *   ① POST /agent/providers            基本信息 + 逐模型元数据（含前端生成的 id/keyEnv）
 *   ② PUT  /agent/providers/:id/secret 密钥（Key 框留空 = 不改）
 *   ③ POST /agent/providers            `modelsUrl`：清单空时让服务端代拉 `/models` 回填
 * 手工加过模型的走 ①②；只有模板（清单空、粘了 Key）才走 ③，拉不到就落回手填。
 * ②失败但服务端没有该接口（404 / secrets_disabled）时，退回“只填变量名”的老形态。
 */
async function saveProviderFlow() {
  const host = document.getElementById("provider-detail");
  if (!host) return;
  const saveButton = host.querySelector("#pv-save");
  if (saveButton?.disabled) return;

  const { provider } = currentProviderFormTarget();
  const apiKey = (host.querySelector("#pv-apikey")?.value || "").trim();
  const values = providerFormValues(provider ? provider.id : "");
  const problem = providerFormError(values);
  if (problem) {
    setProviderHint(host, problem);
    return;
  }

  if (saveButton) saveButton.disabled = true;
  setProviderHint(host, "保存中…", false);
  try {
    // ① 基本信息（允许空清单：先建档，再逐个添加模型）
    const created = await postProvider(values);
    if (!created.response.ok) {
      setProviderHint(host, providerErrorText(created.data || {}, created.response.status));
      return;
    }
    const saved = created.data.provider || {};
    const providerId = saved.id || values.id || (provider && provider.id) || "";
    if (!providerId) {
      setProviderHint(host, "服务端没回供应商 id，刷新后再试。");
      return;
    }
    // 视图立刻切到这家：后面任一步失败，回来也是编辑态而不是“新建”
    state.providerView = { mode: "form", providerId, templateId: "" };
    // 列表先用本地回写，别等下一次 GET（②失败时左栏也不会缺这一行）
    state.providers = [
      ...(state.providers || []).filter((item) => item.id !== providerId),
      { ...saved, id: providerId },
    ];
    renderProviderNav();
    fillProviderForm(host, { ...saved, id: providerId }, null);
    if (apiKey) {
      const input = host.querySelector("#pv-apikey");
      if (input) input.value = apiKey;
    }

    // ② 密钥（留空 = 保留原 Key）
    let keyEnv = saved.keyEnv || values.keyEnv || providerKeyEnv(providerId);
    if (apiKey && state.providerSecretMode !== "env") {
      setProviderHint(host, "已保存，正在存密钥…", false);
      const secret = await putProviderSecret(providerId, apiKey);
      if (secret.response.ok) {
        state.providerSecretMode = "api";
        keyEnv = secret.data.keyEnv || keyEnv;
        applyProviderSecretMode(host);
        const envNode = host.querySelector("#pv-keyenv");
        if (envNode) envNode.value = keyEnv;
        const listed = (state.providers || []).find((item) => item.id === providerId);
        if (listed) listed.hasKey = true;
        renderProviderNav();
      } else if (secret.response.status === 404 || secret.data?.error === "secrets_disabled") {
        // 后端还没上线这个接口：降级成“密钥环境变量名”手输，不抛未捕获异常
        state.providerSecretMode = "env";
        applyProviderSecretMode(host);
        const envNode = host.querySelector("#pv-keyenv");
        if (envNode && !envNode.value.trim()) envNode.value = keyEnv;
        await reloadAfterProviderChange();
        setProviderHint(
          host,
          secret.data?.error === "unknown_provider"
            ? "先保存基本信息，再存密钥。"
            : `这版服务端还没有密钥直填接口：把 Key 写进 .env（变量名 ${keyEnv}），再保存。`,
          false,
        );
        return;
      } else {
        setProviderHint(host, providerSecretErrorText(secret.data, secret.response.status));
        return;
      }
    }

    // ③ 模型清单：清单空 + 这次填了 Key → 让服务端按 /models 拉一次（2026-11-13）。
    //    `modelsUrl` 是「仅本次请求用、不持久」的既有字段（接口文档 §2.10）；
    //    拉不到不挡保存，落回手填。这样选模板的人只要粘一个 Key，不用抄模型 id。
    let pullNote = "";
    let pulledProvider = null;
    if (!values.models.length && apiKey && state.providerSecretMode !== "env") {
      setProviderHint(host, "已保存，正在拉模型清单…", false);
      const pulled = await postProvider({
        id: providerId,
        previousId: providerId,
        name: values.name,
        baseUrl: values.baseUrl,
        keyEnv,
        models: [],
        modelMeta: {},
        modelThinkingLevels: {},
        modelsUrl: "1",
      });
      if (pulled.response.ok) {
        pulledProvider = pulled.data.provider || null;
        const count = (pulled.data.provider?.models || []).length;
        pullNote = count
          ? `已保存，拉到 ${count} 个模型；去「默认模型」挑一个就能用`
          : "已保存。上游没给模型清单，点「添加模型」手填一个";
      } else {
        const reason = providerErrorText(pulled.data || {}, pulled.response.status);
        pullNote = `已保存；模型清单没拉到（${reason}）。点「添加模型」手填一个。`;
      }
    }

    toast(provider ? `已保存 ${values.name}` : `已添加 ${values.name}`);
    await reloadAfterProviderChange();
    // 拉回来的清单要进草稿：刷新只重绘不重建，不同步的话表单还显示「还没有模型」
    if (pulledProvider) {
      hydrateProviderModels(pulledProvider, null, null);
      renderProviderModelList(host);
    }
    setProviderHint(
      host,
      pullNote || (values.models.length ? "已保存" : "已保存。现在可以点「添加模型」并检测"),
      false,
    );
  } finally {
    if (saveButton) saveButton.disabled = false;
  }
}

/** 表单校验（服务端仍会再拦一遍；这里只把明显问题挡在请求前） */
function providerFormError(values) {
  if (!values.name) return "给供应商起个名字。";
  if (!/^https?:\/\/\S+$/i.test(values.baseUrl)) {
    return "Base URL 要写完整地址（http:// 或 https://）。";
  }
  if (!/^[A-Z_][A-Z0-9_]*$/.test(values.keyEnv)) {
    return "变量名只能是大写字母、数字、下划线，且不以数字开头（如 DASHSCOPE_API_KEY）。";
  }
  return "";
}

function parseModelText(text) {
  if (Array.isArray(text)) return text.map((item) => String(item).trim()).filter(Boolean);
  return String(text || "")
    .split(/[\n,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 草稿列表 → 接口字段；没配的元数据不下发（服务端按默认值解释） */
function providerModelPayload(models) {
  const ids = [];
  const modelMeta = {};
  const modelThinkingLevels = {};
  for (const model of models || []) {
    if (!model.id) continue;
    ids.push(model.id);
    if (Number.isInteger(model.contextWindow) || Number.isInteger(model.maxTokens)) {
      const meta = {};
      if (Number.isInteger(model.contextWindow)) meta.contextWindow = model.contextWindow;
      if (Number.isInteger(model.maxTokens)) meta.maxTokens = model.maxTokens;
      modelMeta[model.id] = meta;
    }
    if (Array.isArray(model.thinkingLevels) && model.thinkingLevels.length) {
      modelThinkingLevels[model.id] = [...model.thinkingLevels];
    }
  }
  return { models: ids, modelMeta, modelThinkingLevels };
}

function providerFormValues(editingId) {
  const name = (document.getElementById("pv-name")?.value || "").trim();
  const baseUrl = (document.getElementById("pv-base")?.value || "").trim();
  const { models, modelMeta, modelThinkingLevels } = providerModelPayload(state.providerModels);
  const keyEnvInput = (document.getElementById("pv-keyenv")?.value || "").trim();
  // 空清单显式允许：先建档（拿 key），再逐个添加并检测模型
  const base = { name, baseUrl, models, modelMeta, modelThinkingLevels, allowEmptyModels: true };
  if (editingId) {
    const provider = providerById(editingId);
    // 编辑时 keyEnv 默认沿用磁盘上的那个；只有退回 env 形态才读手输框
    const keyEnv =
      state.providerSecretMode === "env"
        ? keyEnvInput || provider?.keyEnv || ""
        : provider?.keyEnv || providerKeyEnv(editingId);
    // id 不能改：编辑时把原 id 一并带上，服务端会拒绝 previousId ≠ id
    return { ...base, id: editingId, previousId: editingId, keyEnv };
  }
  // 新建：id/keyEnv 前端先定下来（服务端同一套 slug 规则），② 才有 id 可用
  const { template } = currentProviderFormTarget();
  const id = nextProviderId(
    name || "provider",
    template && template.id !== "custom" ? template.id : "",
  );
  const keyEnv =
    (state.providerSecretMode === "env" && keyEnvInput) || providerKeyEnv(id);
  return { ...base, id, keyEnv };
}

/** 删除确认（复用 .modal，确认钮走 destructive 色；不用 window.confirm） */
function confirmDeleteProvider(provider) {
  // 删掉后会发生什么先说清（2026-11-23 起默认也能删）：默认顺延到下一家，一家不剩就落 mock
  const withModels = (state.providers || []).filter(
    (item) => Array.isArray(item.models) && item.models.length > 0,
  );
  // "最后一家"按还有模型的算：空清单供应商本来就供不了模型
  const lastOne =
    withModels.length <= 1 && Array.isArray(provider.models) && provider.models.length > 0;
  const outcome = lastOne
    ? "这是最后一家能用的供应商：删掉后没有可用模型，对话会走 mock 回显。"
    : provider.isDefault
      ? "删掉后默认模型会落到下一家还有模型的供应商。"
      : "";
  openModal("删除供应商", (body) => {
    body.innerHTML = `
      <p class="modal-desc">删除「${esc(provider.name)}」之后不能撤销。</p>
      ${outcome ? `<p class="modal-hint">${esc(outcome)}</p>` : ""}
      <p class="modal-hint" id="pv-del-hint"></p>
      <div class="modal-actions">
        <button class="ghost" type="button" data-modal-cancel>取消</button>
        <button class="modal-danger" type="button" id="pv-del-confirm">删除</button>
      </div>`;

    const hint = body.querySelector("#pv-del-hint");
    const confirm = body.querySelector("#pv-del-confirm");
    body.querySelector("[data-modal-cancel]")?.addEventListener("click", closeModal);
    confirm?.addEventListener("click", async () => {
      if (confirm.disabled) return;
      confirm.disabled = true;
      try {
        const response = await request(`/api/v1/agent/providers/${encodeURIComponent(provider.id)}`, {
          method: "DELETE",
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          setModalHint(hint, providerErrorText(data, response.status));
          confirm.disabled = false;
          return;
        }
        closeModal();
        toast(`已删除 ${provider.name}`);
        state.providerView = { mode: "empty", providerId: "", templateId: "" };
        await reloadAfterProviderChange();
      } catch (error) {
        if (error.message === "forbidden") {
          closeModal(); // 令牌门在最上层，别让模态挡住它
          return;
        }
        setModalHint(hint, `没删成：${error.message}`);
        confirm.disabled = false;
      }
    });
  });
}

/** 左栏点行 / 空态入口：选中并展开右栏表单 */
function openProviderForm(providerId) {
  const provider = providerById(providerId);
  if (!provider) return;
  state.providerView = { mode: "form", providerId: provider.id, templateId: "" };
  renderProviderNav();
  renderProviderDetail();
}

async function postProvider(payload) {
  try {
    const response = await request("/api/v1/agent/providers", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } catch (error) {
    if (error.message === "forbidden") {
      return { response: { ok: false, status: 403 }, data: { message: "需要访问令牌" } };
    }
    return { response: { ok: false, status: 0 }, data: { message: error.message } };
  }
}

/** 直填密钥（2026-11-05 契约）：body 只有 apiKey，响应不回显密钥值 */
async function putProviderSecret(providerId, apiKey) {
  try {
    const response = await request(
      `/api/v1/agent/providers/${encodeURIComponent(providerId)}/secret`,
      { method: "PUT", body: JSON.stringify({ apiKey }) },
    );
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } catch (error) {
    if (error.message === "forbidden") {
      return { response: { ok: false, status: 403 }, data: { message: "需要访问令牌" } };
    }
    return { response: { ok: false, status: 0 }, data: { message: error.message } };
  }
}

/** 供应商改了之后：列表、默认模型行、composer 标签一起刷新 */
async function reloadAfterProviderChange() {
  await loadProviders();
  try {
    state.modelCatalog = await fetchModelCatalog();
    renderDefaultModelRow(state.modelCatalog);
    // 2026-11-19：默认模型行读全局；pill 读当前会话，别把会话模型盖成全局。
    void refreshModelPill();
  } catch {
    /* 读不到就保留旧显示 */
  }
}

el.openSettings.addEventListener("click", () => go("settings"));
el.closeSettings.addEventListener("click", () => go("chat"));
el.toggleSidebar.addEventListener("click", toggleSidebar);
el.toggleSidebar.setAttribute("aria-expanded", String(sidebarOpen()));

export { confirmDeleteProvider, openProviderForm, parseModelText, postProvider, providerFormError, providerFormValues, providerModelPayload, putProviderSecret, reloadAfterProviderChange, saveProviderFlow, wireProviderForm };
