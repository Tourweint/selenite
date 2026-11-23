/**
 * 技能启停位 / 批量确认 / 新建技能两条路
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { el } from "./dom.js";
import { request } from "./net.js";
import { openChiefChat } from "./partners-status.js";
import { resize } from "./plus-menu.js";
import { setModalHint } from "./project-modal.js";
import { openCreateSkillModal } from "./skills-modals.js";
import { loadSkills, skillAdvice } from "./skills-settings.js";
import { closeModal, openModal, toast } from "./ui-atoms.js";

/* ── 技能启停位 + 批量（2026-11-09 用户拍板：技能默认全关，开了才进索引）──
 * 数据面：GET /agent/skills 的 items[].enabled + PUT /agent/skills/:name/enabled +
 * PUT /agent/skills/enabled-all。索引按会话冻结（D5），开关对已在跑的会话不生效；
 * skill 工具取手册是即时的（关了立刻取不到）。 */

async function toggleSkillEnabled(name, enabled, sw) {
  // 内置技能没有启停位：UI 已不渲染开关，这里再挡一层（服务端也会回 400）。
  if (skillAdvice.items.some((item) => item.name === name && item.core === true)) return;
  if (sw) sw.disabled = true;
  try {
    const response = await request(
      `/api/v1/agent/skills/${encodeURIComponent(name)}/enabled`,
      { method: "PUT", body: JSON.stringify({ enabled }) },
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      toast(data.message || `没存成：HTTP ${response.status}`);
      if (sw) sw.disabled = false;
      return;
    }
    if (sw) {
      sw.setAttribute("aria-checked", String(enabled));
      sw.disabled = false;
    }
    toast(enabled ? `已开启「${name}」，下一个会话进索引` : `已关闭「${name}」`);
  } catch (error) {
    if (error.message !== "forbidden") toast(`没存成：${error.message}`);
    if (sw) sw.disabled = false;
  }
}

async function toggleAllSkills(enabled) {
  try {
    const response = await request("/api/v1/agent/skills/enabled-all", {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      toast(data.message || `没存成：HTTP ${response.status}`);
      return false;
    }
    toast(enabled ? `已全开 ${data.count} 个技能，下一个会话进索引` : `已全关 ${data.count} 个技能`);
    void loadSkills();
    return true;
  } catch (error) {
    if (error.message !== "forbidden") toast(`没存成：${error.message}`);
    return false;
  }
}

/* ── 批量开关确认（2026-11-13 二轮）────────────────────────
 * 页面上只留一个状态相关的入口（全部开启 / 全部关闭）；真正的动作在确认弹窗里，
 * 混着开/关时两个方向都给（否则"想全关"得先全开一次，绕一圈）。 */
function openBulkSkillModal() {
  const items = skillAdvice.items;
  if (!items.length) return;
  const onCount = items.filter((item) => item.enabled === true).length;
  const offCount = items.length - onCount;
  openModal("批量开关技能", (body) => {
    body.innerHTML = `
      <p class="modal-desc">当前 <b>${onCount}</b> 个已开启、<b>${offCount}</b> 个未开启。</p>
      <p class="modal-hint" id="sk-bulk-hint">索引随下一个会话刷新，已在跑的会话不受影响；关闭后对话里的 /技能名 会立即取不到手册。</p>
      <div class="modal-actions">
        <button class="ghost" type="button" data-modal-cancel>取消</button>
        ${offCount ? '<button class="modal-primary" id="sk-bulk-on" type="button">全部开启</button>' : ""}
        ${onCount ? '<button class="modal-danger" id="sk-bulk-off" type="button">全部关闭</button>' : ""}
      </div>`;
    const hint = body.querySelector("#sk-bulk-hint");
    body.querySelector("[data-modal-cancel]")?.addEventListener("click", closeModal);
    const run = async (enabled, button) => {
      if (!button || button.disabled) return;
      button.disabled = true;
      setModalHint(hint, enabled ? "开启中…" : "关闭中…", false);
      const ok = await toggleAllSkills(enabled);
      if (ok) closeModal();
      else button.disabled = false;
    };
    body.querySelector("#sk-bulk-on")?.addEventListener("click", (event) => void run(true, event.currentTarget));
    body.querySelector("#sk-bulk-off")?.addEventListener("click", (event) => void run(false, event.currentTarget));
  });
}

/* ── 新建技能：两条路（2026-11-13 用户口径）────────────────
 * ① 让 Agent 写：跳总管对话并预填提示词（问清用途/步骤 → 用 bash 写进技能目录）；
 * ② 自己填：原来的表单。技能目录取列表端点的 data.dir，Agent 才知道该往哪写。 */
function winToPosixPath(dir) {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(String(dir || ""));
  return match ? `/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}` : "";
}

function skillAgentCreatePrompt() {
  const dir = skillAdvice.dir;
  const posix = winToPosixPath(dir);
  return [
    "帮我新建一个技能（给 AI 的操作手册）。",
    "",
    "先问我三件事（一次问完也行）：1）什么时候该用这个技能；2）按什么步骤做；3）有哪些边界、坑、不该做的事。",
    "",
    "问清楚后，把手册写成文件放进我的技能库：",
    dir ? `目录：${dir}` : "目录：设置 → 注入 → 技能 页顶部「位置」显示的那个目录",
    posix ? `bash 里用这个路径：${posix}` : "",
    "文件名：小写字母 / 数字 / 短横线，例如 daily-brief.md",
    "格式：第 1 行一句话摘要（会进技能索引），第 2 行起写正文（Markdown）。",
    "这个目录在工作区外，write 工具会被工作区边界拦住；请用 bash 直接写文件（UTF-8）。写完告诉我技能名，我回「设置 → 注入 → 技能」开启它。",
    "如果写不进去，就把最终 Markdown 整段发给我，我贴回「自己填」里保存。",
  ]
    .filter(Boolean)
    .join("\n");
}

function openSkillAgentCreate() {
  openChiefChat();
  if (!el.input) return;
  el.input.value = skillAgentCreatePrompt();
  resize();
  el.input.focus();
  toast("已打开总管对话——把需求说清楚，写好回来开启");
}

function openCreateSkillChoiceModal() {
  openModal("新建技能", (body) => {
    body.innerHTML = `
      <p class="modal-desc">两种方式，选一种。</p>
      <div class="sk-choice">
        <button class="sk-choice-item" type="button" data-choice="agent">
          <span class="sk-choice-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/></svg></span>
          <span class="sk-choice-main">
            <span class="sk-choice-title">让 Agent 帮我写</span>
            <span class="sk-choice-hint">去和总管聊：它问清用途和步骤，写成手册存进技能库。</span>
          </span>
        </button>
        <button class="sk-choice-item" type="button" data-choice="manual">
          <span class="sk-choice-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z"/></svg></span>
          <span class="sk-choice-main">
            <span class="sk-choice-title">自己填</span>
            <span class="sk-choice-hint">名字、一句话摘要、正文，直接写文件。</span>
          </span>
        </button>
      </div>
      <div class="modal-actions">
        <button class="ghost" type="button" data-modal-cancel>取消</button>
      </div>`;
    body.querySelector("[data-modal-cancel]")?.addEventListener("click", closeModal);
    body.querySelector('[data-choice="agent"]')?.addEventListener("click", () => {
      closeModal();
      openSkillAgentCreate();
    });
    body.querySelector('[data-choice="manual"]')?.addEventListener("click", () => {
      closeModal();
      openCreateSkillModal();
    });
  });
}

export { openBulkSkillModal, openCreateSkillChoiceModal, openSkillAgentCreate, skillAgentCreatePrompt, toggleAllSkills, toggleSkillEnabled, winToPosixPath };
