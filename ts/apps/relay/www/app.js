/* 镜像控制台（2026-11-05 多端同步方案块1）。
 *
 * 本页是"控制端"的活样例：配对加入码 → hello → invoke 通道 → push 事件流。
 * 语义与 harness 的 web 界面一致（被控端是唯一事实源，这里只是镜子）：
 * 断线重连后用 events/subscribe 从上次 seq 补帧，窗口滑过就全量重建。
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const LS_KEY = "relay.console.token";

  let ws = null;
  let selfDeviceId = null;
  let pending = new Map(); // invokeId → {resolve, reject, timer}
  let subs = new Map(); // conversationId → {subscriptionId, lastSeq}
  let activeConversation = null;
  let invokeSeq = 0;

  const setStatus = (text, ok) => {
    $("status").textContent = text;
    $("status").className = ok ? "ok" : "";
  };

  const token = () => localStorage.getItem(LS_KEY) || "";

  function saveToken(value) {
    if (value) localStorage.setItem(LS_KEY, value);
    else localStorage.removeItem(LS_KEY);
    $("forgetBtn").style.display = value ? "" : "none";
  }

  async function api(path, body, auth = true) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth && token() ? { authorization: `Bearer ${token()}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path} → ${res.status}`);
    return res.json();
  }

  // ── invoke / push ─────────────────────────────────────────────
  function invoke(dst, channel, payload, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== 1) return reject(new Error("中继未连接"));
      const id = `c${++invokeSeq}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${channel} 超时`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ kind: "deliver", id, dst, channel, payload }));
    });
  }

  function hello(tokenValue) {
    ws.send(JSON.stringify({
      kind: "hello", v: 1, token: tokenValue,
      deviceName: "镜像控制台", platform: "web", capabilities: ["mirror"],
    }));
  }

  function connect() {
    if (!token()) { setStatus("先配对"); return; }
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => hello(token());
    ws.onmessage = (e) => {
      const frame = JSON.parse(e.data);
      if (frame.kind === "welcome") {
        selfDeviceId = frame.deviceId;
        setStatus(`已连接（我是 ${frame.deviceId.slice(0, 8)}）`, true);
        renderDevices(frame.devices);
      } else if (frame.kind === "routed") {
        if (frame.channel.startsWith("push/session:")) onPush(frame.channel.slice("push/session:".length), frame.payload);
      } else if (frame.kind === "result" && pending.has(frame.id)) {
        const p = pending.get(frame.id);
        pending.delete(frame.id);
        clearTimeout(p.timer);
        frame.ok ? p.resolve(frame.result) : p.reject(new Error(`${frame.error?.code}: ${frame.error?.message}`));
      } else if (frame.kind === "error") {
        setStatus(`错误：${frame.code} ${frame.message}`);
        if (frame.id && pending.has(frame.id)) {
          const p = pending.get(frame.id);
          pending.delete(frame.id);
          clearTimeout(p.timer);
          p.reject(new Error(frame.message));
        }
      } else if (frame.kind === "ping") {
        ws.send(JSON.stringify({ kind: "pong", at: Date.now() }));
      }
    };
    ws.onclose = (e) => {
      setStatus(e.code === 4409 ? "被同设备顶替" : "已断开，3s 后重连");
      subs.clear();
      setTimeout(connect, 3000);
    };
  }

  // ── 设备 / 会话 ────────────────────────────────────────────────
  async function renderDevices(devices) {
    const list = devices || (await api("/api/relay/devices", undefined)).devices;
    $("deviceSel").innerHTML = list
      .filter((d) => d.id !== selfDeviceId)
      .map((d) => `<option value="${d.id}">${d.online ? "●" : "○"} ${d.name}（${d.platform}${d.capabilities.length ? " · " + d.capabilities.join(",") : ""}）</option>`)
      .join("");
  }

  async function loadSessions() {
    const dst = $("deviceSel").value;
    if (!dst) return alert("先选设备");
    const { chats } = await invoke(dst, "sessions/list", { limit: 50 });
    $("sessions").innerHTML = chats.length
      ? chats.map((c) => `<div class="session" data-id="${c.conversationId}">${c.title || c.firstText || "(空会话)"}<small>${new Date(c.lastAt).toLocaleTimeString()}</small></div>`).join("")
      : `<span class="notice">该设备还没有会话</span>`;
    for (const el of $("sessions").querySelectorAll(".session")) {
      el.onclick = () => openSession(el.dataset.id, el.textContent);
    }
  }

  // ── 事件流（镜像）─────────────────────────────────────────────
  async function openSession(conversationId) {
    const dst = $("deviceSel").value;
    activeConversation = conversationId;
    $("stream").innerHTML = "";
    for (const [, sub] of subs) dst && invoke(dst, "events/unsubscribe", { subscriptionId: sub.subscriptionId }).catch(() => {});
    subs.clear();
    const replay = await invoke(dst, "events/subscribe", { conversationId, sinceSeq: 0 });
    subs.set(conversationId, { subscriptionId: replay.subscriptionId, lastSeq: replay.from + (replay.events?.length || 0) - 1 });
    for (const item of replay.events || []) appendEvent(item.event);
    if (!(replay.events || []).length) $("stream").innerHTML = `<span class="notice">暂无历史帧</span>`;
  }

  function onPush(conversationId, payload) {
    if (conversationId !== activeConversation) return;
    const sub = subs.get(conversationId);
    if (!sub) return;
    if (payload.resync) { $("stream").innerHTML = ""; }
    for (const item of payload.events || []) appendEvent(item.event);
    sub.lastSeq = payload.from + (payload.events?.length || 0) - 1;
  }

  function appendEvent(event) {
    const div = document.createElement("div");
    div.className = "msg";
    const role = event.role || event.type || "event";
    const text = typeof event.delta === "string" ? event.delta : (event.text || event.summary || JSON.stringify(event).slice(0, 400));
    div.innerHTML = `<span class="t">${new Date().toLocaleTimeString()}</span><b>${role}</b>`;
    div.appendChild(document.createTextNode(text));
    $("stream").appendChild(div);
    $("stream").scrollTop = $("stream").scrollHeight;
  }

  // ── 发送 / 审批 ────────────────────────────────────────────────
  async function sendText() {
    const dst = $("deviceSel").value;
    const text = $("text").value.trim();
    if (!dst || !text || !activeConversation) return alert("选设备、开会话、写字");
    await invoke(dst, "chat/send", { conversationId: activeConversation, text });
    $("text").value = "";
  }

  async function loadApprovals() {
    const dst = $("deviceSel").value;
    if (!dst) return alert("先选设备");
    const { approvals } = await invoke(dst, "approvals/pending", {});
    $("approvals").innerHTML = approvals.length
      ? ""
      : `<span class="notice">空</span>`;
    for (const a of approvals) {
      const div = document.createElement("div");
      div.className = "approval";
      const head = document.createElement("div");
      head.textContent = `${a.tool}（${a.conversationId ? a.conversationId.slice(0, 8) : "?"}）`;
      const code = document.createElement("code");
      code.textContent = a.args;
      const yes = document.createElement("button"); yes.textContent = "批准";
      const no = document.createElement("button"); no.textContent = "拒绝";
      yes.onclick = () => answer(a.callId, "approve");
      no.onclick = () => answer(a.callId, "reject");
      div.append(head, code, yes, no);
      $("approvals").appendChild(div);
    }
  }

  async function answer(callId, decision) {
    const dst = $("deviceSel").value;
    await invoke(dst, "approvals/answer", { callId, decision });
    loadApprovals();
  }

  // ── 配对 ────────────────────────────────────────────────────────
  async function pair() {
    try {
      const out = await api("/api/relay/pair/redeem", { code: $("code").value.trim(), deviceName: "镜像控制台", platform: "web", capabilities: ["mirror"] }, false);
      saveToken(out.deviceToken);
      connect();
    } catch (error) {
      setStatus(`配对失败：${error.message}`);
    }
  }

  $("pairBtn").onclick = pair;
  $("forgetBtn").onclick = () => { saveToken(""); location.reload(); };
  $("refreshBtn").onclick = () => renderDevices().catch((e) => setStatus(e.message));
  $("sessionsBtn").onclick = () => loadSessions().catch((e) => setStatus(e.message));
  $("approvalsBtn").onclick = () => loadApprovals().catch((e) => setStatus(e.message));
  $("sendBtn").onclick = () => sendText().catch((e) => setStatus(e.message));
  $("text").addEventListener("keydown", (e) => { if (e.key === "Enter") sendText(); });

  if (token()) { $("forgetBtn").style.display = ""; connect(); }
})();
