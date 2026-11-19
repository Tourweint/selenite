/**
 * 设置 → 模型 → 搜索源
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { attr, esc } from "./markdown.js";
import { request } from "./net.js";
import { setModalHint } from "./project-modal.js";
import { state } from "./state.js";
import { closeModal, openConfirm, openModal, toast } from "./ui-atoms.js";


/* ── 设置 → 模型 → 搜索（2026-11-12 多供应商）────────────
   一个源 = vendor + key + 可选地址；列表顺序 = 尝试顺序，第一个有结果的生效。
   key 落 .data/provider-keys.json（响应只回变量名）；源清单落 .data/search.json。
   旧「设置 → 服务」那张单 Key 卡已整体搬到这里，不再重复。 */
const SEARCH_ERROR_TEXT = {
  search_not_configured: "还没有可用的搜索源：先添加一个，或把 Key 写进 .env。",
  upstream_error: "搜索服务报错（上游 / 网络 / 额度），稍后再试。",
  bad_response: "搜索服务返回格式异常，稍后再试。",
};

function setSearchSourceHint(text, isError = false) {
  const node = document.getElementById("search-source-hint");
  if (!node) return;
  node.hidden = !text;
  node.textContent = text || "";
  node.classList.toggle("is-error", Boolean(isError) && Boolean(text));
}

function searchVendorById(id) {
  return (state.searchVendors || []).find((vendor) => vendor.id === id) || null;
}

function applySearchSourceState(data) {
  state.searchSources = Array.isArray(data?.sources) ? data.sources : [];
  state.searchVendors = Array.isArray(data?.vendors) ? data.vendors : [];
}

/** 旧服务端的 GET 只有 {keyEnv,hasKey}：给一句能照做的提示，不让页面像坏了。 */
let searchSourcesError = "";

async function fetchSearchSourceState() {
  const response = await request("/api/v1/agent/search-provider", { cache: "no-store" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `HTTP ${response.status}`);
  if (!Array.isArray(data.sources) || !Array.isArray(data.vendors)) {
    throw new Error("服务端还是旧版本：去 设置 → 本机 点「重启」，再刷新这一页。");
  }
  return data;
}

async function loadSearchSources() {
  const list = document.getElementById("search-source-list");
  if (!list) return;
  try {
    applySearchSourceState(await fetchSearchSourceState());
    searchSourcesError = "";
    renderSearchSources();
  } catch (error) {
    searchSourcesError = error.message;
    list.innerHTML = `<div class="src-empty set-hint is-error">读不到搜索源：${esc(error.message)}</div>`;
  }
}

function renderSearchSources() {
  const list = document.getElementById("search-source-list");
  if (!list) return;
  list.replaceChildren();
  const sources = state.searchSources || [];
  if (!sources.length) {
    const empty = document.createElement("div");
    empty.className = "src-empty set-hint";
    empty.textContent = "还没有搜索源。加一个，模型就能查公开资料。";
    list.append(empty);
    return;
  }
  sources.forEach((source, index) => {
    list.append(buildSearchSourceRow(source, index, sources.length));
  });
}

function buildSearchSourceRow(source, index, total) {
  const vendor = searchVendorById(source.vendor);
  const row = document.createElement("div");
  row.className = "src-row";
  row.dataset.vendor = source.vendor;
  const missingAddress = source.needsUrl && !source.baseUrl;
  const missing = !source.usable;
  const status = missing ? (missingAddress ? "缺地址" : "缺 Key") : source.keyOptional ? "免 Key" : "已配置";
  const keyPlaceholder = source.hasKey
    ? "已配置，留空不改"
    : source.keyOptional
      ? "Key（可选）"
      : "填 API Key";
  row.innerHTML = `
    <span class="src-order" aria-hidden="true">${index + 1}</span>
    <div class="src-main">
      <div class="src-name">${esc(source.name || vendor?.name || source.vendor)}${
        source.keyUrl
          ? ` <a class="src-get" href="${attr(source.keyUrl)}" target="_blank" rel="noreferrer">${source.vendor === "searxng" ? "文档" : "Key"} ↗</a>`
          : ""
      }</div>
      <div class="src-sub${missing ? " is-error" : ""}">${esc(status)} · <span class="src-env">${esc(source.keyEnv)}</span></div>
    </div>
    <div class="src-inputs">
      ${
        source.needsUrl
          ? `<input class="set-input src-url" type="url" spellcheck="false"
                 placeholder="https://searx.example.com" value="${attr(source.baseUrl || "")}" aria-label="搜索源地址" />`
          : ""
      }
      <input class="set-input src-key" type="password" autocomplete="new-password" spellcheck="false"
             placeholder="${attr(keyPlaceholder)}" aria-label="${attr((source.name || "搜索源") + " API Key")}" />
    </div>
    <div class="src-actions">
      <button class="ghost src-act" type="button" data-src-save>保存</button>
      <button class="ghost src-act" type="button" data-src-test>测试</button>
      <button class="ghost is-danger src-act" type="button" data-src-remove>移除</button>
      <span class="src-move">
        <button class="src-move-btn" type="button" data-src-up title="上移" aria-label="上移" ${index === 0 ? "disabled" : ""}>↑</button>
        <button class="src-move-btn" type="button" data-src-down title="下移" aria-label="下移" ${index === total - 1 ? "disabled" : ""}>↓</button>
      </span>
    </div>`;

  const keyInput = row.querySelector(".src-key");
  const urlInput = row.querySelector(".src-url");

  row.querySelector("[data-src-save]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const apiKey = (keyInput?.value || "").trim();
    const baseUrl = urlInput ? (urlInput.value || "").trim() : undefined;
    if (source.needsUrl && !baseUrl) {
      setSearchSourceHint("先填 SearXNG 地址。", true);
      urlInput?.focus();
      return;
    }
    if (!source.keyOptional && !apiKey && !source.hasKey) {
      setSearchSourceHint("先填 API Key。", true);
      keyInput?.focus();
      return;
    }
    button.disabled = true;
    setSearchSourceHint("保存中…");
    try {
      const payload = { vendor: source.vendor };
      if (apiKey) payload.apiKey = apiKey;
      if (urlInput) payload.baseUrl = baseUrl;
      const response = await request("/api/v1/agent/search-provider", {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setSearchSourceHint(data.message || `没保存：HTTP ${response.status}`, true);
        return;
      }
      applySearchSourceState(data);
      renderSearchSources();
      setSearchSourceHint("已保存。");
    } catch {
      setSearchSourceHint("请求没发出去，检查服务是否在跑。", true);
    } finally {
      button.disabled = false;
    }
  });

  row.querySelector("[data-src-test]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    setSearchSourceHint("测试中…");
    try {
      const response = await request("/api/v1/agent/search-provider/test", {
        method: "POST",
        body: JSON.stringify({ vendor: source.vendor }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.ok === true) {
        setSearchSourceHint(data.message || `搜索通了，返回 ${data.hits ?? 0} 条`);
        return;
      }
      setSearchSourceHint(data.message || SEARCH_ERROR_TEXT[data.error] || "测试没通过，稍后再试。", true);
    } catch {
      setSearchSourceHint("请求没发出去，检查服务是否在跑。", true);
    } finally {
      button.disabled = false;
    }
  });

  row.querySelector("[data-src-remove]")?.addEventListener("click", async (event) => {
    const ok = await openConfirm({
      title: "移除搜索源",
      message: `移除「${source.name || source.vendor}」？`,
      detail: "移除后这个源不再出现在搜索回退链里；需要时可以在「添加搜索源」里重新加回来。",
      confirmText: "移除",
      danger: true,
    });
    if (!ok) return;
    const button = event.currentTarget;
    button.disabled = true;
    setSearchSourceHint("移除中…");
    try {
      const response = await request(
        `/api/v1/agent/search-provider?vendor=${encodeURIComponent(source.vendor)}`,
        { method: "DELETE" },
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setSearchSourceHint(data.message || `没移除：HTTP ${response.status}`, true);
        return;
      }
      applySearchSourceState(data);
      renderSearchSources();
      setSearchSourceHint("已移除。");
    } catch {
      setSearchSourceHint("请求没发出去，检查服务是否在跑。", true);
    } finally {
      button.disabled = false;
    }
  });

  const move = async (delta) => {
    const ids = (state.searchSources || []).map((item) => item.vendor);
    const from = ids.indexOf(source.vendor);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to], ids[from]];
    setSearchSourceHint("调整顺序中…");
    try {
      const response = await request("/api/v1/agent/search-provider/order", {
        method: "PUT",
        body: JSON.stringify({ vendors: ids }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setSearchSourceHint(data.message || `没调整：HTTP ${response.status}`, true);
        return;
      }
      applySearchSourceState(data);
      renderSearchSources();
      setSearchSourceHint("");
    } catch {
      setSearchSourceHint("请求没发出去，检查服务是否在跑。", true);
    }
  };
  row.querySelector("[data-src-up]")?.addEventListener("click", () => void move(-1));
  row.querySelector("[data-src-down]")?.addEventListener("click", () => void move(1));
  return row;
}

/** 添加搜索源：一个弹窗选 vendor + 填 Key / 地址，保存即落盘。 */
function openAddSearchSourceModal() {
  const taken = new Set((state.searchSources || []).map((source) => source.vendor));
  const available = (state.searchVendors || []).filter((vendor) => !taken.has(vendor.id));
  if (!available.length) {
    toast(searchSourcesError || (state.searchVendors?.length ? "所有搜索源都加过了" : "搜索源目录还没读到，刷新页面再试"));
    return;
  }
  openModal("添加搜索源", (body) => {
    body.innerHTML = `
      <p class="modal-desc">按列表顺序尝试，第一个有结果的生效。</p>
      <div class="modal-field">
        <span>搜索源</span>
        <select class="modal-input" id="src-new-vendor">
          ${available
            .map(
              (vendor) =>
                `<option value="${attr(vendor.id)}">${esc(vendor.name)}${vendor.note ? ` · ${esc(vendor.note)}` : ""}</option>`,
            )
            .join("")}
        </select>
      </div>
      <label class="modal-field">
        <span>API Key</span>
        <input class="modal-input" id="src-new-key" type="password" autocomplete="new-password" spellcheck="false" />
        <span class="field-hint" id="src-new-key-hint"></span>
      </label>
      <label class="modal-field" id="src-new-url-field" hidden>
        <span>地址</span>
        <input class="modal-input" id="src-new-url" type="url" spellcheck="false" placeholder="https://searx.example.com" />
      </label>
      <p class="modal-hint" id="src-new-hint"></p>
      <div class="modal-actions">
        <button class="ghost" type="button" data-modal-cancel>取消</button>
        <button class="modal-primary" id="src-new-save" type="button">添加</button>
      </div>`;

    const select = body.querySelector("#src-new-vendor");
    const keyInput = body.querySelector("#src-new-key");
    const keyHint = body.querySelector("#src-new-key-hint");
    const urlField = body.querySelector("#src-new-url-field");
    const urlInput = body.querySelector("#src-new-url");
    const hint = body.querySelector("#src-new-hint");
    const save = body.querySelector("#src-new-save");
    body.querySelector("[data-modal-cancel]")?.addEventListener("click", closeModal);

    const current = () => available.find((vendor) => vendor.id === select.value) || available[0];
    const syncVendor = () => {
      const vendor = current();
      if (!vendor) return;
      urlField.hidden = !vendor.needsUrl;
      keyInput.placeholder = vendor.keyOptional ? "可留空" : "填 API Key";
      keyHint.innerHTML = vendor.keyUrl
        ? `变量名 <span class="is-mono">${esc(vendor.keyEnv)}</span> · <a href="${attr(vendor.keyUrl)}" target="_blank" rel="noreferrer">${vendor.id === "searxng" ? "部署文档" : "获取 Key"} ↗</a>`
        : `变量名 <span class="is-mono">${esc(vendor.keyEnv)}</span>`;
      urlInput.value = "";
    };
    select.addEventListener("change", syncVendor);
    syncVendor();

    save.addEventListener("click", async () => {
      const vendor = current();
      if (!vendor) return;
      const baseUrl = urlInput.value.trim();
      if (vendor.needsUrl && !baseUrl) {
        setModalHint(hint, "先填实例地址。");
        urlInput.focus();
        return;
      }
      save.disabled = true;
      setModalHint(hint, "保存中…", false);
      try {
        const payload = { vendor: vendor.id };
        const apiKey = keyInput.value.trim();
        if (apiKey) payload.apiKey = apiKey;
        if (vendor.needsUrl) payload.baseUrl = baseUrl;
        const response = await request("/api/v1/agent/search-provider", {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          setModalHint(hint, data.message || `没添加：HTTP ${response.status}`);
          return;
        }
        applySearchSourceState(data);
        closeModal();
        renderSearchSources();
        setSearchSourceHint("搜索源已添加。");
      } catch {
        setModalHint(hint, "请求没发出去，检查服务是否在跑。");
      } finally {
        save.disabled = false;
      }
    });
  });
}

export { SEARCH_ERROR_TEXT, applySearchSourceState, buildSearchSourceRow, fetchSearchSourceState, loadSearchSources, openAddSearchSourceModal, renderSearchSources, searchSourcesError, searchVendorById, setSearchSourceHint };
