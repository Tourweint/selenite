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
import { renderPartnerProfilePage } from "./partner-profile.js";
import { renderWorkerProfilePage } from "./worker-profile.js";
import { openChiefChat } from "./partners-status.js";
import { resize } from "./plus-menu.js";
import { openAddProjectModal } from "./project-modal.js";
import { showProviderTemplates } from "./providers.js";
import { currentAgentTab, currentPartnerProfileId, currentRoute, currentSettingsPage, go } from "./route.js";
import { openAddSearchSourceModal } from "./search-sources.js";
import { wireDragScroll } from "./scroll-x.js";
import { mountSegmented, replayPageEnter, rowMarkup, sectionMarkup, switchMarkup, syncSegmented } from "./settings-atoms.js";
import { ACCENTS, AGENT_TABS, agentTabsMarkup, renderSettingsNav } from "./settings-base.js";
import { compactionSectionMarkup, wireCompactionSection } from "./settings-compaction.js";
import { contextSettingsMarkup, wireContextSettings } from "./settings-context.js";
import { toolPoolMarkup, wireToolPool } from "./settings-tools.js";
import { initRuntimeCard, loadRelayStatus, loadServiceInfo, openAddPhoneModal, openRelayLinkModal, paintConnStar, unlinkRelay } from "./settings-connection.js";
import { executorSectionMarkup, wireExecutorSettings } from "./settings-executor.js";
import { memorySettingsMarkupLegacy, wireMemorySettingsLegacy } from "./settings-memory.js";
import { loadProjectsSettings } from "./settings-projects.js";
import { loadPolicy, loadReminders, openScheduledTaskModal, renderDefaultModelRow } from "./settings-reminders.js";
import { loadAutoArchiveSettings, loadFlagsSettings, saveAutoArchiveDays, toggleFlag } from "./settings-switches.js";
import { loadModelsInfo, loadUsagePage } from "./settings-usage.js";
import { openBulkSkillModal, openCreateSkillChoiceModal } from "./skills-actions.js";
import { applySkillAdvice, loadSkills, runSkillAdvice } from "./skills-settings.js";
import { state } from "./state.js";
import { ensureFlag } from "./tasks-redesign.js";
import { KEY_ACCENT, KEY_ACCENT_CUSTOM, KEY_SEND, THEMES, currentThemeChoice, openFontModal, setAccent, setThemeChoice, storedAccent } from "./theme.js";
import { closePopover, toast } from "./ui-atoms.js";
import { chooseDetailMode, getDetailMode } from "./tool-chips.js";

/** 连接页的中继状态轮询（2026-11-14）：10s 一次，离开这一页就不刷。 */
let connPollTimer = 0;

/**
 * Agent 分区顶部 tab 的接线（2026-11-17）。
 * 点击切到该 tab 保留的旧子路由；切页本身由 applyRoute → renderSettings 接手，
 * 所以这里不直接重画（同一 hash 再点也由 go 早退）。
 */
function wireAgentTabs() {
  for (const button of el.settingsInner.querySelectorAll("[data-agent-tab]")) {
    const tab = AGENT_TABS.find((item) => item.id === button.dataset.agentTab);
    if (!tab) continue;
    button.addEventListener("click", () => go("settings", tab.route));
  }
}

async function renderSettings() {
  const page = currentSettingsPage();
  // 记忆页整理轮询：一离开设置页就停；回来由 wireMemorySettings 重新按服务端状态接上。
  stopMemoryPolling();
  // 人设二级页会自己收窄内容列；换到别的分区必须摘掉这个标记（同一个 #settings-inner 实例）
  el.settingsInner.classList.remove("is-partner-profile");
  renderSettingsNav(page);
  el.settingsInner.setAttribute("role", "tabpanel");
  el.settingsInner.setAttribute("aria-labelledby", `settings-tab-${page}`);

  if (page === "appearance") {
    const choice = currentThemeChoice();
    const accent = storedAccent();
    const accentName =
      accent === "custom"
        ? (localStorage.getItem(KEY_ACCENT_CUSTOM) || "").toUpperCase()
        : ACCENTS.find((item) => item.id === accent)?.name || ACCENTS[0].name;
    const customHex = localStorage.getItem(KEY_ACCENT_CUSTOM) || "#3e4a8c";
    el.settingsInner.innerHTML = sectionMarkup(
      "外观",
      `<div class="card">
        <div class="row">
          <div class="row-main">
            <div class="row-label" title="四套成品配色，各带一套浅/深；点哪套就固定下来（不再跟随系统）">主题</div>
          </div>
        </div>
        <div class="theme-cards" role="radiogroup" aria-label="主题">
          ${THEMES.map(
            (item) =>
              `<button class="theme-card" type="button" role="radio"
                 data-theme-choice="${item.id}" aria-checked="${choice === item.id}"
                 title="${item.name}" aria-label="${item.name}"
                 style="--tc-bg:${item.bg};--tc-side:${item.side};--tc-card:${item.card};--tc-card-high:${item.cardHigh};--tc-outline:${item.outline};--tc-divider:${item.divider};--tc-text:${item.text};--tc-text3:${item.text3};--tc-accent:${item.accent}">
                 <span class="theme-pv" aria-hidden="true">
                   <span class="theme-pv-side"><i></i><i></i><i></i></span>
                   <span class="theme-pv-main"><i class="pv-a"></i><i class="pv-b"></i></span>
                   <span class="theme-pv-dot"></span>
                 </span>
                 <span class="theme-cap"><b>${item.name}</b><em>${item.tag}</em></span>
                 <span class="theme-card-check" aria-hidden="true">✓</span>
               </button>`,
          ).join("")}
        </div>
        <div class="divider"></div>
        ${rowMarkup(
          "主题色",
          "十档预设 + 自定义取色；只给链接、运行中、选中态上色，界面底色仍归主题管",
          `<div class="accent-row">
             <div class="swatches" role="radiogroup" aria-label="主题色">
               ${ACCENTS.map(
                 (item) =>
                   `<button class="swatch" type="button" data-accent-choice="${item.id}"
                      style="background:${item.chip}" title="${item.name}" aria-label="${item.name}"
                      aria-checked="${accent === item.id}"></button>`,
               ).join("")}
               <button class="swatch swatch-pick" type="button" data-accent-pick
                       title="自定义取色" aria-label="自定义取色"
                       aria-checked="${accent === "custom"}"><i style="background:${customHex}"></i></button>
               <input type="color" class="accent-picker" data-accent-color value="${customHex}" aria-label="自定义主题色" />
             </div>
             <span class="accent-name" data-accent-name>${accentName}</span>
           </div>`,
        )}
        <div class="divider"></div>
        ${rowMarkup(
          "字体",
          "全站默认 + 聊天 / 设置 / 其他界面分别覆盖；字号按区域缩放，改完即时生效。",
          `<button class="ghost" type="button" id="font-open">修改</button>`,
        )}
        <div class="divider"></div>
        ${rowMarkup(
          "工具详情",
          "点对话里的工具小块时，细节在原地展开还是在旁边弹小窗",
          `<div class="segmented slide" role="radiogroup" aria-label="工具详情">
             <button type="button" data-tool-detail="inline" aria-checked="${getDetailMode() === "inline"}">原地展开</button>
             <button type="button" data-tool-detail="popover" aria-checked="${getDetailMode() === "popover"}">附近小窗</button>
           </div>`,
        )}
      </div>`,
    );

    // 主题色板：点击即切 + 持久化，无需确认；当前项由 syncThemeControls 描边
    for (const button of el.settingsInner.querySelectorAll("[data-theme-choice]")) {
      button.addEventListener("click", () => setThemeChoice(button.dataset.themeChoice));
    }
    // 五张主题卡一排横滚（2026-11-15）：窄了没有条子，滚轮/按住拖拽补位
    wireDragScroll(el.settingsInner.querySelector(".theme-cards"));
    for (const button of el.settingsInner.querySelectorAll("[data-accent-choice]")) {
      button.addEventListener("click", () => {
        setAccent(button.dataset.accentChoice);
        // 右边那个名字跟着换（syncThemeControls 只管描边）
        const name = ACCENTS.find((item) => item.id === button.dataset.accentChoice)?.name;
        const label = el.settingsInner.querySelector("[data-accent-name]");
        if (name && label) label.textContent = name;
      });
    }
    // 自定义取色：点那个彩色圈开系统色盘，选完即落
    const pickButton = el.settingsInner.querySelector("[data-accent-pick]");
    const picker = el.settingsInner.querySelector("[data-accent-color]");
    pickButton?.addEventListener("click", () => picker?.click());
    picker?.addEventListener("input", () => {
      setAccent("custom", picker.value);
      const chip = pickButton?.querySelector("i");
      if (chip) chip.style.background = picker.value;
      const label = el.settingsInner.querySelector("[data-accent-name]");
      if (label) label.textContent = picker.value.toUpperCase();
    });
    document.getElementById("font-open")?.addEventListener("click", openFontModal);
    // 工具详情：两档分段，点哪档就落哪档（localStorage，改完下一次点块即生效）
    const detailBox = el.settingsInner.querySelector("[data-tool-detail]")?.closest(".segmented");
    if (detailBox) {
      for (const button of detailBox.querySelectorAll("[data-tool-detail]")) {
        button.addEventListener("click", () => {
          const value = chooseDetailMode(button.dataset.toolDetail);
          for (const other of detailBox.querySelectorAll("[data-tool-detail]")) {
            other.setAttribute("aria-checked", String(other.dataset.toolDetail === value));
          }
          syncSegmented(detailBox);
        });
      }
      mountSegmented(detailBox);
    }
  } else if (page === "chats") {
    // 2026-11-18 归档并入本页（用户口径：设置分区太多）：上半是行为设置，
    // 底部「自动归档 → 已归档的会话 → 已归档的项目目录」收成一个归档组。
    // 旧路由 #/settings/archive 由 SETTINGS_ALIASES 别名到 chats，老书签不空页。
    const sendKey = localStorage.getItem(KEY_SEND) || "enter";
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
          "导出数据",
          "勾选要带哪几块，打成 zip 压缩包；每块是独立目录，包根上有 README 与清单（不含密钥）",
          `<button class="ghost" type="button" id="settings-export-all">导出…</button>`,
        )}
      </div>`,
    )}
    ${sectionMarkup(
      "权限",
      `<div class="card">
        ${rowMarkup(
          "Agent 权限",
          "决定它能替你动到什么程度。只读 = 能看能查（ls / cat / grep 这类查看命令），不改文件；在工作区内修改 = 文件只改工作区和项目里的，命令也只限查看；完全访问 = 能改文件、能跑任何命令。改完立刻生效。",
          // 方向从左到右 = 从最保守到最放开，完全访问恒在右端（2026-11-14）
          `<div class="segmented slide" role="radiogroup" aria-label="权限" id="policy-switch">
             <button type="button" data-policy="read-only" aria-checked="false">只读</button>
             <button type="button" data-policy="no-shell" aria-checked="false">在工作区内修改</button>
             <button type="button" data-policy="full" aria-checked="false">完全访问</button>
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
    )}
    ${compactionSectionMarkup()}
    ${sectionMarkup(
      "自动归档",
      `<div class="card">
        ${rowMarkup(
          "自动归档旧会话",
          "",
          switchMarkup(true, { label: "自动归档", attrs: "data-archive-auto-switch" }),
        )}
        <div class="divider"></div>
        ${rowMarkup(
          "保留天数",
          "多少天没动静算旧（1–365，默认 30）。收两类：普通对话、单已结束的任务专线；总管、执事/群、置顶的、正在跑的一律不动。",
          `<input class="set-input archive-days" id="archive-auto-days" type="number" min="1" max="365"
                  value="30" aria-label="自动归档保留天数" />`,
        )}
        ${
          // 提示行只在有状态/错误时存在；分隔线必须和它同生共死——
          // 早先两者拆开写，空提示时那根 1px 线就贴在卡片底边上，看起来像两根、颜色还被叠深。
          `<div id="archive-auto-hint-wrap" hidden>
             <div class="divider"></div>
             <div class="row"><div class="row-main"><div class="row-hint" id="archive-auto-hint"></div></div></div>
           </div>`
        }
      </div>`,
    )}
    ${sectionMarkup(
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

    document.getElementById("open-search")?.addEventListener("click", () => go("search"));
    const sendSwitch = el.settingsInner.querySelector("[data-send-key-switch]");
    sendSwitch?.addEventListener("click", () => {
      const next = sendSwitch.getAttribute("aria-checked") !== "true";
      sendSwitch.setAttribute("aria-checked", String(next));
      localStorage.setItem(KEY_SEND, next ? "enter" : "mod-enter");
    });
    document
      .getElementById("settings-export-all")
      ?.addEventListener("click", () => openExportModal());
    // 自动归档区（2026-11-13 对齐 ZCode §3）：开关走 toggleFlag（flags 卡同款），
    // 天数是数字输入，单独走 saveAutoArchiveDays（失败回显旧值）。
    const autoSwitch = el.settingsInner.querySelector("[data-archive-auto-switch]");
    autoSwitch?.addEventListener("click", () => {
      const next = autoSwitch.getAttribute("aria-checked") !== "true";
      void toggleFlag("ARCHIVE_AUTO_ENABLED", next, autoSwitch).then(() => loadAutoArchiveSettings());
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
    // 上下文压缩（2026-11-14）：四个旋钮走 flags；改完下一轮生效
    wireCompactionSection(el.settingsInner);
    // 归档管理（2026-11-18 从独立分区并进来）：筛选三件套变化就重画列表
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
  } else if (page === "agent") {
    // Agent 合并分区（2026-11-17 用户口径）：人设 / 上下文 / 工具 / 派活 四页收成一个分区，
    // 左栏只占一行，内容顶部用四分段 tab 切换。
    // 四个旧子路由（partners / context / tools / executor）原样保留为各 tab 的地址：
    // 老书签、抽屉「去编辑这个人」、上下文页里的人设跳转都不用改，tab 由 hash 认。
    const tab = currentAgentTab();
    if (tab === "personas") {
      const profileId = currentPartnerProfileId();
      // 普通助手是全局一份人设，不是执事档案：不请求 /partners/worker。
      if (profileId === "worker") {
        void renderWorkerProfilePage();
        replayPageEnter();
        return;
      }
      // 二级页（#/settings/partners/<id>）是钻进某个人的档案：自带返回键，不挂 tab 条。
      if (profileId) {
        void renderPartnerProfilePage(profileId);
        replayPageEnter();
        return;
      }
      // 标题不再重复 tab 名的「人设」：四张导航卡已经说了这是哪一页，
      // 这里只留内容自己的名字「总管与执事」+ 新建动作（2026-11-18）。
      el.settingsInner.innerHTML = agentTabsMarkup(tab) + sectionMarkup(
        `<span data-tip="一个执事一份档案：点进去改头像、写人设、定岗位、看能力与档案，一页到底。">总管与执事</span>`,
        `<div class="pt-list" id="partner-list">
          <div class="set-hint">读取中…</div>
        </div>`,
        "",
        `<button class="btn-primary" type="button" id="partner-add">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
          新建执事
        </button>`,
      );
      document.getElementById("partner-add")?.addEventListener("click", () => openCreatePartnerModal());
      void loadPartners();
    } else if (tab === "context") {
      // 设置 → Agent → 上下文（2026-11-16）：只读当前会话的固定前缀；会变部分只报数量。
      el.settingsInner.innerHTML = agentTabsMarkup(tab) + contextSettingsMarkup();
      wireContextSettings();
    } else if (tab === "tools") {
      // 设置 → Agent → 工具（2026-11-17）：全局工具池，统一决定每个工具是常驻还是按需。
      // 写的是 .data/tool-pool.json；deferred 是注册期属性，保存后需重启服务生效。
      el.settingsInner.innerHTML = agentTabsMarkup(tab) + toolPoolMarkup();
      wireToolPool();
    } else {
      // 派活（2026-11-16 多 CLI 打手适配）：选任务中心用哪个 CLI + 各 CLI 的模型/权限。
      // 数据走 GET/PUT /api/v1/agent/executor；落 .data/executor.json，下一次派活生效。
      el.settingsInner.innerHTML = agentTabsMarkup(tab) + executorSectionMarkup();
      void wireExecutorSettings();
    }
    wireAgentTabs();
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
          <div id="proposal-list" hidden></div>
          <div class="proj-list" id="project-list">
            <div class="set-hint">读取中…</div>
          </div>
        </div>
      </div>`,
    )}`;
    document.getElementById("project-add")?.addEventListener("click", () => openAddProjectModal());
    void loadProjectsSettings();
  } else if (page === "reminders") {
    // 定时任务页（2026-11-17 重做）：一张清单、一个编辑器、一套友好触发词。
    // 手动新建统一走 /agent/reminders（可见/隐藏只是显示方式，手机本地闹钟继续有效）；
    // Agent 建的高级例行规则也在同一张清单里，内容可改、高级触发只读。
    el.settingsInner.innerHTML = `
      <h2 class="set-sec-title">定时任务</h2>
      <section class="set-sec">
        <div class="card rm-hero">
          <div class="rm-hero-body">
            <div class="rm-hero-title" data-tip="内容是一段可编辑的指令：到点后 TA 会拿它自己起一轮，能查就查、能做就做，然后把结果回在你们的主会话；做不了会回一句。触发消息可以选「像 TA 主动找我」（只看到回复），也可以选「留一条我发的指令」（会话里看得到你写的那段）。&#10;&#10;点一行就能改；暂停、立即跑、历史、删除在右边的 ⋯ 里。">到点让 TA 自己跑一轮</div>
            <div class="rm-hero-actions">
              <button class="ghost" type="button" id="reminder-manual">手动设置</button>
              <button class="btn-primary" type="button" id="reminder-say-go">交给 Agent</button>
            </div>
          </div>
        </div>
        <div class="card" id="reminder-card">
          <div class="row"><div class="row-main"><div class="row-hint">读取中…</div></div></div>
        </div>
      </section>`;
    const sendToAgent = () => {
      // 只给一句开头：时间、频率、内容都由 Agent 在对话里问清楚并调工具，界面不替它猜。
      openChiefChat();
      el.input.value = "帮我定个定时任务（触发消息要可见还是像你主动找我，你先问我）：";
      resize();
      el.input.focus();
      toast("已填好开头——直接发送，剩下的交给 Agent");
    };
    document.getElementById("reminder-say-go")?.addEventListener("click", sendToAgent);
    document.getElementById("reminder-manual")?.addEventListener("click", () => openScheduledTaskModal());
    void loadReminders();
  } else if (page === "connect") {
    // 本机页（2026-11-18 收口）：七节七卡并成三节三卡——用户口径「分得特别碎，块也比较小」。
    // ① 连接：星图（回答"挂没挂上中继"）+ 中继地址 + 扫码（本地）+ 添加手机（远程）。
    //    这四块本来就是同一条操作链（状态 → 接入 → 手机两条路），收进一张卡后不再被三个小标题切碎。
    // ② 已连接的设备：行数会变，单独一节；塞进连接卡会被读成操作流程的一部分。
    // ③ 服务与关于：通知 / 鉴权 / 运行时 / 开机自启 / 版本许可，都是「这台电脑怎么跑」。
    // 旧路由 /service、/about 由 SETTINGS_ALIASES 别名到 connect，老书签不空页。
    const notifyOn = localStorage.getItem(KEY_NOTIFY) === "1";
    el.settingsInner.innerHTML = `${sectionMarkup(
      "连接",
      `<div class="card">
        <div class="conn-star" id="conn-star"></div>
        <div class="conn-hint" id="conn-hint"></div>
        <div class="conn-next" id="conn-next" hidden></div>
        <div class="divider"></div>
        <div class="row">
          <div class="row-main">
            <div class="row-label" data-tip="这台电脑登记到哪：地址是 VPS 的公网地址，主令牌是部署中继时设的 RELAY_OWNER_TOKEN。">中继地址</div>
            <div class="row-hint" id="relay-link-hint">读取中…</div>
          </div>
          <div class="row-control"><button class="btn-primary" type="button" id="relay-link-btn">接入</button></div>
        </div>
        <div class="row" id="relay-unlink-row" hidden>
          <div class="row-main"><div class="row-hint">断开</div></div>
          <div class="row-control"><button class="ghost" type="button" id="relay-unlink-btn" data-tip="断开后手机就连不到这台电脑；重新接入随时可以。">断开</button></div>
        </div>
        <div class="divider"></div>
        <div class="row">
          <div class="row-main">
            <div class="row-label" data-tip="两种方式都是把一台手机挂到这台电脑上：本地 = 同一 WiFi / 数据线 / USB 共享网络，扫码即连、不走中继；远程 = 经中继，人在外面、手机用流量也能连。点开在卡片里选。">添加手机</div>
            <div class="row-hint">本地：同一 WiFi / 数据线 · 远程：经中继</div>
          </div>
          <div class="row-control"><button class="btn-primary" type="button" id="add-phone-btn">添加手机</button></div>
        </div>
      </div>`,
    )}
    ${sectionMarkup(
      "已连接的设备",
      `<div class="card" id="device-card"></div>`,
    )}
    ${sectionMarkup(
      "服务与关于",
      `<div class="card" id="runtime-card">
        <div class="row">
          <div class="row-main">
            <div class="row-label" data-tip="回复完成 / 出错 / 任务单待你处理时提醒；窗口正看着那个会话就不打扰。">桌面通知</div>
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
        <div class="divider"></div>
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
        <div class="divider"></div>
        ${rowMarkup("Selenite", "一个跑在自己机器上的通用 Agent：记日记、读文件、跑命令、派活。数据、记忆和密钥都留在本机；除了你自己配的模型接口，没有云端。MIT 许可，用法与架构见项目 README 和 docs/ 下的文档。", `<span class="kv">0.1.0</span>`)}
      </div>`,
    )}`;
    // 添加手机（2026-11-18 合并）：本地 / 远程收进同一张浮层卡，默认落在本地；
    // 远程面板自己判断中继有没有连上（没连上给「接入中继」，不置灰）。
    document.getElementById("add-phone-btn").addEventListener("click", () => openAddPhoneModal("local"));
    document.getElementById("relay-link-btn").addEventListener("click", () => openRelayLinkModal());
    document.getElementById("relay-unlink-btn").addEventListener("click", () => void unlinkRelay());
    void loadRelayStatus();
    // 星形拓扑的节点来自设备列表（2026-11-14）：先读列表，画完再把星形刷新一次
    void loadDevices().then(() => paintConnStar());
    // 配对码的自动轮换跟着浮层走（2026-11-18）：本地面板开着时每 100 秒换一张，
    // 逻辑在 openAddPhoneModal 里，页面不再需要守着一个内联二维码盒子。
    // 中继状态也要自己刷（2026-11-14）：不刷的话中继掉线/重连，页面还停在旧结论上
    clearInterval(connPollTimer);
    connPollTimer = setInterval(() => {
      if (currentRoute() === "settings" && currentSettingsPage() === "connect" && el.gate.hidden) {
        void loadRelayStatus();
        // 设备列表跟着一起刷（2026-11-14 连接方式两分）：在线位、最近一次怎么连的都在变，
        // 只在进页面时读一次的话，"平板刚刚连上"要手动刷新才看得见。
        void loadDevices().then(() => paintConnStar());
      }
    }, 10000);
    // 服务页 2026-11-13 退役的两行（地址、累计 token）不复活：地址在连接卡上方，
    // token 在「用量」页。2026-11-18 起服务 / 运行时 / 关于与连接同页（见上面的三节口径）。
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
  } else if (page === "plugins") {
    // 插件中心（2026-11-16 从服务页拆出，用户口径）：所有行为开关本来就是「做出来的功能」，
    // 单独一页按「插件」摆卡片墙；服务页只留服务自身状态（通知 / 鉴权 / 运行时）。
    // 页面不套 `.card`——卡片墙自己铺在设置页背景上，外层再包一层会糊成嵌套卡片。
    el.settingsInner.innerHTML = sectionMarkup(
      "插件",
      `<div id="flags-card"><p class="set-hint">读取中…</p></div>`,
    );
    void loadFlagsSettings();
  } else if (page === "usage") {
    // 用量页（2026-11-13 从服务页拆出）：累计 / 按模型 / 明细 三张卡，一份数据三个视角。
    // 2026-11-15 加区间切换：近 7 天 / 近 30 天 / 全部（三档共用一个端点，带 range 参数）。
    // 版式：累计卡照 ZCode settings/usage-stats 的 lifetime strip（一格一数、发丝竖分隔、数字 tabular）；
    // 按模型与明细照 Cindy UsageBreakdownTables（色点对图例、占比格带小条、表格右对齐）。
    // 金额仍不做（服务端 cost 固定 0，不假装知道价格）；逐日日柱仍不画（区间数字已经够回答"最近用了多少"）。
    el.settingsInner.innerHTML = `${sectionMarkup(
      "用量",
      `<div class="card use-hero" id="use-hero"><div class="use-loading">读取中…</div></div>`,
      "",
      `<div class="use-range">
        <div class="segmented slide" id="use-range" role="radiogroup" aria-label="用量统计区间">
          <button type="button" data-range="7d" aria-checked="false">近 7 天</button>
          <button type="button" data-range="30d" aria-checked="false">近 30 天</button>
          <button type="button" data-range="all" aria-checked="false">全部</button>
        </div>
        <button class="ghost" type="button" id="use-refresh">刷新</button>
      </div>`,
    )}
    ${sectionMarkup(
      "按模型",
      `<div class="card use-models" id="use-models"><div class="use-loading">读取中…</div></div>`,
    )}
    ${sectionMarkup(
      "明细",
      `<div class="card use-detail" id="use-detail"><div class="use-loading">读取中…</div></div>`,
    )}`;
    // 工具调用统计已挪到「设置 → 工具」（2026-11-17 用户拍板：用量统一放在工具页，
    // 用量页只留模型 token 三张卡）。端点 /agent/tool-usage 保留，工具页与人设页在读。
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
  }
  // 刻意没有兜底 else：currentSettingsPage() 只会返回上面这些 id（未知 hash 落「外观」）。
  // 旧的「未知页显示关于」在 2026-11-18 关于并入「本机」后不再成立，留着反而骗人。

  replayPageEnter();
}

export { renderSettings };
