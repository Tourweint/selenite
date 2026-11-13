/**
 * 连接页链路图 + 运行时起停
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { connPhoneCount } from "./approval-pop.js";
import { request } from "./net.js";
import { state } from "./state.js";
import { KEY_ACTS } from "./theme.js";
import { inShell, openConfirm, openModal, showAlert, toast } from "./ui-atoms.js";


/* ── 连接页链路图（2026-11-13）─────────────────────────────
   「这台电脑 / 中继（VPS）/ 手机」三格 + 一行断点提示。数据两条：
   /api/v1/relay/status（电脑→中继）与已配对设备数（手机）。 */
let connRelay = { loaded: false, enabled: false, connected: false };

async function loadRelayStatus() {
  const node = document.getElementById("conn-relay");
  const method = document.getElementById("relay-method-state");
  const howto = document.getElementById("conn-howto");
  const addButton = document.getElementById("relay-add-device");
  if (!node) return;
  let status = null;
  try {
    const response = await request("/api/v1/relay/status", { cache: "no-store" });
    if (response.ok) status = await response.json();
  } catch {
    status = null;
  }
  connRelay = {
    loaded: status !== null,
    enabled: status?.enabled === true,
    connected: status?.connected === true,
  };
  node.innerHTML = connRelay.loaded
    ? `<i class="status-dot ${connRelay.connected ? "ok" : connRelay.enabled ? "warn" : "idle"}"></i>${
        connRelay.connected ? "已连上" : connRelay.enabled ? "未连上" : "没开"
      }`
    : `<i class="status-dot warn"></i>读不到`;
  if (method) {
    method.textContent = connRelay.connected
      ? "可以出加入码"
      : connRelay.loaded
        ? "先让电脑连上中继"
        : "读不到中继状态";
  }
  if (howto) howto.hidden = connRelay.connected;
  if (addButton) addButton.disabled = !connRelay.connected;
  updateConnectionHint();
}

/** 一行断点提示：先报电脑→中继，再报手机数量。 */
function updateConnectionHint() {
  const hint = document.getElementById("conn-hint");
  if (!hint) return;
  if (!connRelay.loaded) {
    hint.textContent = "正在读取中继状态…";
    return;
  }
  if (!connRelay.enabled) {
    hint.textContent = "电脑没开中继";
    return;
  }
  if (!connRelay.connected) {
    hint.textContent = "电脑没连上中继";
    return;
  }
  hint.textContent = connPhoneCount ? `${connPhoneCount} 台手机已连` : "中继已连上，还没有手机加入";
}

async function loadPair() {
  const image = document.getElementById("pair-qr");
  const metaEl = document.getElementById("pair-meta");
  if (!image) return;
  try {
    const response = await request("/api/v1/pair/qr", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    image.src = data.dataUrl;
    image.hidden = false;
    // 原始 url 不再铺在页面上（2026-11-13：一长串没人念得出来），只留机器名与有效期
    if (metaEl) metaEl.textContent = `${data.machineName} · ${Math.round(data.expiresInSeconds / 60)} 分钟内有效`;
  } catch (error) {
    if (error.message === "forbidden") return;
    if (metaEl) metaEl.textContent = "拿不到配对码，稍后再试";
  }
}

/**
 * 「添加设备」（2026-11-11 批H H2）：经中继出一枚一次性加入码。
 *
 * 浏览器不直连中继——跨源没开 CORS，owner 令牌也绝不能下发客户端。
 * 这里调 harness 的 `/api/v1/relay/join-code`，由服务端代调中继并生成二维码。
 * 地址默认取 `RELAY_URL` 的对外形态，弹窗里可改（内网/域名对外形态不同）。
 * 手机加没加上不在弹窗里回显：扫完去「已连接的设备」看（同一页下面就是）。
 */
function openAddDeviceModal() {
  openModal("添加设备", (body) => {
    body.innerHTML = `
      <div class="modal-field">
        <span>中继地址</span>
        <input class="modal-input" id="relay-join-url" spellcheck="false" autocomplete="off"
               placeholder="http://<中继地址>:<端口>" aria-label="中继地址" />
      </div>
      <div class="relay-join">
        <img class="relay-join-qr" id="relay-join-qr" alt="加入二维码" hidden />
        <div class="relay-join-side">
          <div class="relay-join-label">加入码</div>
          <div class="relay-join-code" id="relay-join-code">正在取码…</div>
          <div class="relay-join-meta" id="relay-join-meta"></div>
        </div>
      </div>
      <div class="modal-hint" id="relay-join-hint">手机 App 扫上面的码即可加入；加入码只能用一次。</div>
      <div class="modal-actions">
        <button class="modal-primary" type="button" id="relay-join-refresh">换新码</button>
      </div>`;
    const urlInput = body.querySelector("#relay-join-url");
    const codeEl = body.querySelector("#relay-join-code");
    const qrEl = body.querySelector("#relay-join-qr");
    const metaEl = body.querySelector("#relay-join-meta");
    const hintEl = body.querySelector("#relay-join-hint");
    const refresh = body.querySelector("#relay-join-refresh");
    let expiresAt = 0;
    let timer = 0;

    const paintLeft = () => {
      // 弹窗关掉后 body 会被清空：定时器自己收尾，别留着空转
      if (!codeEl.isConnected) { clearInterval(timer); return; }
      const left = Math.max(0, expiresAt - Date.now());
      if (!left) { metaEl.textContent = "已过期，点「换新码」"; return; }
      const minutes = Math.floor(left / 60000);
      const seconds = Math.floor((left % 60000) / 1000);
      metaEl.textContent = `${minutes}:${String(seconds).padStart(2, "0")} 后过期 · 只能用一次`;
    };

    const render = (data) => {
      urlInput.value = data.relayUrl || urlInput.value;
      codeEl.textContent = data.joinCode;
      qrEl.src = data.dataUrl;
      qrEl.hidden = false;
      expiresAt = Number(data.expiresAt) || 0;
      clearInterval(timer);
      paintLeft();
      timer = setInterval(paintLeft, 1000);
      hintEl.textContent = "手机 App 扫上面的码即可加入；加入码只能用一次。";
      hintEl.classList.remove("is-error");
    };

    const load = async () => {
      if (refresh.disabled) return;
      refresh.disabled = true;
      hintEl.textContent = "正在取码…";
      hintEl.classList.remove("is-error");
      try {
        const response = await request("/api/v1/relay/join-code", {
          method: "POST",
          body: JSON.stringify({ relayUrl: urlInput.value.trim() }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          hintEl.textContent = data.message || `取码失败：HTTP ${response.status}`;
          hintEl.classList.add("is-error");
          return;
        }
        render(data);
      } catch (error) {
        if (error.message !== "forbidden") {
          hintEl.textContent = `取码失败：${error.message}`;
          hintEl.classList.add("is-error");
        }
      } finally {
        refresh.disabled = false;
      }
    };

    refresh.addEventListener("click", () => void load());
    void load();
  });
}

/** 工具活动可以整体隐掉（只看回答的那种用法） */
function applyActPref() {
  document.documentElement.dataset.acts =
    localStorage.getItem(KEY_ACTS) === "0" ? "0" : "1";
}

/* ── 运行时起停（2026-11-07）────────────────────────────────
 * 这一块**不能走 HTTP**：它要停的东西就是 HTTP 服务本身。停下去之后页面所有请求都会
 * 失败，连"现在是什么状态"都问不出来。所以状态只从壳读，跟 /healthz 无关——
 * 拿 healthz 判会把"我自己停的"误报成"服务挂了"。
 *
 * 浏览器里（非桌面壳）没有 window.mygo，退回只读提示，不出按钮。
 */
const RUNTIME_LABELS = {
  running: "运行中",
  starting: "启动中…",
  stopped: "已停止",
  failed: "未运行（异常退出）",
  unknown: "未知",
};

/** 壳方法调用：MyGo 的 call 挂在 window.mygo 上，错误以 reject 形式回来。
 *  额外参数按 MyGo 绑定签名顺序透传（例：shellCall("SetOpenAtLogin", true)）。 */
async function shellCall(method, ...args) {
  const call = window.mygo?.call;
  if (typeof call !== "function") throw new Error("only-desktop");
  const value = await call.call(window.mygo, `Shell.${method}`, ...args);
  // 有的桥接层会把结果包成 {result} / 字符串 JSON，这里统一拆一层。
  if (typeof value === "string" && value.startsWith("{")) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value?.result ?? value;
}

function paintRuntime(status) {
  const box = document.getElementById("runtime-card");
  if (!box) return;
  const label = box.querySelector("#runtime-state");
  const start = box.querySelector("#runtime-start");
  const restart = box.querySelector("#runtime-restart");
  const stop = box.querySelector("#runtime-stop");
  const state = status?.state || "unknown";

  label.textContent = `${RUNTIME_LABELS[state] || state}${status?.pid ? ` · PID ${status.pid}` : ""}`;
  label.dataset.state = state;
  // 三种按钮互斥出现：跑着才有"重启/停止"，没跑才有"启动"
  const running = state === "running";
  if (start) start.hidden = running || state === "starting";
  if (restart) restart.hidden = !running;
  if (stop) stop.hidden = !running;
}

/** 停服之后整页失去后端：盖一块本地面板，别让人对着一屏报错点。 */
function showRuntimeCurtain(visible, text) {
  let layer = document.getElementById("runtime-curtain");
  if (!layer) {
    layer = document.createElement("div");
    layer.id = "runtime-curtain";
    layer.innerHTML = `<div class="runtime-curtain-card">
      <h3>服务已停止</h3>
      <p id="runtime-curtain-text">手机连接、提醒、例行任务都已断开。历史没有丢。</p>
      <button class="btn-primary" type="button" id="runtime-curtain-start">启动服务</button>
    </div>`;
    document.body.append(layer);
    layer.querySelector("#runtime-curtain-start").addEventListener("click", () => void startRuntimeFromUi());
  }
  if (typeof text === "string") layer.querySelector("#runtime-curtain-text").textContent = text;
  layer.hidden = !visible;
  // 让 checkHealth 别再刷"服务离线"——那是我们自己停的，不是失联。
  document.body.dataset.runtime = visible ? "stopped" : "running";
}

async function startRuntimeFromUi() {
  showRuntimeCurtain(true, "启动中…（首次启动要加载技能与记忆，通常 10–25 秒）");
  try {
    paintRuntime(await shellCall("StartRuntime"));
    // 起来了就整页重来：SSE、健康轮询、会话列表一起重建，比逐块热修可靠。
    location.reload();
  } catch (error) {
    showRuntimeCurtain(true, `启动失败：${error.message}`);
  }
}

async function initRuntimeCard() {
  const box = document.getElementById("runtime-card");
  if (!box) return;
  if (!inShell()) {
    const label = box.querySelector("#runtime-state");
    if (label) label.textContent = "仅桌面端可操作";
    for (const id of ["runtime-start", "runtime-restart", "runtime-stop"]) {
      const node = box.querySelector(`#${id}`);
      if (node) node.hidden = true;
    }
    return;
  }

  const refresh = async () => {
    try {
      paintRuntime(await shellCall("RuntimeStatus"));
    } catch {
      paintRuntime(null);
    }
  };
  await refresh();

  box.querySelector("#runtime-stop")?.addEventListener("click", async () => {
    const ok = await openConfirm({
      title: "停止服务",
      message: "停掉 Node 服务？",
      detail: "手机连接、提醒、正在跑的任务都会断开。历史不会丢。",
      confirmText: "停止服务",
      danger: true,
    });
    if (!ok) return;
    try {
      paintRuntime(await shellCall("StopRuntime"));
      showRuntimeCurtain(true);
    } catch (error) {
      showAlert("停止失败", error.message);
      await refresh();
    }
  });
  box.querySelector("#runtime-start")?.addEventListener("click", () => void startRuntimeFromUi());
  box.querySelector("#runtime-restart")?.addEventListener("click", async () => {
    const ok = await openConfirm({
      title: "重启服务",
      message: "重启 Node 服务？",
      detail: "正在生成的回答会中断，历史不会丢。",
      confirmText: "重启",
    });
    if (!ok) return;
    try {
      await shellCall("RestartRuntime");
      location.reload();
    } catch (error) {
      showRuntimeCurtain(true, `重启失败：${error.message}`);
    }
  });

  // 上次是用户停的：进来就显面板，别先闪一下"服务离线"
  const status = await shellCall("RuntimeStatus").catch(() => null);
  if (status?.state === "stopped") showRuntimeCurtain(true);

  await initAutostartRow();
}

/* 开机自启（2026-11-08 扫尾批 4b）。
 * 读不到状态就不渲染：浏览器里没有 Shell，`LIFEDIARY_SHELL_BINDINGS=off` 时整组
 * 绑定也没挂——两种情况都落在 OpenAtLogin 调用失败上，与"整组同退"口径一致。 */
async function initAutostartRow() {
  const row = document.getElementById("autostart-row");
  const divider = document.getElementById("autostart-divider");
  const sw = row?.querySelector("[data-autostart-switch]");
  if (!row || !divider || !sw) return;

  let enabled;
  try {
    enabled = Boolean(await shellCall("OpenAtLogin"));
  } catch {
    return; // 没有绑定：保持隐藏
  }
  row.hidden = false;
  divider.hidden = false;
  sw.setAttribute("aria-checked", enabled ? "true" : "false");

  sw.addEventListener("click", async () => {
    const next = sw.getAttribute("aria-checked") !== "true";
    sw.disabled = true;
    try {
      const now = Boolean(await shellCall("SetOpenAtLogin", next));
      sw.setAttribute("aria-checked", now ? "true" : "false");
      toast(now ? "已开启开机自启" : "已关闭开机自启");
    } catch (error) {
      showAlert("没改成功", error.message);
    } finally {
      sw.disabled = false;
    }
  });
}

/** 服务页读数（2026-11-09 拆分后；2026-11-13 用量搬走）：只剩鉴权一行。
 *  「未配置（仅本机）」读起来像缺了一块配置，实际是本机浏览器的正常形态：
 *  loopback + 本机 cookie 直通，不需要令牌 —— 文案改成「本机无需配置」。
 *  容器里带了令牌（外面开过、验证过）才显示「已配置令牌」。 */
function loadServiceInfo() {
  const node = document.getElementById("svc-auth");
  if (!node) return;
  node.textContent = state.token ? "已配置令牌" : "本机无需配置";
}

export { RUNTIME_LABELS, applyActPref, connRelay, initAutostartRow, initRuntimeCard, loadPair, loadRelayStatus, loadServiceInfo, openAddDeviceModal, paintRuntime, shellCall, showRuntimeCurtain, startRuntimeFromUi, updateConnectionHint };
