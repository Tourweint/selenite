/**
 * 添加项目 / 工作区弹窗与菜单定位（含浮层锚点状态）
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { el } from "./dom.js";
import { attr } from "./markdown.js";
import { request } from "./net.js";
import { renderProjectMenu } from "./project-browser.js";
import { PROJECT_UNAVAILABLE_HINT, applyProjectData, fetchProjectSwitchData, syncProjectPill } from "./project-switch.js";
import { railHover } from "./rail-card.js";
import { currentRoute, currentSettingsPage } from "./route.js";
import { loadProjectsSettings, projectErrorText, settingsWorkspace } from "./settings-projects.js";
import { state } from "./state.js";
import { closeModal, closePopover, inShell, openModal, openPopover, popoverOpen, selectDirectory, toast } from "./ui-atoms.js";

let projectAnchor = null;
let projectLoading = false;
// 打开序号：慢网下点了外面，等在路上的现拉结果回来也不许自己弹出来
let projectOpenToken = 0;

/* ── 添加项目弹窗（2026-11-05 F1；2026-11-12 多根）──────────────
 * 工作区根 = 默认目录；项目 = 平级的其他根，可以在任意位置。
 * 两个弹窗共用同一套壳桥接：壳内多一颗「选择目录」，浏览器手输绝对路径。
 * 添加已有目录提交 proposal 后立刻 confirm —— 目录是用户亲手选的，不再二次确认。 */

function baseNameOf(path) {
  const text = String(path || "").trim().replace(/[\\/]+$/, "");
  if (!text) return "";
  const parts = text.split(/[\\/]+/);
  return parts[parts.length - 1] || "";
}

function isAbsolutePath(path) {
  const text = String(path || "").trim();
  // Windows 盘符 / UNC，或 POSIX 根；具体合法性仍由服务端复核
  return /^[a-zA-Z]:[\\/]/.test(text) || /^\\\\/.test(text) || text.startsWith("/");
}

/** 工作区/项目登记后，侧栏 pill 与设置页项目列表一起刷新 */
async function refreshProjectViews() {
  await refreshProjectPill();
  if (currentRoute() === "settings" && currentSettingsPage() === "projects") {
    await loadProjectsSettings();
  }
}

function setModalHint(node, text, isError = true) {
  if (!node) return;
  node.textContent = text;
  node.classList.toggle("is-error", Boolean(isError));
}

function clearModalHint(node) {
  if (!node) return;
  node.textContent = "";
  node.classList.remove("is-error");
}

function openAddWorkspaceModal() {
  const currentRoot = state.switcher.workspace?.rootPath || "";
  openModal("设置工作区根目录", (body) => {
    body.innerHTML = `
      <p class="modal-desc">工作区根是默认目录；项目和它平级，可以放在任意位置。更换默认目录会清空当前项目选择。</p>
      <div class="modal-field">
        <span>目录（绝对路径）</span>
        <div class="modal-row">
          <input class="modal-input" id="add-workspace-path" type="text" spellcheck="false"
                 placeholder="例如：D:/Projects" value="${attr(currentRoot)}" />
          ${inShell() ? '<button class="ghost" id="add-workspace-pick" type="button">选择目录</button>' : ""}
        </div>
      </div>
      <p class="modal-hint" id="add-workspace-hint"></p>
      <div class="modal-actions">
        <button class="ghost" type="button" data-modal-cancel>取消</button>
        <button class="modal-primary" id="add-workspace-confirm" type="button">确认</button>
      </div>`;

    const pathInput = body.querySelector("#add-workspace-path");
    const hint = body.querySelector("#add-workspace-hint");
    const confirm = body.querySelector("#add-workspace-confirm");
    const pick = body.querySelector("#add-workspace-pick");

    body.querySelector("[data-modal-cancel]")?.addEventListener("click", closeModal);

    pick?.addEventListener("click", async () => {
      const chosen = await selectDirectory();
      if (!chosen) return; // 用户取消：保留原值
      pathInput.value = chosen;
      clearModalHint(hint);
    });

    const submit = async () => {
      if (confirm.disabled) return;
      const rootPath = pathInput.value.trim();
      if (!rootPath) {
        setModalHint(hint, "先选一个目录。");
        pathInput.focus();
        return;
      }
      if (!isAbsolutePath(rootPath)) {
        setModalHint(hint, "目录要写绝对路径。");
        pathInput.focus();
        return;
      }
      confirm.disabled = true;
      hint.textContent = "保存中…";
      hint.classList.remove("is-error");
      try {
        const response = await request("/api/v1/workspaces", {
          method: "POST",
          body: JSON.stringify({ rootPath }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          setModalHint(hint, projectErrorText(data, response.status));
          return;
        }
        closeModal();
        toast("工作区已设置");
        await refreshProjectViews();
      } catch (error) {
        if (error.message === "forbidden") {
          closeModal(); // 令牌门在最上层，别让模态挡住它
          return;
        }
        setModalHint(hint, `没存成：${error.message}`);
      } finally {
        confirm.disabled = false;
      }
    };

    confirm.addEventListener("click", () => void submit());
    pathInput.addEventListener("input", () => clearModalHint(hint));
    pathInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void submit();
      }
    });
  });
}

/**
 * 项目 ＋ 的双入口（2026-11-07 四改，用户口径「项目的加号：用于创建新项目或添加子项目」）。
 *
 * 两个动作的区别（服务端已经这么分工，前端只是把它们摆到同一个 ＋ 下）：
 *   · 新建项目 —— 目录还不存在，确认时服务端 mkdir 再登记（POST /projects → confirm）；
 *   · 添加项目 —— 目录已经在硬盘上（多半是已有仓库），只登记、不建目录；可在任意位置。
 * 位置按 ＋ 实测坐标写，右侧放不下就翻到左边；点外面 / Esc 关。
 */
function closeProjectAddMenu() {
  const menu = document.getElementById("proj-add-menu");
  if (!menu) return;
  menu.remove();
  el.secProjectsAdd?.setAttribute("aria-expanded", "false");
}

function openProjectAddMenu() {
  const button = el.secProjectsAdd;
  if (!button) return;
  if (document.getElementById("proj-add-menu")) {
    closeProjectAddMenu();
    return;
  }
  const menu = document.createElement("div");
  menu.id = "proj-add-menu";
  menu.className = "proj-add-menu";
  menu.setAttribute("role", "menu");

  const make = (label, hint, run) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "proj-add-item";
    item.setAttribute("role", "menuitem");
    const title = document.createElement("span");
    title.className = "proj-add-label";
    title.textContent = label;
    const sub = document.createElement("span");
    sub.className = "proj-add-hint";
    sub.textContent = hint;
    item.append(title, sub);
    item.addEventListener("click", () => {
      closeProjectAddMenu();
      run();
    });
    return item;
  };

  menu.append(
    make("新建项目", "目录还不存在，确认后建目录并登记", () => openCreateProjectModal()),
    make("添加项目", "目录已经在硬盘上，只登记不新建（任意位置）", () => openAddProjectModal()),
  );
  document.body.append(menu);

  // 定位：菜单挂在 body 下（不被侧栏 overflow 裁掉），坐标按按钮实测
  const rect = button.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  let left = rect.right - width;
  let top = rect.bottom + 6;
  if (left < 8) left = 8;
  if (top + height > window.innerHeight - 8) top = rect.top - height - 6;
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(Math.max(48, top))}px`;
  button.setAttribute("aria-expanded", "true");

  // 首次点外面就关；用 setTimeout 避开"打开这一下"自身
  setTimeout(() => {
    const onDown = (event) => {
      if (event.target.closest("#proj-add-menu") || event.target === button) return;
      closeProjectAddMenu();
      document.removeEventListener("pointerdown", onDown, true);
    };
    document.addEventListener("pointerdown", onDown, true);
  }, 0);
}

/**
 * 新建项目（目录不存在）：POST /projects 提交待确认请求 → 立刻 confirm。
 * 与「添加项目」共用同一套校验，差别只在文案与「会把目录建出来」这件事。
 */
function openCreateProjectModal() {
  const rootPath = state.switcher.workspace?.rootPath || settingsWorkspace?.rootPath || "";
  if (!rootPath) {
    toast("先设置工作区根目录");
    openAddWorkspaceModal();
    return;
  }
  openModal("新建项目", (body) => {
    body.innerHTML = `
      <p class="modal-desc">新项目会建在工作区根目录下。写一个还不存在的子目录名，确认后由服务端创建并登记；已有目录请用「添加项目」。</p>
      <div class="modal-field">
        <span>项目名</span>
        <input class="modal-input" id="new-project-name" type="text" maxlength="60"
               placeholder="例如：new-tool" />
      </div>
      <div class="modal-field">
        <span>目录（相对工作区根目录，可留空 = 用项目名）</span>
        <input class="modal-input" id="new-project-path" type="text" spellcheck="false"
               placeholder="例如：tools/new-tool" />
      </div>
      <p class="modal-hint" id="new-project-hint"></p>
      <div class="modal-actions">
        <button class="ghost" type="button" data-modal-cancel>取消</button>
        <button class="modal-primary" id="new-project-confirm" type="button">创建</button>
      </div>`;

    const nameInput = body.querySelector("#new-project-name");
    const pathInput = body.querySelector("#new-project-path");
    const hint = body.querySelector("#new-project-hint");
    const confirm = body.querySelector("#new-project-confirm");
    body.querySelector("[data-modal-cancel]")?.addEventListener("click", closeModal);

    const submit = async () => {
      if (confirm.disabled) return;
      const name = nameInput.value.trim();
      const raw = pathInput.value.trim() || name;
      if (!name) {
        setModalHint(hint, "先给项目起个名字。");
        nameInput.focus();
        return;
      }
      if (isAbsolutePath(raw)) {
        setModalHint(hint, "这里填相对工作区根目录的路径；已有目录请用「添加项目」。");
        pathInput.focus();
        return;
      }
      confirm.disabled = true;
      hint.textContent = "创建中…";
      hint.classList.remove("is-error");
      try {
        const response = await request("/api/v1/projects", {
          method: "POST",
          body: JSON.stringify({ name, path: raw }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          setModalHint(hint, projectErrorText(data, response.status));
          return;
        }
        const proposalId = data?.proposal?.id;
        if (!proposalId) {
          setModalHint(hint, "服务端没有返回待确认请求，刷新后再试。");
          return;
        }
        const confirmed = await request(
          `/api/v1/projects/${encodeURIComponent(proposalId)}/confirm`,
          { method: "POST" },
        );
        const confirmedData = await confirmed.json().catch(() => ({}));
        if (!confirmed.ok) {
          setModalHint(hint, projectErrorText(confirmedData, confirmed.status));
          return;
        }
        closeModal();
        toast(`已创建 ${name}`);
        await refreshProjectViews();
      } catch (error) {
        if (error.message === "forbidden") {
          closeModal();
          return;
        }
        setModalHint(hint, `没建成：${error.message}`);
      } finally {
        confirm.disabled = false;
      }
    };

    confirm.addEventListener("click", () => void submit());
    for (const input of [nameInput, pathInput]) {
      input.addEventListener("input", () => clearModalHint(hint));
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void submit();
        }
      });
    }
  });
}

function openAddProjectModal() {
  // 设置页「添加项目」不走侧栏切换器，根目录用设置页刚读到的那份（state.switcher 可能还没拉）
  const rootPath = state.switcher.workspace?.rootPath || settingsWorkspace?.rootPath || "";
  if (!rootPath) {
    toast("先设置工作区根目录");
    return;
  }
  openModal("添加项目", (body) => {
    body.innerHTML = `
      <p class="modal-desc">登记一个磁盘上已有的目录，只登记、不新建。可以在任意位置，不要求在工作区下面。</p>
      <div class="modal-field">
        <span>项目目录（绝对路径）</span>
        <div class="modal-row">
          <input class="modal-input" id="add-project-path" type="text" spellcheck="false"
                 placeholder="例如：D:/Projects/new-tool" />
          ${inShell() ? '<button class="ghost" id="add-project-pick" type="button">选择目录</button>' : ""}
        </div>
      </div>
      <div class="modal-field">
        <span>项目名</span>
        <input class="modal-input" id="add-project-name" type="text" maxlength="60"
               placeholder="默认取目录名，可改" />
      </div>
      <p class="modal-hint" id="add-project-hint"></p>
      <div class="modal-actions">
        <button class="ghost" type="button" data-modal-cancel>取消</button>
        <button class="modal-primary" id="add-project-confirm" type="button">确认</button>
      </div>`;

    const pathInput = body.querySelector("#add-project-path");
    const nameInput = body.querySelector("#add-project-name");
    const hint = body.querySelector("#add-project-hint");
    const confirm = body.querySelector("#add-project-confirm");
    const pick = body.querySelector("#add-project-pick");
    let nameTouched = false;

    const syncName = () => {
      if (!nameTouched) nameInput.value = baseNameOf(pathInput.value);
    };

    body.querySelector("[data-modal-cancel]")?.addEventListener("click", closeModal);

    pick?.addEventListener("click", async () => {
      const chosen = await selectDirectory();
      if (!chosen) return;
      pathInput.value = chosen;
      syncName();
      clearModalHint(hint);
    });

    pathInput.addEventListener("input", () => {
      syncName();
      clearModalHint(hint);
    });
    nameInput.addEventListener("input", () => {
      nameTouched = true;
      clearModalHint(hint);
    });

    const submit = async () => {
      if (confirm.disabled) return;
      const path = pathInput.value.trim();
      const name = nameInput.value.trim();
      if (!path) {
        setModalHint(hint, "先选一个项目目录。");
        pathInput.focus();
        return;
      }
      if (!isAbsolutePath(path)) {
        setModalHint(hint, "目录要写绝对路径。");
        pathInput.focus();
        return;
      }
      if (!name) {
        setModalHint(hint, "给项目起个名字。");
        nameInput.focus();
        return;
      }
      confirm.disabled = true;
      hint.textContent = "登记中…";
      hint.classList.remove("is-error");
      try {
        const response = await request("/api/v1/projects", {
          method: "POST",
          body: JSON.stringify({ name, path }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          setModalHint(hint, projectErrorText(data, response.status));
          return;
        }
        const proposalId = data?.proposal?.id;
        if (!proposalId) {
          setModalHint(hint, "服务端没有返回待确认请求，刷新后再试。");
          return;
        }
        // 用户亲手选的目录：立即确认，不再弹第二次
        const confirmed = await request(
          `/api/v1/projects/${encodeURIComponent(proposalId)}/confirm`,
          { method: "POST" },
        );
        const confirmedData = await confirmed.json().catch(() => ({}));
        if (!confirmed.ok) {
          setModalHint(hint, projectErrorText(confirmedData, confirmed.status));
          return;
        }
        closeModal();
        toast(`已添加 ${name}`);
        await refreshProjectViews();
      } catch (error) {
        if (error.message === "forbidden") {
          closeModal();
          return;
        }
        setModalHint(hint, `没登记成：${error.message}`);
      } finally {
        confirm.disabled = false;
      }
    };

    confirm.addEventListener("click", () => void submit());
    pathInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void submit();
      }
    });
    nameInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void submit();
      }
    });
  });
}

function closeProjectMenu() {
  projectOpenToken += 1;
  if (!el.projectMenu) return;
  // projectAnchor 指向最后用过的触发点（现在只剩收起轨道的项目钮），aria-expanded 才对得上
  closePopover(el.projectMenu, projectAnchor);
}

/**
 * 轨道弹层定位（项目 / 群组 / 执事悬停卡共用，2026-11-13 从 placeProjectMenu 泛化）：
 * 挂在 body 下、absolute 以视口为参照（页面不滚动），
 * 所以不会被侧栏收起动画的 overflow:hidden 裁掉。
 * 轨道只有 72px 宽：往右弹、垂直对齐按钮（贴 pill 的旧形态随 pill 退役留作兜底分支）。
 * 左右上下越界都夹回屏幕内（窄窗口 + 轨道态必需）。
 */
function placeRailMenu(menu, trigger) {
  if (!menu || !trigger) return;
  const anchor = trigger.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const gap = 8;
  const pad = 12;
  // 顶栏是 fixed 的 40px：弹层别钻到它下面去（z-index 也压在它之下）
  const minTop = 48;
  let left;
  let top;
  if (trigger.closest(".side-rail")) {
    left = anchor.right + gap;
    top = anchor.top + anchor.height / 2 - 18;
  } else {
    left = anchor.left;
    top = anchor.top - gap - height;
    if (top < minTop) top = anchor.bottom + gap;
  }
  left = Math.max(pad, Math.min(left, window.innerWidth - pad - width));
  top = Math.max(minTop, Math.min(top, window.innerHeight - pad - height));
  // openPopover 可能写过 right:0，这里改回 left 定位；只保留一套坐标
  menu.style.right = "auto";
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

/**
 * 打开项目弹层（悬停定时到点与点击共用；已开着就不动）。
 * hoverOnly = 悬停路径：现拉数据回来时如果指针早离开了（railHover 不再指向这张卡），
 * 就不要把弹层补出来——点击路径不作此检查，点了就要开。
 */
async function ensureProjectMenuOpen(trigger, { hoverOnly = false } = {}) {
  if (!el.projectMenu || !trigger) return;
  if (popoverOpen(el.projectMenu)) return;
  if (projectLoading) return;
  // 上次接口读不到（旧后端 / 临时故障）：先重试，仍不行再给明确提示。
  if (state.switcher.unavailable) {
    await refreshProjectPill();
    if (state.switcher.unavailable) {
      if (!hoverOnly) toast(PROJECT_UNAVAILABLE_HINT);
      return;
    }
  }
  projectLoading = true;
  const token = ++projectOpenToken;
  try {
    // 每次打开都现拉：不缓存（同模型菜单口径）
    const data = await fetchProjectSwitchData();
    // 现拉期间点过外面 / 换了路由：这次结果作废，别把弹层补出来
    if (token !== projectOpenToken) return;
    // 悬停路径：等数据回来人已经不在按钮/卡上了，不开（点击路径不受限）
    if (hoverOnly && !(railHover.menu === el.projectMenu && railHover.trigger === trigger)) return;
    if (!data) {
      state.switcher.unavailable = true;
      syncProjectPill();
      if (!hoverOnly) toast(PROJECT_UNAVAILABLE_HINT);
      return;
    }
    applyProjectData(data);
    // 没有工作区也照常打开：里面还有「设置工作区根目录」（2026-11-08 起服务端启动会播种
    // 默认工作区，这个入口只剩兜底/换目录用，不再是首次使用的必经之路）
    renderProjectMenu(data.items);
    projectAnchor = trigger;
    openPopover(el.projectMenu, trigger);
    // openPopover 会清掉 left/right，落点必须在它之后写
    placeRailMenu(el.projectMenu, trigger);
  } catch (error) {
    if (error.message !== "forbidden") {
      state.switcher.unavailable = true;
      syncProjectPill();
      if (!hoverOnly) toast("读不到项目列表");
    }
  } finally {
    projectLoading = false;
  }
}

/** 启动 / 回到对话页时补一次项目数据：读不到就保持现状，下次打开弹层会再试 */
async function refreshProjectPill() {
  try {
    const data = await fetchProjectSwitchData();
    if (data) {
      applyProjectData(data);
      return;
    }
    // 接口在但没给数据（404/5xx）：降级成可见的「项目不可用」，
    // 不能让 pill 保持初始 hidden——那正是"项目凭空消失"的观感来源。
    state.switcher.unavailable = true;
    syncProjectPill();
  } catch (error) {
    // 403 交给令牌门；其它错误同样降级显示，下一次刷新会自动重试。
    if (error.message === "forbidden") return;
    state.switcher.unavailable = true;
    syncProjectPill();
  }
}

export { baseNameOf, clearModalHint, closeProjectAddMenu, closeProjectMenu, ensureProjectMenuOpen, isAbsolutePath, openAddProjectModal, openAddWorkspaceModal, openCreateProjectModal, openProjectAddMenu, placeRailMenu, projectAnchor, projectLoading, projectOpenToken, refreshProjectPill, refreshProjectViews, setModalHint };
