/**
 * 连接页链路图 + 运行时起停
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { ago, connDeviceRows, connPhoneCount } from "./approval-pop.js";
import { attr, esc } from "./markdown.js";
import { request } from "./net.js";
import { state } from "./state.js";
import { closeModal, inShell, openConfirm, openModal, showAlert, toast } from "./ui-atoms.js";


/* ── 连接页链路图（2026-11-13，2026-11-14 重排为「电脑 → 中继 → 手机」三步）──
   链路是单向的：中继是门牌，电脑先登记，手机才有码可扫。所以每一步都得有入口：
   第一步缺失时，第二步的按钮**不准置灰**——置灰等于死路（用户 2026-11-14：
   「我不应该在没连上的时候就输入地址吗」）。 */
let connRelay = {
  loaded: false,
  configured: false,
  connected: false,
  relayUrl: "",
  deviceName: "",
  source: null,
  peers: 0,
  peersOnline: 0,
  // 2026-11-14 稳定性补丁：断线诊断（后端 relay/status 直出）
  reconnects: 0,
  lastCloseCode: null,
  lastCloseAt: null,
  lastConnectedAt: null,
  /** 同机另一个 harness 占着中继身份时，这里是它的 pid（后端 NS-02 直出） */
  blockedByPid: null,
};

/**
 * 断线时间的人话。不要用 `ago`（那边是"上次用过"的员工口吻），重连窗口通常几十秒，
 * 秒级读数才有用——"12 秒前断开"能对上页面 10 秒轮询的跳动。
 */
function connAgo(at) {
  if (!at) return "";
  const diff = Date.now() - at;
  if (diff < 60_000) return `${Math.max(1, Math.round(diff / 1000))} 秒前`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  return `${Math.floor(diff / 3_600_000)} 小时前`;
}

/** 中继关闭码 → 一句人话（不让用户对着 code=4409 猜） */
function connCloseHint(code) {
  switch (code) {
    case 4409:
      return "另一个同名连接在顶替——多半是重复启动了两个服务";
    case 4401:
      return "令牌被中继撤销了，需要重新接入";
    case 4400:
      return "协议版本不符，升级中继或本机";
    case 1013:
      return "中继过载主动断的，会自动回来";
    case 1006:
    case 1001:
      return "连接被中间网络静默掐断（心跳已在维持）";
    default:
      return "";
  }
}

async function loadRelayStatus() {
  // 2026-11-14 星形拓扑：状态不再写进某个链路图节点（那三个格子没了），
  // 而是进 connRelay，由 paintConnStar / 各节自己读。
  const star = document.getElementById("conn-star");
  if (!star) return;
  let status = null;
  try {
    const response = await request("/api/v1/relay/status", { cache: "no-store" });
    if (response.ok) status = await response.json();
  } catch {
    status = null;
  }
  connRelay = {
    loaded: status !== null,
    configured: status?.configured === true,
    connected: status?.connected === true,
    relayUrl: status?.relayUrl || "",
    deviceName: status?.deviceName || "",
    source: status?.source || null,
    peers: connRelay.peers,
    peersOnline: connRelay.peersOnline,
    reconnects: Number(status?.reconnects) || 0,
    lastCloseCode: status?.lastCloseCode ?? null,
    lastCloseAt: status?.lastCloseAt ?? null,
    lastConnectedAt: status?.lastConnectedAt ?? null,
    blockedByPid: status?.blockedByPid ?? null,
  };

  paintRelaySection();
  paintNextStep();
  updateConnectionHint();
  if (connRelay.connected) void loadRelayRoster();
}

/** 「中继」那一节：未接入 = 接入；已接入 = 地址 + 换地址/断开。 */
function paintRelaySection() {
  const hint = document.getElementById("relay-link-hint");
  const button = document.getElementById("relay-link-btn");
  const unlink = document.getElementById("relay-unlink-row");
  if (hint) {
    hint.textContent = connRelay.configured
      ? `${connRelay.relayUrl || "地址未知"}${connRelay.deviceName ? ` · ${connRelay.deviceName}` : ""}`
      : "电脑还没接入——填一次地址和主令牌，之后常年挂着";
  }
  if (button) button.textContent = connRelay.configured ? "换地址" : "接入";
  if (unlink) unlink.hidden = !connRelay.configured || connRelay.source === "env";
  paintConnStar();

  // 2026-11-14 二次打磨：页面里不再重复"经过中继"这种解释——用户原话「经过中继我觉得就是没啥用了」。
  // 手机上只留一个动作：添加手机。中继通不通由上面的星形中心和 conn-hint 一句话说清。
  const addButton = document.getElementById("relay-add-device");
  // 永不置灰：没到这一步时文案变「先接入中继」，点了直接开接入弹窗
  if (addButton) {
    addButton.textContent = connRelay.connected ? "添加手机" : "先接入中继";
    addButton.disabled = false;
  }
}

/**
 * 星形拓扑（2026-11-14，2026-11-14 二次打磨）：中心是全页唯一要回答的问题——「这台电脑
 * 有没有挂在中继上」；四周是本机和所有已知设备。它不是网状：设备之间没有直连通路，
 * 线只从中心或本机发出。
 *
 * 视觉上的三条规矩（用户这一轮点名的）：
 * ① 在线状态**不再在圆上飘一个小点**，改成圆本身：在线 = 淡强调色实心 + 强调描边，离线 = 素色。
 * ② 名字下面跟一枚同色小点（点在前、名字在后），状态读起来是一句话，不是两个图形。
 * ③ 容器窄的时候不再缩到看不清：SVG 有最小宽度，横向可滚；点一下放大到 1.4 倍，再点收回。
 */
function paintConnStar() {
  const box = document.getElementById("conn-star");
  if (!box) return;
  if (!connRelay.loaded) {
    box.innerHTML = "";
    return;
  }

  const selfName = connRelay.deviceName || "这台电脑";
  const nodes = [
    { name: selfName, initial: "本", self: true, online: true, relay: connRelay.connected, idle: false },
    // 图只画「经中继的连接」（2026-11-15，用户："上面的图片改一改，只保留和中继连接的内容"）。
    // 本地直连的设备、没登记而直连的凭据不再进这张图——它们仍在下面的「已连接的设备」里，
    // 认领也在那里。图只回答一件事：中继这条通路现在长什么样，别把两条通路混在一张图上读。
    ...(connDeviceRows || [])
      .filter((row) => row.relayIds.length > 0)
      .map((row) => ({
        name: row.name,
        initial: (row.name || "?").trim().slice(0, 1),
        self: false,
        online: row.online,
        relay: true,
        idle: row.lastSeenAt ? Date.now() - row.lastSeenAt > 7 * 86_400_000 : false,
      })),
  ];
  const MAX = 8;
  const shown = nodes.slice(0, MAX);
  const hidden = nodes.length - shown.length;

  const W = 360;
  const H = 252;
  const cx = 180;
  const cy = 114;
  const rx = 136;
  const ry = 84;
  // 本机固定在左侧（角度 π）；经中继的设备排在右侧、自上而下成一把「扇」。
  // 本机与它们之间隔着一个中继圆，所以线只从圆心发出——不存在"本机直连设备"那条线了（2026-11-15）。
  const angles = shown.map(() => Math.PI);
  const relaySlots = shown
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => !node.self);
  relaySlots.forEach(({ index }, k) => {
    angles[index] = Math.PI * 1.5 + ((k + 1) / (relaySlots.length + 1)) * Math.PI;
  });
  const pointAt = (angle) => ({ x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry });
  const points = angles.map(pointAt);

  const lines = [];
  const marks = [];
  const relayUp = connRelay.connected;
  // 中继没连上时，登记在中继里的设备照样画一条线，但画成灰色虚线：
  // 名册里有它、这条通路当前不通——比"凭空消失"诚实。
  const hubStroke = relayUp
    ? `stroke="var(--accent-line)" stroke-width="1.2"`
    : `stroke="var(--divider)" stroke-width="1.2" stroke-dasharray="4 3"`;
  const hubState = relayUp
    ? "已连上"
    : connRelay.blockedByPid
      ? `pid ${connRelay.blockedByPid} 占用`
      : connRelay.configured
        ? "重连中"
        : "未接入";

  // 中心：中继
  marks.push(
    `<circle cx="${cx}" cy="${cy}" r="30" fill="${relayUp ? "var(--accent-soft)" : "var(--surface-low)"}" stroke="${
      relayUp ? "var(--accent-line)" : "var(--divider)"
    }" stroke-width="1"/>`,
    `<text x="${cx}" y="${cy - 3}" text-anchor="middle" font-size="12.5" fill="var(--text)">中继</text>`,
    `<text x="${cx}" y="${cy + 13}" text-anchor="middle" font-size="10" fill="var(--text-3)">${hubState}</text>`,
  );

  for (let index = 0; index < shown.length; index += 1) {
    const node = shown[index];
    const place = points[index];
    if (node.self && node.relay) {
      lines.push(`<line x1="${cx - 30}" y1="${cy}" x2="${place.x + 17}" y2="${place.y}" ${hubStroke}/>`);
    }
    if (!node.self && node.relay) {
      lines.push(`<line x1="${cx}" y1="${cy}" x2="${place.x}" y2="${place.y}" ${hubStroke}/>`);
    }
    const short = node.name.length > 6 ? `${node.name.slice(0, 6)}…` : node.name;
    // 名字下面：小点在前、名字在后，读起来是「● 书房主机」。
    // 宽度要**按字符分别算**再整体居中：汉字约 10.5px，ASCII/数字约 5.6px。
    // 只用"字数×半宽"估，中英混排（vivo手机）会把点推到很左、看着像飘着（用户 2026-11-14 报的就是这个）。
    const nameWidth = [...short].reduce(
      (width, char) => width + (char.codePointAt(0) > 0x2e80 || char === "…" ? 10.5 : 5.6),
      0,
    );
    const DOT_SIZE = 4.8;
    const DOT_GAP = 5.6;
    const labelWidth = DOT_SIZE + DOT_GAP + nameWidth;
    const labelLeft = place.x - labelWidth / 2;
    const dotX = labelLeft + DOT_SIZE / 2;
    const textX = labelLeft + DOT_SIZE + DOT_GAP;
    const dotY = place.y + 29;
    // 悬停说明走 data-tip（2026-11-14：解释性文字一律搬进浮签，图形上只留名字）
    const tipParts = [node.name, node.self ? "本机" : ""];
    if (node.relay) tipParts.push("经中继");
    tipParts.push(node.online ? "在线" : "离线");
    if (node.idle) tipParts.push("久未使用");
    marks.push(
      `<g data-tip="${attr(tipParts.filter(Boolean).join(" · "))}">` +
        `<circle cx="${place.x}" cy="${place.y}" r="16" fill="${
          node.online ? "var(--accent-soft)" : "var(--surface-low)"
        }" stroke="${node.online ? "var(--accent-line)" : "var(--divider)"}" stroke-width="1"/>` +
        `<text x="${place.x}" y="${place.y + 4}" text-anchor="middle" font-size="11" fill="${
          node.online ? "var(--text)" : "var(--text-3)"
        }">${esc(node.initial)}</text>` +
        `<circle cx="${dotX}" cy="${dotY - 3.2}" r="${DOT_SIZE / 2}" fill="${
          node.online ? "var(--ok)" : "var(--text-3)"
        }"/>` +
        `<text x="${textX}" y="${dotY}" text-anchor="start" font-size="10.5" fill="${
          node.online && !node.idle ? "var(--text-2)" : "var(--text-3)"
        }">${esc(short)}</text></g>`,
    );
  }

  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="连接拓扑">${lines.join("")}${marks.join("")}${
    hidden > 0
      ? `<text x="${W - 12}" y="${H - 8}" text-anchor="end" font-size="10" fill="var(--text-3)">+${hidden} 台未画出</text>`
      : ""
  }</svg>`;
}

/** 链路图下面那一个「下一步」按钮：永远指向还没做的那一步。 */
function paintNextStep() {
  const box = document.getElementById("conn-next");
  if (!box) return;
  if (!connRelay.loaded) {
    box.hidden = true;
    return;
  }
  // 被同机另一个 harness 占着中继身份时，这一步不归本进程管（点「接入」只会拿到 409）：
  // 收起主按钮，让上面那行提示去说"关掉多余的实例"。
  if (connRelay.blockedByPid) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  if (!connRelay.configured) {
    box.hidden = false;
    box.innerHTML = `<button class="btn-primary" type="button" id="conn-next-go">接入中继</button>`;
    box.querySelector("#conn-next-go").addEventListener("click", () => openRelayLinkModal());
    return;
  }
  if (!connRelay.connected) {
    box.hidden = false;
    box.innerHTML = `<button class="ghost" type="button" id="conn-next-go">重新检测</button>`;
    box.querySelector("#conn-next-go").addEventListener("click", () => void loadRelayStatus());
    return;
  }
  if (!connRelay.peers) {
    box.hidden = false;
    box.innerHTML = `<button class="btn-primary" type="button" id="conn-next-go">添加手机</button>`;
    box.querySelector("#conn-next-go").addEventListener("click", () => openAddDeviceModal());
    return;
  }
  box.hidden = true;
  box.innerHTML = "";
}

/** 一行断点提示：只在「这条通路现在不通/有问题」时出现（2026-11-15：连上之后不再铺说明文字）。 */
function updateConnectionHint() {
  const hint = document.getElementById("conn-hint");
  if (!hint) return;
  const say = (text) => {
    hint.hidden = false;
    hint.textContent = text;
  };
  if (!connRelay.loaded) {
    say("正在读取中继状态…");
    return;
  }
  if (connRelay.blockedByPid) {
    // NS-02：同一台电脑上两个 harness 拿同一枚设备令牌连中继，会互相顶替（4409），
    // 表现就是"时而连上时而连不上"。这里必须说清是谁占着，别让人去怀疑网络。
    say(`本机已有一个 harness（pid ${connRelay.blockedByPid}）在代这台电脑连中继，本进程不再连——两个一起连会互相顶断。关掉多余的窗口/终端，再点「重启」只留一个。`);
    return;
  }
  if (!connRelay.configured) {
    say("电脑还没接入中继——下面「中继地址」一行填一次就行");
    return;
  }
  if (!connRelay.connected) {
    // 2026-11-14 稳定性补丁：重连不再只写一句"正在重连中继"——把次数、最近断开时间、
    // 关闭码对应的人话都摆出来，用户看到的就是"掉了一下又回来"，而不是玄学。
    const at = connRelay.lastCloseAt ? `，${connAgo(connRelay.lastCloseAt)}断开` : "";
    const why = connCloseHint(connRelay.lastCloseCode);
    say(`已接入 ${connRelay.relayUrl || "中继"}，正在自动重连（第 ${
      connRelay.reconnects || 1
    } 次${at}）${why ? `——${why}` : ""}`);
    return;
  }
  // 中继已连上：图形本身就说明了一切，不再补"几台设备经中继接入"这类解释句。
  hint.textContent = "";
  hint.hidden = true;
}

/* ── 经中继的设备（2026-11-14 二次打磨：只数不列）────────────────────
   以前这里会把中继名册单独列一遍，结果同一台 vivo 手机在「远程连接」和「已连接的设备」
   各出现一次（用户原话：「远程连接底下显示的 vivo 手机也没啥用，应该放在已连接设备里头」）。
   现在这里只回答两个数：几台经中继接入、几台在线；名单统一由「已连接的设备」出。 */
async function loadRelayRoster() {
  try {
    const response = await request("/api/v1/relay/overview", { cache: "no-store" });
    const data = await response.json();
    const self = data?.selfDeviceId || "";
    const devices = (data?.devices || []).filter((device) => device.id !== self);
    connRelay.peers = devices.length;
    connRelay.peersOnline = devices.filter((device) => device.online).length;
  } catch {
    // 读不到就保持上一次的结论，不把页面清成空白
  }
  paintConnStar();
  updateConnectionHint();
  paintNextStep();
}

async function loadPair() {
  const image = document.getElementById("pair-qr");
  const metaEl = document.getElementById("pair-meta");
  const box = document.getElementById("pair-qr-box");
  const button = document.getElementById("pair-refresh");
  if (!image) return;
  try {
    const response = await request("/api/v1/pair/qr", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    image.src = data.dataUrl;
    if (box) box.hidden = false;
    // 一行式的按钮：第一次是"显示二维码"，出过码之后就是"换一个码"
    if (button) button.textContent = "换一个码";
    // 原始 url 不再铺在页面上（2026-11-13：一长串没人念得出来），只留机器名与有效期
    if (metaEl) metaEl.textContent = `${data.machineName} · ${Math.round(data.expiresInSeconds / 60)} 分钟内有效`;
  } catch (error) {
    if (error.message === "forbidden") return;
    if (metaEl) {
      if (box) box.hidden = false;
      metaEl.textContent = "拿不到配对码，稍后再试";
    }
  }
}

/**
 * 接入中继（2026-11-14，连接页第一步）：地址 + 主令牌 → 本机自己的设备令牌。
 *
 * 这一步以前只存在于 `.env`，页面上只有一段教程；结果是"未连上"时用户无处可填，
 * 出码按钮只能灰着。现在它是最靠前的一个动作，填完就地连上，不用重启。
 */
function openRelayLinkModal() {
  openModal("接入中继", (body) => {
    body.innerHTML = `
      <div class="modal-field">
        <span>中继地址</span>
        <input class="modal-input" id="relay-link-url" spellcheck="false" autocomplete="off"
               placeholder="http://1.2.3.4:8084" aria-label="中继地址" />
      </div>
      <div class="modal-field">
        <span>主令牌</span>
        <input class="modal-input" id="relay-link-token" type="password" autocomplete="off"
               placeholder="VPS 上的 RELAY_OWNER_TOKEN" aria-label="主令牌" />
      </div>
      <div class="modal-field">
        <span>这台电脑的名字</span>
        <input class="modal-input" id="relay-link-name" spellcheck="false" autocomplete="off"
               placeholder="不填就用电脑名" aria-label="设备名" />
      </div>
      <div class="modal-hint" id="relay-link-note">
        主令牌只用来换这台电脑自己的凭据；存在本机，不再显示，也不进日志。
      </div>
      <div class="modal-actions">
        <button class="modal-primary" type="button" id="relay-link-go">接入并连接</button>
      </div>`;
    const urlInput = body.querySelector("#relay-link-url");
    const tokenInput = body.querySelector("#relay-link-token");
    const nameInput = body.querySelector("#relay-link-name");
    const note = body.querySelector("#relay-link-note");
    const go = body.querySelector("#relay-link-go");
    urlInput.value = connRelay.relayUrl || "";
    nameInput.value = connRelay.deviceName || "";

    const say = (text, bad = false) => {
      note.textContent = text;
      note.classList.toggle("is-error", bad);
    };

    const submit = async () => {
      if (go.disabled) return;
      const address = urlInput.value.trim();
      const ownerToken = tokenInput.value.trim();
      if (!address) return say("先填中继地址", true);
      if (!ownerToken) return say("还缺主令牌：VPS 上的 RELAY_OWNER_TOKEN", true);
      go.disabled = true;
      say("正在接入…");
      try {
        const response = await request("/api/v1/relay/link", {
          method: "POST",
          body: JSON.stringify({ address, ownerToken, deviceName: nameInput.value.trim() }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          say(data.message || `接入失败：HTTP ${response.status}`, true);
          return;
        }
        closeModal();
        toast(data.connected ? `已接入中继 · ${data.deviceName}` : "已保存接入信息，正在等待连上");
        void loadRelayStatus();
      } catch (error) {
        if (error.message !== "forbidden") say(`接入失败：${error.message}`, true);
      } finally {
        go.disabled = false;
      }
    };

    go.addEventListener("click", () => void submit());
    tokenInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") void submit();
    });
  });
}

/**
 * 「添加手机」：经中继出一枚一次性加入码。
 *
 * 浏览器不直连中继——跨源没开 CORS，owner 令牌也绝不能下发客户端。
 * 这里调 harness 的 `/api/v1/relay/join-code`，由服务端代调中继并生成二维码。
 * **地址不放在弹窗顶上**（2026-11-14 挪走）：它填的是"手机该往哪连"，不是"电脑该往哪连"，
 * 放在这里只会让人以为添加设备=输地址。只在"手机连不上"时展开改。
 */
function openAddDeviceModal() {
  openModal("添加手机", (body) => {
    body.innerHTML = `
      <div class="relay-join">
        <img class="relay-join-qr" id="relay-join-qr" alt="加入二维码" hidden />
        <div class="relay-join-side">
          <div class="relay-join-label">加入码</div>
          <div class="relay-join-code" id="relay-join-code">正在取码…</div>
          <div class="relay-join-meta" id="relay-join-meta"></div>
        </div>
      </div>
      <div class="modal-hint" id="relay-join-hint">手机 App 扫上面的码即可加入；加入码只能用一次。扫完在下面「已连接的设备」里能看到它，标明「远程连接（经中继）」。</div>
      <div class="modal-actions">
        <button class="modal-primary" type="button" id="relay-join-refresh">换新码</button>
      </div>
      <details class="relay-adv">
        <summary>手机连不上？改对外地址</summary>
        <div class="modal-field">
          <span>手机要访问的中继地址</span>
          <input class="modal-input" id="relay-join-url" spellcheck="false" autocomplete="off"
                 placeholder="http://<中继地址>:<端口>" aria-label="中继对外地址" />
        </div>
      </details>`;
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
      hintEl.textContent = "手机 App 扫上面的码即可加入；加入码只能用一次。扫完在下面「已连接的设备」里能看到它，标明「远程连接（经中继）」。";
      hintEl.classList.remove("is-error");
      // 扫完就能在名册里看见（10 秒轮询，不用手动刷）
      setTimeout(() => void loadRelayRoster(), 8000);
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

/** 断开中继（从页面接入的那份）：停客户端 + 删本地文件。`.env` 来源的由服务端拒绝。 */
async function unlinkRelay() {
  const ok = await openConfirm({
    title: "断开中继",
    message: "断开这台电脑与中继的连接？",
    detail: "断掉之后手机就连不到这台电脑；重新接入只需再填一次地址和主令牌。",
    confirmText: "断开",
    danger: true,
  });
  if (!ok) return;
  try {
    const response = await request("/api/v1/relay/unlink", { method: "POST" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      showAlert("没断成", data.message || `HTTP ${response.status}`);
      return;
    }
    toast("已断开中继");
    void loadRelayStatus();
  } catch (error) {
    if (error.message !== "forbidden") showAlert("没断成", error.message);
  }
}

export { RUNTIME_LABELS, connRelay, paintConnStar, initAutostartRow, initRuntimeCard, loadPair, loadRelayRoster, loadRelayStatus, loadServiceInfo, openAddDeviceModal, openRelayLinkModal, paintNextStep, paintRelaySection, paintRuntime, shellCall, showRuntimeCurtain, startRuntimeFromUi, unlinkRelay, updateConnectionHint };
