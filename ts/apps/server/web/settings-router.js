/**
 * 设置页总路由 renderSettings
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { loadDevices, refreshApprovalPopups } from "./approval-pop.js";
import { loadArchivePage, renderArchiveChats } from "./archive-page.js";
import { KEY_NOTIFY } from "./chat-notice.js";
import { el } from "./dom.js";
import { openExportModal } from "./export-data.js";
import { memorySettingsMarkup, stopMemoryPolling, wireMemorySettings } from "./memory-page.js";
import { loadPartners, openCreatePartnerModal } from "./partner-modals.js";
import { openChiefChat } from "./partners-status.js";
import { resize } from "./plus-menu.js";
import { openAddProjectModal } from "./project-modal.js";
import { showProviderTemplates } from "./providers.js";
import { currentRoute, currentSettingsPage, go } from "./route.js";
import { openAddSearchSourceModal } from "./search-sources.js";
import { replayPageEnter, rowMarkup, sectionMarkup, switchMarkup } from "./settings-atoms.js";
import { ACCENTS, renderSettingsNav } from "./settings-base.js";
import { applyActPref, initRuntimeCard, loadPair, loadRelayStatus, loadServiceInfo, openAddDeviceModal } from "./settings-connection.js";
import { memorySettingsMarkupLegacy, wireMemorySettingsLegacy } from "./settings-memory.js";
import { loadProjectsSettings } from "./settings-projects.js";
import { loadPolicy, loadReminders, openReminderModal, renderDefaultModelRow } from "./settings-reminders.js";
import { loadAutoArchiveSettings, loadFlagsSettings, saveAutoArchiveDays, toggleFlag } from "./settings-switches.js";
import { loadModelsInfo, loadUsagePage } from "./settings-usage.js";
import { openBulkSkillModal, openCreateSkillChoiceModal } from "./skills-actions.js";
import { applySkillAdvice, loadSkills, runSkillAdvice } from "./skills-settings.js";
import { state } from "./state.js";
import { ensureFlag } from "./tasks-redesign.js";
import { KEY_ACCENT, KEY_ACTS, KEY_SEND, THEMES, currentThemeChoice, openFontModal, setAccent, setThemeChoice } from "./theme.js";
import { closePopover, toast } from "./ui-atoms.js";

let pairTimer = 0;
async function renderSettings() {
  const page = currentSettingsPage();
  // 记忆页整理轮询：一离开设置页就停；回来由 wireMemorySettings 重新按服务端状态接上。
  stopMemoryPolling();
  renderSettingsNav(page);
  el.settingsInner.setAttribute("role", "tabpanel");
  el.settingsInner.setAttribute("aria-labelledby", `settings-tab-${page}`);

  if (page === "appearance") {
    const choice = currentThemeChoice();
    const accent = localStorage.getItem(KEY_ACCENT) || "indigo";
    el.settingsInner.innerHTML = sectionMarkup(
      "外观",
      `<div class="card">
        ${rowMarkup(
          "主题",
          "四套色板，点哪套就固定下来（不再跟随系统）",
          `<div class="theme-picker" role="radiogroup" aria-label="主题">
             ${THEMES.map(
               (item) =>
                 `<button class="theme-choice" type="button" role="radio"
                    data-theme-choice="${item.id}" aria-checked="${choice === item.id}"
                    title="${item.name}" aria-label="${item.name}"
                    style="--tc-bg:${item.bg};--tc-card:${item.card};--tc-accent:${item.accent}">
                    <span class="theme-chip" aria-hidden="true">
                      <span class="theme-chip-dot"></span>
                      <span class="theme-chip-card"></span>
                    </span>
                    <span class="theme-name">${item.name}</span>
                  </button>`,
             ).join("")}
           </div>`,
        )}
        <div class="divider"></div>
        ${rowMarkup(
          "主题色",
          "三个都取自手机端色板，不另造颜色",
          `<div class="swatches" role="radiogroup" aria-label="主题色">
             ${ACCENTS.map(
               (item) =>
                 `<button class="swatch" type="button" data-accent-choice="${item.id}"
                    style="background:${item.chip}" title="${item.name}" aria-label="${item.name}"
                    aria-checked="${accent === item.id}"></button>`,
             ).join("")}
           </div>`,
        )}
        <div class="divider"></div>
        ${rowMarkup(
          "字体",
          "全站默认 + 聊天 / 设置 / 其他界面分别覆盖；字号按区域缩放，改完即时生效。",
          `<button class="ghost" type="button" id="font-open">修改</button>`,
        )}
      </div>`,
    );

    // 主题色板：点击即切 + 持久化，无需确认；当前项由 syncThemeControls 描边
    for (const button of el.settingsInner.querySelectorAll("[data-theme-choice]")) {
      button.addEventListener("click", () => setThemeChoice(button.dataset.themeChoice));
    }
    for (const button of el.settingsInner.querySelectorAll("[data-accent-choice]")) {
      button.addEventListener("click", () => setAccent(button.dataset.accentChoice));
    }
    document.getElementById("font-open")?.addEventListener("click", openFontModal);
  } else if (page === "chats") {
    const sendKey = localStorage.getItem(KEY_SEND) || "enter";
    const showActs = localStorage.getItem(KEY_ACTS) !== "0";
    el.settingsInner.innerHTML = `${sectionMarkup(
      "会话",
      `<div class="card">
        ${rowMarkup(
          "搜索旧对话",
          "标题和原文一起搜，覆盖全部会话（含任务专线与已归档的）。搜索是独立一页，点右边进去",
          `<button class="ghost" type="button" id="open-search">打开搜索</button>`,
        )}
        <div class="divider"></div>
        ${rowMarkup(
          "回车发送",
          "开启后回车直接发送；关掉则回车换行、Ctrl+Enter 发送",
          switchMarkup(sendKey === "enter", {
            label: "回车发送",
            attrs: 'data-send-key-switch',
          }),
        )}
        <div class="divider"></div>
        ${rowMarkup(
          "工具活动",
          "关掉就只看回答，不看「读了哪个文件、跑了什么命令」",
          switchMarkup(showActs, { label: "显示工具活动", attrs: 'data-acts-switch' }),
        )}
        ${
          // 入口常驻：N=0 时也让主人知道归档收在哪（方案 §2：会话页只保留入口）
          `<div class="divider"></div>
           ${rowMarkup(
             "归档的会话",
             // 只留计数：解释性文字不常驻（界面文案密度口径）
             state.archived > 0 ? `${state.archived} 个` : "",
             `<button class="ghost" type="button" id="open-archive">打开归档</button>`,
             { inlineHint: true },
           )}`
        }
        <div class="divider"></div>
        ${rowMarkup(
          "导出数据",
          "勾选要带哪几块，打成 zip 压缩包；每块是独立目录，包根上有 README 与清单（不含密钥）",
          `<button class="ghost" type="button" id="settings-export-all">导出…</button>`,
        )}
      </div>`,
    )}
    ${sectionMarkup(
      "自动归档",
      `<div class="card">
        ${rowMarkup(
          "自动归档旧会话",
          "",
          switchMarkup(false, { label: "自动归档", attrs: "data-archive-auto-switch" }),
        )}
        <div class="divider"></div>
        ${rowMarkup(
          "保留天数",
          "",
          `<input class="set-input archive-days" id="archive-auto-days" type="number" min="1" max="365"
                  value="30" aria-label="自动归档保留天数" />`,
        )}
        <div class="divider"></div>
        <div class="row" id="archive-auto-hint-row" hidden><div class="row-main"><div class="row-hint" id="archive-auto-hint"></div></div></div>
      </div>`,
    )}
    ${sectionMarkup(
      "权限",
      `<div class="card">
        ${rowMarkup(
          "Agent 权限",
          "决定它能替你动到什么程度：完全访问 = 能改文件、能跑命令。改完立刻生效。",
          `<div class="segmented slide" role="radiogroup" aria-label="权限" id="policy-switch">
             <button type="button" data-policy="full" aria-checked="false">完全访问</button>
             <button type="button" data-policy="read-only" aria-checked="false">只读</button>
             <button type="button" data-policy="no-shell" aria-checked="false">不跑命令</button>
           </div>`,
        )}
        <div class="divider"></div>
        ${rowMarkup(
          "审批档",
          "全部问我 = 改文件 / 跑命令 / 派活前都问一句；只问重要的 = 只拦命令执行、派活等会起执行的动作；全不问 = 直接做。审批会直接弹在界面右下角，不用来这里找。",
          `<div class="segmented slide" role="radiogroup" aria-label="审批档" id="policy-approval-level">
             <button type="button" data-approval="ask-all" aria-checked="false">全部问我</button>
             <button type="button" data-approval="ask-critical" aria-checked="false">只问重要的</button>
             <button type="button" data-approval="none" aria-checked="false">全不问</button>
           </div>`,
        )}
      </div>`,
    )}`;

    document.getElementById("open-search")?.addEventListener("click", () => go("search"));
    const sendSwitch = el.settingsInner.querySelector("[data-send-key-switch]");
    sendSwitch?.addEventListener("click", () => {
      const next = sendSwitch.getAttribute("aria-checked") !== "true";
      sendSwitch.setAttribute("aria-checked", String(next));
      localStorage.setItem(KEY_SEND, next ? "enter" : "mod-enter");
    });
    const actsSwitch = el.settingsInner.querySelector("[data-acts-switch]");
    actsSwitch?.addEventListener("click", () => {
      const next = actsSwitch.getAttribute("aria-checked") !== "true";
      actsSwitch.setAttribute("aria-checked", String(next));
      localStorage.setItem(KEY_ACTS, next ? "1" : "0");
      applyActPref();
    });
    document.getElementById("open-archive")?.addEventListener("click", () => go("settings", "archive"));
    document
      .getElementById("settings-export-all")
      ?.addEventListener("click", () => openExportModal());
    // 自动归档区（2026-11-13 对齐 ZCode §3）：开关走 toggleFlag（flags 卡同款），
    // 天数是数字输入，单独走 saveAutoArchiveDays（失败回显旧值）。
    const autoSwitch = el.settingsInner.querySelector("[data-archive-auto-switch]");
    autoSwitch?.addEventListener("click", () => {
      const next = autoSwitch.getAttribute("aria-checked") !== "true";
      void toggleFlag("ARCHIVE_AUTO_ENABLED", next, autoSwitch);
    });
    document
      .getElementById("archive-auto-days")
      ?.addEventListener("change", (event) => {
        const input = event.currentTarget;
        if (input instanceof HTMLInputElement) void saveAutoArchiveDays(input);
      });
    void loadAutoArchiveSettings();
    void loadPolicy();
    void refreshApprovalPopups();
  } else if (page === "projects") {
    // 2026-11-12 重做：工作区根与项目目录平级（ZCode 多根语义），同一种行、路径可改；
    // 项目动作只有「改名 / 归档」（归档是软退场，归档页可恢复），不再有「移除/删除」说法。
    el.settingsInner.innerHTML = `${sectionMarkup(
      "项目",
      `<div class="card">
        <div class="set-card-body">
          <div class="set-card-head">
            <div class="row-main">
              <div class="set-card-title" data-tip="工作区根是默认目录；项目和它平级，可以放在任意位置。所有已登记目录助手都能读写。">工作区与项目</div>
            </div>
            <button class="btn-primary" type="button" id="project-add">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
              添加项目
            </button>
          </div>
          <div class="proj-list" id="project-list">
            <div class="set-hint">读取中…</div>
          </div>
        </div>
      </div>`,
    )}
    ${sectionMarkup(
      "待确认的请求",
      `<div class="card">
        <div class="set-card-body" id="proposal-list">
          <div class="set-hint">读取中…</div>
        </div>
      </div>`,
    )}`;
    document.getElementById("project-add")?.addEventListener("click", () => openAddProjectModal());
    void loadProjectsSettings();
  } else if (page === "archive") {
    // 2026-11-12 归档模块：会话与项目目录两类软对象收在一页。
    // 2026-11-13 对齐 ZCode（方案 §1）：会话卡重做成「归档管理」形态——
    // 按项目分组折叠卡 + 组级恢复 + 排序/项目筛选 + 50 条递增；
    // 行内动作 = 恢复 + 永久删除（弹窗确认）。页级「全部恢复」退役（组级恢复取代之）。
    el.settingsInner.innerHTML = `${sectionMarkup(
      `已归档的会话<span class="archive-count" id="archive-chat-count"></span>`,
      `<div class="card">
        <div class="set-card-body">
          <div class="archive-card-head">
            <div class="archive-filter">
              <svg class="archive-filter-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
              <input class="set-input" id="archive-filter" type="search" spellcheck="false"
                     placeholder="搜索标题或首句" aria-label="筛选已归档的会话" />
            </div>
            <select class="set-input archive-select" id="archive-sort" aria-label="排序方式">
              <option value="archived">按归档时间</option>
              <option value="last">按最后活跃</option>
            </select>
            <select class="set-input archive-select" id="archive-project" aria-label="按项目筛选">
              <option value="">全部项目</option>
            </select>
          </div>
          <div class="archive-list" id="archive-chat-list">
            <div class="set-hint">读取中…</div>
          </div>
        </div>
      </div>`,
    )}
    ${sectionMarkup(
      `<span title="归档只把项目从列表和派活选择里收起；磁盘上的目录和文件一直没动">已归档的项目目录</span><span class="archive-count" id="archive-project-count"></span>`,
      `<div class="card">
        <div class="set-card-body">
          <div class="proj-list" id="archive-project-list">
            <div class="set-hint">读取中…</div>
          </div>
        </div>
      </div>`,
      `id="archive-project-section" hidden`,
    )}`;

    document
      .getElementById("archive-filter")
      ?.addEventListener("input", () => renderArchiveChats());
    document
      .getElementById("archive-sort")
      ?.addEventListener("change", () => renderArchiveChats());
    document
      .getElementById("archive-project")
      ?.addEventListener("change", () => renderArchiveChats());
    void loadArchivePage();
  } else if (page === "reminders") {
    // 2026-11-12 重做：这一页的主路径是「跟 Agent 说一句」，不是填表单——和 ZCode 一样，
    // 定提醒这件事交给会说话的那一方。手动指定时间收进弹窗（自绘日历 + 时段），
    // 原生 datetime-local 在中文界面里显示 MM/DD/YY，已退役。
    el.settingsInner.innerHTML = `${sectionMarkup(
      "提醒",
      `<div class="card rm-hero">
        <div class="rm-hero-body">
          <div class="rm-hero-title" data-tip="说清什么时候、它到时候说什么。到点执事会来找你；右边的日历可以手动定时间。">让执事到点来找你</div>
          <div class="rm-say">
            <input class="set-input rm-say-input" id="reminder-say" type="text" maxlength="200"
                   placeholder="例如：明天早上九点提醒我交房租" aria-label="想提醒什么" />
            <button class="rm-icon-btn" type="button" id="reminder-manual"
                    title="手动指定时间" aria-label="手动指定时间">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/></svg>
            </button>
            <button class="btn-primary rm-say-go" type="button" id="reminder-say-go">交给 Agent</button>
          </div>
        </div>
      </div>`,
    )}
    ${sectionMarkup(
      "待触发",
      `<div class="card" id="reminder-card">
        <div class="row"><div class="row-main"><div class="row-hint">读取中…</div></div></div>
      </div>`,
    )}`;
    const say = document.getElementById("reminder-say");
    const sendToAgent = () => {
      // 空着点也行：给一句模板，主人在输入框里补完再发
      const text = say.value.trim() || "明天早上九点提醒我";
      openChiefChat();
      el.input.value = `帮我定个提醒：${text}`;
      resize();
      el.input.focus();
      toast("已填进输入框——看过没问题就发送");
    };
    document.getElementById("reminder-say-go")?.addEventListener("click", sendToAgent);
    say?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); sendToAgent(); }
    });
    document.getElementById("reminder-manual")?.addEventListener("click", openReminderModal);
    void loadReminders();
  } else if (page === "connect") {
    // 连接页（2026-11-13 重排）：先链路、再两条路（同一个 WiFi / 中继）、最后设备。
    // 解释性长句全部收进 tooltip / 教程，行内只留短状态。
    el.settingsInner.innerHTML = `${sectionMarkup(
      "连接状态",
      `<div class="card">
        <div class="conn-chain">
          <div class="conn-node"><span class="conn-k">这台电脑</span><span class="conn-v"><i class="status-dot ok"></i>在线</span></div>
          <span class="conn-link"></span>
          <div class="conn-node"><span class="conn-k">中继（VPS）</span><span class="conn-v" id="conn-relay"><i class="status-dot idle"></i>读取中</span></div>
          <span class="conn-link"></span>
          <div class="conn-node"><span class="conn-k">手机</span><span class="conn-v" id="conn-phones">—</span></div>
        </div>
        <div class="conn-hint" id="conn-hint"></div>
      </div>`,
    )}
    ${sectionMarkup(
      "同一个 WiFi",
      `<div class="card pair">
        <div class="pair-info">
          <div class="row-label" data-tip="手机 App 扫这个码，换一个长期有效的设备凭据——不用把 AGENT_TOKEN 抄到手机上。">扫码连接手机</div>
          <div class="pair-meta" id="pair-meta">正在取配对码…</div>
          <button class="ghost" id="pair-refresh" type="button">换一个码</button>
        </div>
        <img class="pair-qr" id="pair-qr" alt="配对二维码" hidden />
      </div>`,
    )}
    ${sectionMarkup(
      "不在同一个 WiFi",
      `<div class="card">
        <div class="row">
          <div class="row-main">
            <div class="row-label" data-tip="经中继出一枚一次性加入码；手机 App 扫码即加入，不同网络、用流量都能连。">经中继添加设备</div>
            <div class="row-hint" id="relay-method-state">读取中…</div>
          </div>
          <div class="row-control"><button class="btn-primary" type="button" id="relay-add-device">添加设备</button></div>
        </div>
        <div class="conn-howto" id="conn-howto" hidden>
          <div class="howto-step"><span class="n">1</span><span>先在一台 VPS 上部署好中继（一次性；命令见仓库 <code>ts/apps/relay/README.md</code>）</span></div>
          <div class="howto-step"><span class="n">2</span><span>在 .env 填 <code>RELAY_URL</code> 和中继签发的 <code>RELAY_TOKEN</code>，开 <code>RELAY_ENABLED=1</code></span></div>
          <div class="howto-step"><span class="n">3</span><span>重启服务；上面变成「已连上」后就能加设备</span></div>
        </div>
      </div>`,
    )}
    ${sectionMarkup(
      "已连接的设备",
      `<div class="card" id="device-card"></div>`,
    )}`;
    document.getElementById("pair-refresh").addEventListener("click", () => void loadPair());
    document.getElementById("relay-add-device").addEventListener("click", () => openAddDeviceModal());
    void loadPair();
    void loadRelayStatus();
    void loadDevices();
    // 配对码是限时的，停在这一页太久就自己换一张，别让人扫到过期码
    clearInterval(pairTimer);
    pairTimer = setInterval(() => {
      if (currentRoute() === "settings" && currentSettingsPage() === "connect" && el.gate.hidden) {
        void loadPair();
      }
    }, 100000);
  } else if (page === "service") {
    // 服务页（2026-11-09 拆分后；2026-11-13 二次瘦身）：只留服务状态与开关——通知 / 鉴权 / 运行时 / 高级开关。
    // 2026-11-13 退役的两行：地址（连接页的链路图已经说清，这里只是 location.origin 的复读）、
    // 累计 token（整块搬去「用量」页——累计、按模型占比、明细三件事，一行标签装不下）。
    const notifyOn = localStorage.getItem(KEY_NOTIFY) === "1";
    el.settingsInner.innerHTML = `${sectionMarkup(
      "服务",
      `<div class="card">
        <div class="row">
          <div class="row-main">
            <div class="row-label">桌面通知</div>
            <div class="row-hint">回复完成 / 出错 / 任务单待你处理时提醒；窗口正看着那个会话就不打扰</div>
            <div class="row-hint" id="svc-notify-hint" hidden></div>
          </div>
          <div class="row-control">
            ${switchMarkup(notifyOn, { label: "桌面通知", attrs: 'data-notify-switch' })}
          </div>
        </div>
        <div class="divider"></div>
        ${rowMarkup(
          "鉴权",
          // 悬停挂在「鉴权」两个字上：这一行的状态（本机无需配置）本身不需要解释，
          // 用户真正要问的是"那手机怎么连"——扫码配对走的就是同一套凭据。
          "扫码配对用的就是这一项：手机 App 扫配对码换一枚设备凭据，不用把令牌抄进手机；本机浏览器直接从这台电脑打开，也不需要令牌。",
          `<span class="kv" id="svc-auth">…</span>`,
        )}
      </div>`,
    )}
    ${sectionMarkup(
      "运行时",
      `<div class="card" id="runtime-card">
        ${rowMarkup(
          "Node 服务",
          "桌面壳拉起来的那个进程。停掉之后手机连接、提醒、例行任务都会断；历史不会丢，启动即可恢复。",
          `<div class="runtime-actions">
             <span class="kv" id="runtime-state">读取中…</span>
             <button class="btn-primary" type="button" id="runtime-start" hidden>启动</button>
             <button class="ghost" type="button" id="runtime-restart" hidden>重启</button>
             <button class="ghost is-danger" type="button" id="runtime-stop" hidden>停止</button>
           </div>`,
        )}
        <div class="divider" id="autostart-divider" hidden></div>
        <div class="row" id="autostart-row" hidden>
          <div class="row-main">
            <div class="row-label" data-tip="登录 Windows 时自动启动 Selenite；服务仍由壳拉起，和这里的起停互不影响。">开机自启</div>
          </div>
          <div class="row-control">
            ${switchMarkup(false, { label: "开机自启", attrs: "data-autostart-switch" })}
          </div>
        </div>
      </div>`,
    )}
    ${sectionMarkup(
      "高级开关",
      `<div class="card" id="flags-card">
        <div class="row"><div class="row-main"><div class="row-hint">读取中…</div></div></div>
      </div>`,
    )}`;
    // 供应商与默认模型已拆到「模型」页（2026-11-09）：服务页只留服务自身的状态与开关。
    // 通知开关（批次二）：开的时候才请求系统权限；被拒就退回关闭并提示
    const notifySwitch = el.settingsInner.querySelector("[data-notify-switch]");
    notifySwitch?.addEventListener("click", async () => {
      const want = notifySwitch.getAttribute("aria-checked") !== "true";
      if (!want) {
        localStorage.setItem(KEY_NOTIFY, "0");
        notifySwitch.setAttribute("aria-checked", "false");
        return;
      }
      if (!("Notification" in window)) {
        const hint = document.getElementById("svc-notify-hint");
        if (hint) { hint.hidden = false; hint.textContent = "这个环境不支持通知"; }
        return;
      }
      if (Notification.permission !== "granted") {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") {
          const hint = document.getElementById("svc-notify-hint");
          if (hint) { hint.hidden = false; hint.textContent = "通知权限被拒了，去系统设置里开"; }
          notifySwitch.setAttribute("aria-checked", "false");
          return;
        }
      }
      localStorage.setItem(KEY_NOTIFY, "1");
      notifySwitch.setAttribute("aria-checked", "true");
    });
    void loadServiceInfo();
    void initRuntimeCard();
    // 高级开关（2026-11-09）：读一次渲染行
    void loadFlagsSettings();
  } else if (page === "usage") {
    // 用量页（2026-11-13 从服务页拆出）：累计 / 按模型 / 明细 三张卡，一份数据三个视角。
    // 版式：累计卡照 ZCode settings/usage-stats 的 lifetime strip（一格一数、发丝竖分隔、数字 tabular）；
    // 按模型与明细照 Cindy UsageBreakdownTables（色点对图例、占比格带小条、表格右对齐）。
    // 数据只有 GET /api/v1/agent/usage 一份：durable 的 pi.usage 按会话相加。
    // 刻意不做：金额（服务端 cost 固定 0，不假装知道价格）、按天曲线（pi.usage 只有累计，没有逐日流水）。
    el.settingsInner.innerHTML = `${sectionMarkup(
      "累计用量",
      `<div class="card use-hero" id="use-hero"><div class="use-loading">读取中…</div></div>`,
      "",
      `<button class="ghost" type="button" id="use-refresh">刷新</button>`,
    )}
    ${sectionMarkup(
      "按模型",
      `<div class="card use-models" id="use-models"><div class="use-loading">读取中…</div></div>`,
    )}
    ${sectionMarkup(
      "明细",
      `<div class="card use-detail" id="use-detail"><div class="use-loading">读取中…</div></div>`,
    )}`;
    document.getElementById("use-refresh")?.addEventListener("click", () => void loadUsagePage());
    void loadUsagePage();
  } else if (page === "models") {
    // 模型页（2026-11-09 从服务页拆出）：默认模型行 + 供应商双栏。
    // 拆的理由：这两块是"配上游"，跟服务状态（地址/通知/运行时）不是一个话题；
    // 服务页那时候已经四节起步，模型再挤在第一节里，找东西要滚三屏。
    // 元素 id 从 svc-model-* 改名 mdl-*：整块都搬走了，id 留着 svc- 前缀会骗人。
    el.settingsInner.innerHTML = `${sectionMarkup(
      "默认模型",
      // 2026-11-12 M1：从「一行标签 + 原生下拉」升成一张当前模型卡。
      // 换模型是临时动作，收进「更换」弹层（复用对话 pill 的 model-menu）；
      // 弹层放在卡外面一层，因为 .card 有 overflow:hidden 会把浮层裁掉。
      `<div class="mdl-wrap">
        <div class="card mdl-card">
          <div class="mdl-main">
            <div class="mdl-name" id="mdl-current">…</div>
            <div class="mdl-sub" id="mdl-hint">读取中…</div>
          </div>
          <button class="ghost mdl-change" type="button" id="mdl-change" hidden>更换</button>
        </div>
        <div class="model-menu composer-pop mdl-menu" id="mdl-menu" role="menu" hidden></div>
      </div>`,
    )}
    ${sectionMarkup(
      "供应商",
      `<div class="svc-split">
        <div class="svc-nav" id="provider-list" aria-label="供应商列表">
          <div class="svc-nav-empty">读取中…</div>
        </div>
        <div class="svc-detail" id="provider-detail">
          <div class="svc-detail-empty"><div class="set-hint">读取中…</div></div>
        </div>
      </div>`,
      "",
      `<button class="btn-primary" type="button" id="provider-add">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
        新建供应商
      </button>`,
    )}
    ${sectionMarkup(
      "搜索",
      `<div class="card" id="search-sources-card">
        <div class="src-head">
          <div class="row-main">
            <div class="set-card-title" data-tip="模型不能上网时，按列表顺序找搜索源；第一个有结果的生效。">搜索源</div>
          </div>
          <button class="btn-primary" type="button" id="search-source-add">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
            添加搜索源
          </button>
        </div>
        <div class="src-list" id="search-source-list">
          <div class="src-empty set-hint">读取中…</div>
        </div>
        <div class="src-foot set-hint" id="search-source-hint" hidden></div>
      </div>`,
    )}`;
    // 供应商双栏每次进页重置到"当前默认供应商"；模板/表单状态由 renderProviderDetail 接手
    state.providerView = { mode: "empty", providerId: "" };
    document.getElementById("provider-add")?.addEventListener("click", () => showProviderTemplates());
    document.getElementById("search-source-add")?.addEventListener("click", () => openAddSearchSourceModal());
    // 弹层里选完模型：chooseModel 会派 modelchange（冒泡）。这里收起弹层并把
    // 当前模型卡的三行按新投影重填；updateModelPill 由 chooseModel 自己负责。
    document.getElementById("mdl-menu")?.addEventListener("modelchange", (event) => {
      const menu = event.currentTarget;
      closePopover(menu, document.getElementById("mdl-change"));
      renderDefaultModelRow(state.modelCatalog);
    });
    // 弹层里的点击不再冒到 document：切供应商分段会就地重渲染，被点的按钮随即从 DOM 摘下，
    // 冒到 document 时 event.target 已是游离节点，closest(".mdl-wrap") 找不到祖先，
    // 会被"点外收起"误判成点了外面（真机实测：点分段弹层直接关掉）。
    document.getElementById("mdl-menu")?.addEventListener("click", (event) => {
      event.stopPropagation();
    });
    void loadModelsInfo();
  } else if (page === "memory") {
    // 2026-11-13 A 版：MEMORY_PAGE_A=false 整套退回旧页（旧 DOM / 旧逻辑都还在）。
    const pageA = await ensureFlag("MEMORY_PAGE_A", true);
    if (currentSettingsPage() !== "memory") return;
    el.settingsInner.innerHTML = pageA ? memorySettingsMarkup() : memorySettingsMarkupLegacy();
    if (pageA) void wireMemorySettings();
    else void wireMemorySettingsLegacy();
  } else if (page === "partners") {
    el.settingsInner.innerHTML = sectionMarkup(
      "人设",
      `<div class="pt-head">
        <div class="row-main">
          <div class="set-card-title" data-tip="头像和「它是谁」一起改：点「改人设」进弹窗，左边换头像、右边写正文，一次保存。模型候选链与例行任务也在里面。">总管与执事</div>
        </div>
        <button class="btn-primary" type="button" id="partner-add">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
          新建执事
        </button>
      </div>
      <div class="pt-list" id="partner-list">
        <div class="set-hint">读取中…</div>
      </div>`,
    );
    document.getElementById("partner-add")?.addEventListener("click", () => openCreatePartnerModal());
    void loadPartners();
  } else if (page === "skills") {
    el.settingsInner.innerHTML = `${sectionMarkup(
      "技能",
      `<div class="sk-head">
        <div class="row-main">
          <div class="set-card-title" data-tip="技能 = 给 AI 的操作手册（第 1 行是索引摘要，其余是正文）。默认全关：开了才进 agent 的技能索引；对话里输入 /技能名 直接调用。开关对已在跑的会话不生效，下一个会话开始。">技能库</div>
          <div class="sk-path" id="skill-path">读取中…</div>
        </div>
        <div class="sk-head-actions">
          <button class="ghost" type="button" id="skill-advice-run" title="跳到总管对话并填好评估提示词：你看过点发送，总管逐条评估后把结果存回快照（用你当前选的模型，不换模型）">让 Agent 评估</button>
          <button class="btn-primary" type="button" id="skill-add">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
            新建技能
          </button>
        </div>
      </div>
      <div class="sk-advice-banner" id="skill-advice-banner" hidden></div>
      <div class="sk-toolbar" id="skill-toolbar">
        <div class="sk-select" id="skill-filter" hidden></div>
        <div class="sk-select" id="skill-sort"></div>
        <span class="sk-toolbar-spacer"></span>
        <button class="ghost sk-bulk" type="button" id="skill-bulk" title="批量开启 / 关闭全部技能（需要确认）">全部开启</button>
      </div>
      <div class="sk-list" id="skill-list">
        <div class="set-hint">读取中…</div>
      </div>`,
    )}`;
    document.getElementById("skill-add")?.addEventListener("click", () => openCreateSkillChoiceModal());
    document.getElementById("skill-bulk")?.addEventListener("click", () => openBulkSkillModal());
    document
      .getElementById("skill-advice-run")
      ?.addEventListener("click", () => void runSkillAdvice());
    // 建议按钮在 banner 里动态重建：监听挂在容器上，一次就够
    document.getElementById("skill-advice-banner")?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-skill-apply]");
      if (button) applySkillAdvice();
    });
    void loadSkills();
  } else {
    el.settingsInner.innerHTML = sectionMarkup(
      "关于",
      `<div class="card">
        ${rowMarkup("Selenite", "一个人用的 Agent。记录是重点场景，但不是边界。", `<span class="kv">0.1.0</span>`)}
        <div class="divider"></div>
        ${rowMarkup("界面", "与手机端同一套配色；改完刷新就生效，没有构建步骤。", `<span class="kv">web/</span>`)}
      </div>`,
    );
  }

  replayPageEnter();
}

export { pairTimer, renderSettings };
