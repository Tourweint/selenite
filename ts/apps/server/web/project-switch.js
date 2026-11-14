/**
 * 项目切换 / 浮层 / 图标
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { startNewChat } from "./chat-open.js";
import { loadChats } from "./chats-list.js";
import { el } from "./dom.js";
import { request } from "./net.js";
import { openFileBrowser } from "./project-browser.js";
import { closeProjectMenu, openAddWorkspaceModal, refreshProjectPill } from "./project-modal.js";
import { projectErrorText } from "./settings-projects.js";
import { state } from "./state.js";
import { toast } from "./ui-atoms.js";

/* ── 侧栏项目面板（2026-11-04 建，2026-11-06 改为总览）────
 * 展开态 pill 与收起轨道按钮是同一份弹层、同一个渲染函数。
 * pill = 工作区根（默认目录）；展开是「工作区根 + 项目」平级总览，**不再切「当前项目」**
 * ——没人在意固定在哪个目录干活，派活时才指定项目（resolveDelegationProject）。
 * 列表每次打开现拉（同模型菜单口径）：项目可能在设置页刚建/归档，也可能是
 * 另一台设备改的。契约见接口文档 §工作区。 */

const PROJECT_UNAVAILABLE_HINT = "读不到项目接口，重启服务后再试";

/** 拿全了才返回；失败返回 null，调用方保持原状（不抛）。
 *  GET /api/v1/projects 本身就带 workspace，不用再打一发 /workspaces。 */
async function fetchProjectSwitchData() {
  const response = await request("/api/v1/projects", { cache: "no-store" });
  if (!response.ok) return null;
  const data = await response.json().catch(() => ({}));
  const workspace = data.workspace || null;
  const projects = Array.isArray(data.projects) ? data.projects : [];
  const items = projects
    .filter((project) => project && typeof project.id === "string")
    // 已归档的不进派活列表（去 设置 → 归档 看）；目录丢了的照常显示、行尾标注。
    .filter((project) => !project.archived)
    .map((project) => ({
      id: project.id,
      name: project.name || project.id,
      rootPath: project.rootPath || "",
      missing: project.exists === false,
      // 2026-11-13 项目容器：一个项目多个文件夹，侧栏徽标与浮卡都要用。
      roots: (Array.isArray(project.roots) ? project.roots : []).map((root) => ({
        id: root.id,
        label: root.label || "",
        path: root.path || "",
        role: root.role === "primary" ? "primary" : "extra",
        exists: root.exists !== false,
      })),
    }));
  return { workspace, currentProjectId: data.currentProjectId || null, items };
}

function applyProjectData(data) {
  const switcher = state.switcher;
  switcher.workspace = data.workspace;
  switcher.subCount = data.items.length;
  // 内联列表要行内容：workspace + items 一起记下，syncProjectPill 直接渲染
  switcher.items = data.items;
  switcher.currentProjectId = data.currentProjectId || null;
  switcher.unavailable = false;
  syncProjectPill();
}

/**
 * 项目分区（2026-11-07 统一批；2026-11-12 平级）：工作区根 + 项目内联成行，不再用 pill 弹小窗。
 *
 * 为什么改：用户要的是"每个分区都能展开、都能加"，pill 那种「点开一个浮层再看」
 * 与另外几个分区（会话/执事/群组）不是一个语言。列表本身就是总览，浮层留给设置页。
 * 行尾仍保留文件入口（浏览 / 资源管理器）——那两个动作不适合做成行点击。
 */
function syncProjectRows(items) {
  const box = el.projList;
  if (!box) return;
  // 列表要重建，挂在 body 上的文件夹浮卡先收掉（它不属于新列表）
  closeProjectFlyout();
  box.replaceChildren();
  const switcher = state.switcher;
  const hasWorkspace = Boolean(switcher.workspace);
  const unavailable = Boolean(switcher.unavailable);

  // 分区头恒为「项目」：塞 workspace 名会和下面工作区行一模一样，
  // 两行同为「Workspace」时根本分不清谁是默认目录（2026-11-06 截图核对）。
  if (el.secProjectsName) {
    el.secProjectsName.textContent = unavailable ? "项目不可用" : "项目";
  }

  // 接口读不到（旧后端 / 临时 5xx）不把入口藏起来：给一行可点的重试行。
  if (unavailable) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "side-item proj-row is-unavailable";
    row.textContent = "读不到项目，点一下重试";
    row.addEventListener("click", () => void refreshProjectPill());
    box.append(row);
    return;
  }

  if (!hasWorkspace) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "side-item proj-row";
    row.innerHTML = '<span class="side-item-label">设置工作区根目录</span>';
    row.title = "设定默认工作区目录";
    row.addEventListener("click", () => openAddWorkspaceModal());
    box.append(row);
    return;
  }

  // 2026-11-13：工作区根不再当「项目」分区里的一行。它只服务杂事态——没有名字、
  // 不能加文件夹、不参与派活，语义上不是项目；位置在 设置 → 项目 的第一块。

  const currentId = String(switcher.currentProjectId || "");
  for (const project of items || []) {
    box.append(projectRowNode(project, project.id === currentId));
  }

  if (!items || !items.length) {
    const empty = document.createElement("div");
    empty.className = "roster-empty";
    empty.textContent = "还没有项目。点分区右边的 ⋯ 建一个。";
    box.append(empty);
  }

  // 层级说明（2026-11-08 起不再常驻）：解释挪到「项目」分区头的 data-tip，
  // 侧栏不再有常驻小字（2026-11-06 曾压成一行小字，仍天天占位）。
}

/** 侧栏一行项目（2026-11-13 项目容器）：点行 = 选中（决定下一个新对话落在哪），
 *  ▾ 展开文件夹清单，＋ 直接在这个项目里新开。行内动作一律是图标按钮。 */
function projectRowNode(project, current) {
  const row = document.createElement("div");
  row.className = "side-item proj-row is-project" + (current ? " is-current" : "");
  row.dataset.projectId = project.id;
  row.setAttribute("role", "button");
  row.tabIndex = 0;
  row.setAttribute("aria-current", current ? "true" : "false");
  row.title = project.rootPath || project.name;
  row.append(projectIcon("sub"));

  const name = document.createElement("span");
  name.className = "side-item-label";
  name.textContent = project.name;
  row.append(name);

  if (project.missing) {
    const tag = document.createElement("span");
    tag.className = "proj-tag is-warn";
    tag.textContent = "丢失";
    row.append(tag);
  } else {
    const count = document.createElement("span");
    count.className = "proj-count";
    count.textContent = String(project.roots.length || 1);
    row.append(count);
  }

  // 文件夹清单先备好（挂 body，见 toggleProjectFlyout 的说明）
  const fly = project.roots?.length ? projectFlyout(project) : null;

  const caret = projActionButton("caret", "文件夹清单", "列出这个项目的全部文件夹", () => {
    if (!fly) return;
    toggleProjectFlyout(row, caret, fly);
  });
  caret.setAttribute("aria-expanded", "false");
  row.append(
    caret,
    projActionButton("plus", "新开对话", `在「${project.name}」里新开一个对话`, () =>
      void newChatInProject(project.id),
    ),
  );

  const select = () => void selectProject(project.id);
  row.addEventListener("click", (event) => {
    if (event.target.closest(".proj-act")) return;
    select();
  });
  row.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (event.target !== row) return;
    event.preventDefault();
    select();
  });
  return row;
}

/**
 * 文件夹清单浮卡（2026-11-13）。
 *
 * 挂 document.body + position:fixed：侧栏每个分区都被 `.side-sec-clip`
 * 的 overflow:hidden 裁着（那是折叠动画必需的），浮卡留在行内会被整块裁掉。
 * 点外面 / Esc / 滚动 / 窗口尺寸变化都关，同一时刻只开一张。
 */
let projectFlyoutState = null;

function closeProjectFlyout() {
  const open = projectFlyoutState;
  if (!open) return;
  projectFlyoutState = null;
  open.node.remove();
  open.row.classList.remove("is-open");
  open.caret.setAttribute("aria-expanded", "false");
  document.removeEventListener("pointerdown", open.onDown, true);
  document.removeEventListener("keydown", open.onKey, true);
  window.removeEventListener("scroll", closeProjectFlyout, true);
  window.removeEventListener("resize", closeProjectFlyout);
}

function toggleProjectFlyout(row, caret, node) {
  if (projectFlyoutState?.row === row) {
    closeProjectFlyout();
    return;
  }
  closeProjectFlyout();
  document.body.append(node);
  const rect = row.getBoundingClientRect();
  node.style.left = `${Math.round(Math.max(8, rect.left))}px`;
  node.style.top = `${Math.round(rect.bottom + 6)}px`;
  node.style.width = `${Math.round(Math.max(300, rect.width))}px`;
  row.classList.add("is-open");
  caret.setAttribute("aria-expanded", "true");
  const onDown = (event) => {
    if (!node.contains(event.target)) closeProjectFlyout();
  };
  const onKey = (event) => {
    if (event.key === "Escape") closeProjectFlyout();
  };
  document.addEventListener("pointerdown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("scroll", closeProjectFlyout, true);
  window.addEventListener("resize", closeProjectFlyout);
  projectFlyoutState = { row, caret, node, onDown, onKey };
}

/** 文件夹清单浮卡：每行「主/附 · 名字 · 路径」，右侧两个按钮直达浏览 / 资源管理器。 */
function projectFlyout(project) {
  const fly = document.createElement("div");
  fly.className = "proj-flyout";
  fly.addEventListener("click", (event) => event.stopPropagation());

  const head = document.createElement("div");
  head.className = "proj-fly-head";
  head.textContent = `${project.roots.length} 个文件夹`;
  fly.append(head);

  for (const root of project.roots) {
    const line = document.createElement("div");
    line.className = "proj-fly-row" + (root.role === "primary" ? " is-primary" : "");
    const top = document.createElement("div");
    top.className = "proj-fly-top";
    const dot = document.createElement("span");
    dot.className = "proj-root-dot";
    dot.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.className = "proj-fly-label";
    label.textContent = root.label + (root.role === "primary" ? " · 主" : "");
    const acts = document.createElement("span");
    acts.className = "proj-fly-acts";
    acts.append(
      projActionButton("browse", "浏览文件", `在界面里看「${root.label}」`, () =>
        openFileBrowser(`${project.name} / ${root.label}`, "", root.label, project.id, root.id),
      ),
      projActionButton("explorer", "在资源管理器中打开", `在资源管理器里打开「${root.label}」`, () =>
        openExplorerInOs(project.id, root.id),
      ),
    );
    top.append(dot, label, acts);
    const path = document.createElement("div");
    path.className = "proj-fly-path is-mono";
    path.textContent = root.path;
    path.title = root.path;
    line.append(top, path);
    fly.append(line);
  }
  return fly;
}

/** 选中项目 = 决定**下一个新对话**的 cwd（已建会话不动，各自留在创建时的快照里）。 */
async function selectProject(projectId, options = {}) {
  try {
    const response = await request("/api/v1/workspaces/current-project", {
      method: "PUT",
      body: JSON.stringify({ projectId }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      toast(projectErrorText(data, response.status));
      return false;
    }
    state.switcher.currentProjectId = projectId;
    syncProjectRows(state.switcher.items || []);
    if (!options.silent) toast("已选中：下一个新对话落在这个项目里");
    void loadChats();
    return true;
  } catch (error) {
    if (error.message !== "forbidden") toast(`没选成：${error.message}`);
    return false;
  }
}

/** 行尾 ＋：先选中再新开——两步都要成，不然新对话会落到上一个项目里。 */
async function newChatInProject(projectId) {
  const selected = await selectProject(projectId, { silent: true });
  if (!selected) return;
  startNewChat("worker");
}

/* 收起轨道的项目按钮仍走弹层（72px 放不下内联列表），内容复用同一个总览渲染。
   2026-11-13 起 data-tip 退役：悬停说明换成悬停直接浮弹层。 */
function syncRailProject() {
  if (!el.railProj) return;
  el.railProj.hidden = false;
  el.railProj.classList.toggle("is-unavailable", Boolean(state.switcher.unavailable));
  el.railProj.removeAttribute("title");
  el.railProj.removeAttribute("data-tip");
  el.railProj.setAttribute("aria-label", "项目");
}

/** 项目区 / 轨道按钮 / 降级态都从这里刷新，别在两处各写一份显示逻辑 */
function syncProjectPill() {
  syncProjectRows(state.switcher.items || []);
  syncRailProject();
}

/* 项目弹层的线描图标（静态图元，不引图标库/远程图片）：
   工作区与项目都是文件夹——两者是平级目录（2026-11-12），不再用折入箭头暗示层级。 */
const PROJECT_ICONS = {
  main:
    '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  sub: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  explorer:
    '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><path d="m14 13 2 2-2 2"/><path d="M8 15h4"/>',
  browse:
    '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
  caret: '<path d="m6 9 6 6 6-6"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
};

function projectIcon(kind) {
  const slot = document.createElement("span");
  slot.className = `proj-ico is-${kind}`;
  slot.setAttribute("aria-hidden", "true");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  // 只写入本文件里的常量图元，不拼接任何用户数据
  svg.innerHTML = PROJECT_ICONS[kind] || "";
  slot.append(svg);
  return slot;
}

/** 行尾小动作钮（2026-11-06 文件浏览入口）：在资源管理器中打开 / 浏览文件。 */
function projActionButton(icon, label, tip, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "proj-act";
  button.title = tip;
  button.setAttribute("aria-label", `${label}：${tip}`);
  const slot = document.createElement("span");
  slot.className = "proj-act-ico";
  slot.setAttribute("aria-hidden", "true");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  // 只写入本文件里的常量图元，不拼接任何用户数据
  svg.innerHTML = PROJECT_ICONS[icon] || "";
  slot.append(svg);
  button.append(slot);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

/** 让服务端对本机目录起系统资源管理器（projectId / rootId 缺省 = 工作区根）。 */
async function openExplorerInOs(projectId, rootId = "") {
  try {
    const body = {};
    if (projectId) body.projectId = projectId;
    if (projectId && rootId) body.rootId = rootId;
    const response = await request("/api/v1/workspaces/open-explorer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      // 404 = 这个进程还是没带文件入口的旧版本（端点 18:39 才合入）。
      // 以前这里只说「打不开资源管理器」，用户完全不知道是版本问题。
      if (response.status === 404) {
        toast(SERVICE_TOO_OLD_HINT);
        return;
      }
      toast(`打不开资源管理器：${data.message || data.error || `HTTP ${response.status}`}`);
      return;
    }
    closeProjectMenu();
  } catch (error) {
    if (error.message !== "forbidden") toast("打不开资源管理器，重启服务后再试");
  }
}

const SERVICE_TOO_OLD_HINT = "服务还是旧版本（没有文件/资源管理器接口），重启服务后再点";

/** 侧栏文件浏览器（只读）：列目录 + 看文本，路径锁在所选根内。
 *
 *  `startRel` 是**相对该根**的路径；`projectId` 为空 = 工作区根，非空 = 项目自己的根
 *  （2026-11-12 多根：项目可以在工作区外，不再用工作区相对路径套）。
 */

export { PROJECT_ICONS, PROJECT_UNAVAILABLE_HINT, SERVICE_TOO_OLD_HINT, applyProjectData, closeProjectFlyout, fetchProjectSwitchData, newChatInProject, openExplorerInOs, projActionButton, projectFlyout, projectFlyoutState, projectIcon, projectRowNode, selectProject, syncProjectPill, syncProjectRows, syncRailProject, toggleProjectFlyout };
