/**
 * 项目分区：根目录、卡片、归档
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { openRenameProjectModal, renderProposalList } from "./archive-delete.js";
import { loadArchivePage } from "./archive-page.js";
import { loadChats } from "./chats-list.js";
import { attr, esc } from "./markdown.js";
import { request } from "./net.js";
import { refreshProjectPill, setModalHint } from "./project-modal.js";
import { isResearchProject, toggleResearchProject } from "./research-tag.js";
import { currentSettingsPage } from "./route.js";
import { flagOn } from "./surfaces.js";
import { closeModal, inShell, openModal, selectDirectory, toast } from "./ui-atoms.js";


/* ── 项目分区（2026-11-04 批次六）───────────────────────
   服务端 2026-11-03 就有登记/提案/确认流，这里只是把它接上：
   工作区 = 默认目录（主根）；项目 = 平级的其他根，可以在任意位置；确认提案才建/登记。
   路由以代码为准：确认 / 拒绝是 POST /api/v1/projects/:id/confirm|reject。 */

const PROJECT_ERROR_TEXT = {
  bad_request: "名称和路径都要填。",
  bad_path: "路径不合法：工作区和项目都要写绝对路径。",
  outside_workspace: "项目必须在工作区内（回滚开关 PROJECT_OUTSIDE_WORKSPACE=false 已开启）。",
  no_workspace: "还没有工作区，先去设置。",
  inside_existing_project: "这个路径已经在某个已登记项目里了，不用重复登记。",
  contains_project: "这个目录包含已登记项目，请选更具体的目录。",
  duplicate_project: "同名或同路径的项目已存在。",
  project_in_flight: "这个项目还有没跑完的任务，先取消或等任务完结，再归档或删除登记。",
  unknown_project: "找不到这个项目，刷新后再试。",
  already_decided: "这条请求已经处理过了。",
  not_found: "找不到这条待确认请求，刷新后再试。",
};

function projectErrorText(data, status) {
  // bad_path 的服务端文案更具体（盘符根 / 主目录 / 不可写），别用笼统那句盖掉
  if (data?.error === "bad_path" && typeof data.message === "string" && data.message.trim()) {
    return data.message;
  }
  return PROJECT_ERROR_TEXT[data?.error] || data?.message || `没成功：HTTP ${status}`;
}

/** 设置页最近一次读到的工作区；「添加项目」弹层要用它做默认起点。 */
let settingsWorkspace = null;

async function loadProjectsSettings() {
  try {
    const [workspaceResponse, projectsResponse, proposalsResponse] = await Promise.all([
      request("/api/v1/workspaces", { cache: "no-store" }),
      // 归档页要把 archived 的一并读回来；默认列表已滤掉它们。
      request("/api/v1/projects?includeArchived=1", { cache: "no-store" }),
      request("/api/v1/projects/proposals?status=pending", { cache: "no-store" }),
    ]);
    const workspaceData = await workspaceResponse.json();
    const projectsData = await projectsResponse.json();
    const proposalsData = await proposalsResponse.json();
    const workspace = workspaceData.workspace || projectsData.workspace || null;
    settingsWorkspace = workspace;
    renderProjectList(workspace, projectsData.projects || []);
    renderProposalList(proposalsData.proposals || []);
  } catch (error) {
    if (error.message === "forbidden") return;
    for (const id of ["project-list", "proposal-list"]) {
      const box = document.getElementById(id);
      if (box) {
        box.innerHTML = `<div class="set-hint is-error">读不到：${esc(error.message)}</div>`;
      }
    }
  }
}

/** 工作区根（2026-11-14 第六版）：标签 + 路径 + 行尾两个按钮（选择目录 / 保存）平级。
 *  保存是显式动作——换根目录会清空当前项目选择，不能像普通输入框那样失焦就存。
 *  桌面壳多一个「选择目录」：选完只填进路径，仍然要点保存才生效（避免误改）。
 *  改过还没存时，下一行出一句浅灰「还没保存」。 */
function workspaceRowMarkup(workspace) {
  const hasWorkspace = Boolean(workspace);
  return `<div class="proj-card is-workspace" id="workspace-card">
    <div class="proj-card-main">
      <div class="proj-ws-row">
        <span class="proj-ws-label">工作区根目录</span>
        <input class="proj-ws-path is-mono" id="workspace-path" type="text" spellcheck="false"
               aria-label="工作区根目录" placeholder="选择一个目录"
               value="${hasWorkspace ? attr(workspace.rootPath) : ""}" />
        <span class="proj-ws-actions">
          ${inShell() ? '<button class="btn-primary is-quiet" type="button" id="workspace-pick">选择目录</button>' : ""}
          <button class="btn-primary" type="button" id="workspace-save">${hasWorkspace ? "保存" : "设定"}</button>
        </span>
      </div>
      <div class="proj-card-hint" id="workspace-hint" hidden></div>
    </div>
  </div>`;
}

function wireWorkspaceRow(workspace) {
  const hasWorkspace = Boolean(workspace);
  const input = document.getElementById("workspace-path");
  const save = document.getElementById("workspace-save");
  const initial = (input?.value || "").trim();
  const hint = (text, kind = "error") => {
    const node = document.getElementById("workspace-hint");
    if (!node) return;
    node.textContent = text;
    node.classList.toggle("is-error", Boolean(text) && kind === "error");
    node.classList.toggle("is-info", Boolean(text) && kind === "info");
    node.hidden = !text;
  };
  const syncDirty = () => {
    // 按钮一直可点（保存同一路径只是空跑一次），只在改过之后多一句「还没保存」
    if ((input?.value || "").trim() !== initial) hint("还没保存", "info");
    else hint("");
  };

  const commit = async () => {
    const value = (input?.value || "").trim();
    if (!value) {
      hint("填一个绝对路径，或者点「选择目录」。");
      input?.focus();
      return;
    }
    hint("");
    try {
      const response = await request("/api/v1/workspaces", {
        method: "POST",
        body: JSON.stringify({ rootPath: value }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        hint(projectErrorText(data, response.status));
        return;
      }
      toast(hasWorkspace ? "根目录已更新" : "工作区已设定");
      await loadProjectsSettings();
    } catch (error) {
      if (error.message !== "forbidden") hint(`没存成：${error.message}`);
    }
  };

  document.getElementById("workspace-pick")?.addEventListener("click", async () => {
    const chosen = await selectDirectory();
    if (!chosen) return; // 取消选择：保留原值
    if (input) input.value = chosen;
    syncDirty();
    save?.focus();
  });
  save?.addEventListener("click", () => void commit());
  input?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void commit();
  });
  input?.addEventListener("input", syncDirty);
  syncDirty();
}

/** 一个项目 = 名字 + 一组文件夹（2026-11-13 项目容器），恰好一个主文件夹。
 *  2026-11-14 第三版：卡头只留一个 ⋯，「添加文件夹 / 重命名 / 归档」全在里面；
 *  行尾同理（见 rootRowMarkup）。整页只剩「⋯」和编辑态的「保存 / 取消」两种动作长相。 */
function projectCardMarkup(project) {
  const archived = Boolean(project.archived);
  const id = attr(project.id);
  const roots = Array.isArray(project.roots) ? project.roots : [];
  const count = roots.length;
  const warnings = [
    project.exists === false ? '<span class="pill-tag warn">主文件夹丢失</span>' : "",
    archived ? '<span class="pill-tag">已归档</span>' : "",
    !archived && isResearchProject(project.id)
      ? '<span class="proj-tag is-research" title="本机界面标记，不影响项目本身">研究</span>'
      : "",
  ]
    .filter(Boolean)
    .join("");
  const rows = roots.map((root) => rootRowMarkup(id, root, archived, count)).join("");
  return `<div class="proj-card${archived ? " is-archived" : ""}" data-project-id="${id}">
    <div class="proj-card-main">
      <div class="proj-card-line">
        <span class="proj-card-title">${esc(project.name)}</span>
        <span class="proj-card-meta">${count || 1} 个文件夹</span>
        ${warnings}
        <span class="proj-card-actions">
          ${
            archived
              ? `<button class="btn-primary is-quiet" type="button" data-project-action="restore" data-project-id="${id}">恢复</button>
                 <button class="btn-primary is-quiet is-danger" type="button" data-project-action="delete"
                         data-project-id="${id}" data-project-name="${attr(project.name)}">删除登记</button>`
              : `<button class="proj-row-more" type="button" aria-haspopup="menu" aria-expanded="false"
                         aria-label="项目动作"
                         data-project-menu data-project-id="${id}" data-project-name="${attr(project.name)}">⋯</button>`
          }
        </span>
      </div>
      <div class="proj-roots">${rows}</div>
      <div class="proj-card-hint" data-project-hint="${id}" hidden></div>
    </div>
  </div>`;
}

/** 一行文件夹：主/附、名字、路径、行尾动作。
 *  主行只有一个 ⋯（改路径）；附加行多一个常驻「设为主」（切换主文件夹要靠它，藏进菜单里没人找得到），
 *  外加 ⋯（改路径 / 从项目移除）。 */
function rootRowMarkup(projectId, root, archived, rootCount = 1) {
  const primary = root.role === "primary";
  const missing = root.exists === false;
  const rid = attr(root.id);
  const promote =
    archived || primary
      ? ""
      : `<button class="btn-primary is-quiet" type="button" data-root-promote
                 data-project-id="${projectId}" data-root-id="${rid}" data-root-label="${attr(root.label)}"
                 title="之后新建的会话在这个文件夹里干活">设为主</button>`;
  const more = archived
    ? ""
    : `<button class="proj-row-more" type="button" aria-haspopup="menu" aria-expanded="false"
               aria-label="文件夹动作"
               data-root-menu data-project-id="${projectId}" data-root-id="${rid}" data-root-label="${attr(root.label)}"
               data-root-primary="${primary ? "1" : "0"}" data-root-count="${rootCount}">⋯</button>`;
  return `<div class="proj-root-row${primary ? " is-primary" : ""}" data-root-row="${rid}">
    <span class="proj-root-label">
      <span class="proj-root-name" title="${attr(root.label)}">${esc(root.label)}</span>
      ${primary ? '<span class="proj-tag">主</span>' : ""}
      ${missing ? '<span class="pill-tag warn">不在了</span>' : ""}
    </span>
    <span class="proj-root-path is-mono${missing ? " is-missing" : ""}" title="${attr(root.path)}">${esc(root.path)}</span>
    <span class="proj-root-acts">${promote}${more}</span>
  </div>`;
}

function renderProjectList(workspace, projects) {
  const box = document.getElementById("project-list");
  if (!box) return;
  closeProjMenu();
  const active = projects.filter((project) => !project.archived);
  const empty = active.length
    ? ""
    : `<div class="set-empty"><div class="set-hint">还没有项目。点右上角「添加项目」。</div></div>`;
  // 归档项目不出现在这一页（2026-11-14）：它是设置左侧「归档」那一页的事，这里不做入口。
  box.innerHTML = `${workspaceRowMarkup(workspace)}${active.map(projectCardMarkup).join("")}${empty}`;

  wireWorkspaceRow(workspace);
  wireProjectActions(box);
}

/* ── 行内 ⋯ 菜单（2026-11-14 按钮统一 B 版）───────────────
   每行只留一个 28×28 的 ⋯，动作收进菜单。菜单挂 document.body + position:fixed，
   跟侧栏文件夹浮卡同一个理由：卡片所在容器可能被 overflow 裁掉，挂在行内会被切。
   点外面 / Esc / 滚动 / 改尺寸都关，同一时刻只开一张。 */
let projMenuState = null;

function closeProjMenu() {
  const open = projMenuState;
  if (!open) return;
  projMenuState = null;
  open.node.remove();
  open.anchor.setAttribute("aria-expanded", "false");
  document.removeEventListener("pointerdown", open.onDown, true);
  window.removeEventListener("keydown", open.onKey, true);
  window.removeEventListener("scroll", closeProjMenu, true);
  window.removeEventListener("resize", closeProjMenu);
}

/** items: [{ label, action, danger?, separator?, kbd? }] */
function openProjMenu(anchor, items, onPick) {
  if (projMenuState?.anchor === anchor) {
    closeProjMenu();
    return;
  }
  closeProjMenu();
  const menu = document.createElement("div");
  menu.className = "proj-menu";
  menu.setAttribute("role", "menu");
  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement("span");
      sep.className = "proj-menu-sep";
      menu.append(sep);
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "proj-menu-item" + (item.danger ? " is-danger" : "");
    button.setAttribute("role", "menuitem");
    button.append(document.createTextNode(item.label));
    if (item.kbd) {
      const kbd = document.createElement("span");
      kbd.className = "proj-menu-kbd";
      kbd.textContent = item.kbd;
      button.append(kbd);
    }
    button.addEventListener("click", () => {
      closeProjMenu();
      onPick(item.action);
    });
    menu.append(button);
  }
  document.body.append(menu);
  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
  let top = rect.bottom + 6;
  if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  anchor.setAttribute("aria-expanded", "true");
  const onDown = (event) => {
    if (!menu.contains(event.target) && event.target !== anchor) closeProjMenu();
  };
  const onKey = (event) => {
    if (event.key !== "Escape") return;
    // 设置页自己也监听 Esc（返回上一级）：菜单先吃掉，别一按 Esc 就整页退出
    event.preventDefault();
    event.stopPropagation();
    closeProjMenu();
  };
  document.addEventListener("pointerdown", onDown, true);
  // window 捕获阶段：抢在设置页自己的 Esc（返回上一级）之前，菜单开着时 Esc 只关菜单
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("scroll", closeProjMenu, true);
  window.addEventListener("resize", closeProjMenu);
  projMenuState = { anchor, node: menu, onDown, onKey };
}

/** 项目卡片动作接线（项目页与归档页共用）：每次 innerHTML 重建后重新挂即可。
 *  `[data-project-action]` 是直接按钮（添加文件夹 / 恢复），
 *  `[data-project-menu]` 与 `[data-root-menu]` 是 ⋯ 菜单的入口，
 *  `[data-root-action]` 只剩编辑态的两个按钮（保存 / 取消）。 */
function wireProjectActions(box) {
  for (const button of box.querySelectorAll("[data-project-action]")) {
    button.addEventListener("click", () => {
      const id = button.dataset.projectId || "";
      const name = button.dataset.projectName || "";
      switch (button.dataset.projectAction) {
        case "rename":
          openRenameProjectModal(id, name);
          break;
        case "archive":
          confirmArchiveProject(id, name);
          break;
        case "restore":
          void doProjectAction(id, "restore");
          break;
        case "delete":
          confirmDeleteProject(id, name);
          break;
        case "add-root":
          openAddRootModal(id, name);
          break;
      }
    });
  }
  for (const button of box.querySelectorAll("[data-project-menu]")) {
    button.addEventListener("click", () => {
      const id = button.dataset.projectId || "";
      const name = button.dataset.projectName || "";
      openProjMenu(
        button,
        [
          { label: "添加文件夹", action: "add-root" },
          {
            label: isResearchProject(id) ? "取消「研究」标记" : "标记为研究项目",
            action: "research",
          },
          { label: "重命名项目", action: "rename", separator: true },
          // 合并（2026-11-25）：PROJECT_MERGE 关着时这一项不进菜单（后端不接，摆出来只会点了报错）
          ...(flagOn("PROJECT_MERGE") ? [{ label: "合并到另一个项目", action: "merge" }] : []),
          { label: "归档项目", action: "archive", danger: true },
        ],
        (action) => {
          if (action === "add-root") openAddRootModal(id, name);
          if (action === "research") {
            const on = toggleResearchProject(id);
            void loadProjectsSettings();
            toast(on ? "已标记为研究项目（只在本机界面显示）" : "已取消研究标记");
          }
          if (action === "rename") openRenameProjectModal(id, name);
          if (action === "merge") void confirmMergeProject(id, name);
          if (action === "archive") confirmArchiveProject(id, name);
        },
      );
    });
  }
  for (const button of box.querySelectorAll("[data-root-menu]")) {
    button.addEventListener("click", () => {
      const projectId = button.dataset.projectId || "";
      const rootId = button.dataset.rootId || "";
      const label = button.dataset.rootLabel || "";
      const primary = button.dataset.rootPrimary === "1";
      const count = Number(button.dataset.rootCount) || 1;
      const items = [{ label: "改路径", action: "path", kbd: "⏎" }];
      // 只剩一个文件夹时不给「移除」：移完这个项目就没有主文件夹了
      if (!primary && count > 1) {
        items.push({ label: "从项目移除", action: "remove", separator: true, danger: true });
      }
      openProjMenu(button, items, (action) => {
        const row = button.closest(".proj-root-row");
        switch (action) {
          case "path":
            if (row) beginRootPathEdit(projectId, rootId, row);
            break;
          case "remove":
            confirmRemoveRoot(projectId, rootId, label);
            break;
        }
      });
    });
  }
  // 「设为主」是常驻按钮（切换主文件夹 = 之后新建会话落在哪个目录，不能藏）
  for (const button of box.querySelectorAll("[data-root-promote]")) {
    button.addEventListener("click", () => {
      void promoteRoot(button.dataset.projectId || "", button.dataset.rootId || "");
    });
  }
  for (const button of box.querySelectorAll("[data-root-action]")) {
    button.addEventListener("click", () => {
      const projectId = button.dataset.projectId || "";
      const rootId = button.dataset.rootId || "";
      const row = button.closest(".proj-root-row");
      switch (button.dataset.rootAction) {
        case "cancel-path":
          void loadProjectsSettings();
          break;
        case "save-path":
          if (row) void saveRootPath(projectId, rootId, row);
          break;
      }
    });
  }
}

/** 项目卡片里的行内提示（每个项目一条，不必弹 toast 也能说清错在哪）。 */
function projectCardHint(projectId, text) {
  const node = document.querySelector(`[data-project-hint="${projectId}"]`);
  if (!node) return;
  node.textContent = text;
  node.classList.toggle("is-error", Boolean(text));
  node.hidden = !text;
}

/** 「改路径」：把这一行的路径换成输入框，并把行尾的 ⋯ 换成「保存 / 取消」两个按钮。
 *  平时不摆一堆输入框——路径只是只读文本，改的时候才切换到编辑态（2026-11-13 定稿）。
 *  2026-11-14：编辑态那一列要装两个按钮，所以给行加 `is-editing`（列宽交给 CSS 改）。 */
function beginRootPathEdit(projectId, rootId, row) {
  closeProjMenu();
  const cell = row.querySelector(".proj-root-path");
  if (!cell) return;
  const input = document.createElement("input");
  input.className = "set-input is-mono proj-path-input is-inline";
  input.type = "text";
  input.spellcheck = false;
  input.value = cell.getAttribute("title") || "";
  input.setAttribute("aria-label", "文件夹路径");
  cell.replaceWith(input);
  const acts = row.querySelector(".proj-root-acts");
  if (acts) {
    acts.innerHTML = `<button class="btn-primary is-quiet" type="button" data-root-action="save-path" data-project-id="${attr(projectId)}" data-root-id="${attr(rootId)}">保存</button>
      <button class="ghost" type="button" data-root-action="cancel-path">取消</button>`;
    wireProjectActions(acts);
  }
  row.classList.add("is-editing");
  input.focus();
  input.select();
}

/** 改某个文件夹的路径（只改登记，不动磁盘）。 */
async function saveRootPath(projectId, rootId, row) {
  const input = row.querySelector("input");
  const value = String(input?.value || "").trim();
  if (!value) {
    projectCardHint(projectId, "填一个绝对路径。");
    input?.focus();
    return;
  }
  projectCardHint(projectId, "");
  try {
    const response = await request(
      `/api/v1/projects/${encodeURIComponent(projectId)}/roots/${encodeURIComponent(rootId)}`,
      { method: "PATCH", body: JSON.stringify({ path: value }) },
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      projectCardHint(projectId, projectErrorText(data, response.status));
      return;
    }
    toast("文件夹路径已更新");
    await loadProjectsSettings();
  } catch (error) {
    if (error.message !== "forbidden") projectCardHint(projectId, `没存成：${error.message}`);
  }
}

/** 设为主文件夹：只影响之后新建的会话，老会话留在原地（方案 D2）。 */
async function promoteRoot(projectId, rootId) {
  try {
    const response = await request(
      `/api/v1/projects/${encodeURIComponent(projectId)}/roots/${encodeURIComponent(rootId)}/promote`,
      { method: "POST" },
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      projectCardHint(projectId, projectErrorText(data, response.status));
      return;
    }
    toast("已设为主文件夹：之后新建的会话落在它这里，老会话留在原地");
    await loadProjectsSettings();
    void refreshProjectPill();
  } catch (error) {
    if (error.message !== "forbidden") projectCardHint(projectId, `没成功：${error.message}`);
  }
}

/** 移除文件夹（二次确认）：只删登记，磁盘不动。 */
function confirmRemoveRoot(projectId, rootId, label) {
  openModal("移除文件夹", (body) => {
    body.innerHTML = `
      <p class="modal-desc">从项目里移除「${esc(label || "这个文件夹")}」的登记。<b>磁盘上的目录和文件不动</b>；这个项目里已经建好的会话也不受影响。</p>
      <div class="modal-actions">
        <button class="ghost" type="button" data-modal-cancel>取消</button>
        <button class="modal-danger" type="button" id="root-remove-confirm">移除</button>
      </div>`;
    body.querySelector("[data-modal-cancel]")?.addEventListener("click", closeModal);
    body.querySelector("#root-remove-confirm")?.addEventListener("click", async () => {
      try {
        const response = await request(
          `/api/v1/projects/${encodeURIComponent(projectId)}/roots/${encodeURIComponent(rootId)}`,
          { method: "DELETE" },
        );
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          toast(projectErrorText(data, response.status));
          return;
        }
        closeModal();
        toast("文件夹已从项目里移除");
        await loadProjectsSettings();
        void refreshProjectPill();
      } catch (error) {
        if (error.message !== "forbidden") toast(`没成功：${error.message}`);
      }
    });
  });
}

/** 给项目再加一个文件夹（绝对路径；附加文件夹不做 `@别名` 改写）。 */
function openAddRootModal(projectId, projectName) {
  openModal("添加文件夹", (body) => {
    body.innerHTML = `
      <p class="modal-desc">给「${esc(projectName)}」再加一个文件夹。填<b>绝对路径</b>（目录先在资源管理器里建好）。相对路径只以主文件夹为基准，附加文件夹一律写绝对路径。</p>
      <label class="modal-field">
        <span>文件夹路径</span>
        <div class="proj-add-row">
          <input class="modal-input is-mono" id="root-add-path" type="text" spellcheck="false" placeholder="例如：<lifediary 手机仓>" />
          ${inShell() ? '<button class="ghost" type="button" id="root-add-pick">选择</button>' : ""}
        </div>
      </label>
      <label class="modal-field">
        <span>显示名（可留空）</span>
        <input class="modal-input" id="root-add-label" type="text" placeholder="默认用目录名" />
      </label>
      <p class="modal-hint" id="root-add-hint"></p>
      <div class="modal-actions">
        <button class="ghost" type="button" data-modal-cancel>取消</button>
        <button class="btn-primary" type="button" id="root-add-confirm">添加</button>
      </div>`;
    const pathInput = body.querySelector("#root-add-path");
    const labelInput = body.querySelector("#root-add-label");
    const hint = body.querySelector("#root-add-hint");
    const show = (text) => {
      hint.textContent = text;
      hint.hidden = !text;
    };
    body.querySelector("[data-modal-cancel]")?.addEventListener("click", closeModal);
    body.querySelector("#root-add-pick")?.addEventListener("click", async () => {
      const chosen = await selectDirectory();
      if (!chosen) return;
      pathInput.value = chosen;
      show("");
    });
    body.querySelector("#root-add-confirm")?.addEventListener("click", async () => {
      const value = String(pathInput?.value || "").trim();
      if (!value) {
        show("填一个绝对路径，或者点「选择」。");
        pathInput?.focus();
        return;
      }
      show("");
      const payload = { path: value };
      const label = String(labelInput?.value || "").trim();
      if (label) payload.label = label;
      try {
        const response = await request(
          `/api/v1/projects/${encodeURIComponent(projectId)}/roots`,
          { method: "POST", body: JSON.stringify(payload) },
        );
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          show(projectErrorText(data, response.status));
          return;
        }
        closeModal();
        toast("文件夹已加进项目");
        await loadProjectsSettings();
        void refreshProjectPill();
      } catch (error) {
        if (error.message !== "forbidden") show(`没成功：${error.message}`);
      }
    });
    pathInput?.focus();
  });
}

/** 项目恢复后的刷新（归档走确认弹窗，这里只处理恢复）。
 *  项目页与归档页共用：按当前设置子页决定刷新哪一份数据。 */
async function doProjectAction(id, action) {
  try {
    const response = await request(`/api/v1/projects/${encodeURIComponent(id)}/${action}`, {
      method: "POST",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      toast(projectErrorText(data, response.status));
      return;
    }
    // 恢复项目只恢复登记；归档是独立动作，会话要单独恢复（方案 §5）
    toast(
      action === "restore"
        ? "项目已恢复；它的会话仍在归档里，需要单独恢复"
        : "已更新",
    );
    // 归档管理 2026-11-18 并进会话页：归档列表的刷新守卫跟着改认 chats
    if (currentSettingsPage() === "chats") await loadArchivePage();
    else await loadProjectsSettings();
    void loadChats();
  } catch (error) {
    if (error.message !== "forbidden") toast(`没成功：${error.message}`);
  }
}

/** 归档项目确认（2026-11-12 归档模块）：软退场，只从列表和派活里收起；
 *  磁盘、历史任务、历史会话都不动；这个项目下新建的会话会一起归档。 */
function confirmArchiveProject(id, name) {
  openModal("归档项目", (body) => {
    // 「新建的会话会一起归档」只在 PROJECT_ARCHIVE_CHATS 开着时成立（2026-11-25）；
    // 关着时删掉这半句，别写一句后端不会做的事。
    const chatsNote = flagOn("PROJECT_ARCHIVE_CHATS") ? "这个项目下新建的会话会一起归档；" : "";
    body.innerHTML = `
      <p class="modal-desc">归档「${esc(name)}」后，它会从项目列表和派活选择里收起。<b>磁盘上的目录和文件不动</b>；历史任务和会话都还在。${chatsNote}更早的会话没有项目归属，仍留在列表里。之后可以在「归档」里恢复项目，会话要单独恢复。</p>
      <p class="modal-hint" id="proj-archive-hint"></p>
      <div class="modal-actions">
        <button class="ghost" type="button" data-modal-cancel>取消</button>
        <button class="modal-danger" type="button" id="proj-archive-confirm">归档项目</button>
      </div>`;
    const hint = body.querySelector("#proj-archive-hint");
    const confirm = body.querySelector("#proj-archive-confirm");
    body.querySelector("[data-modal-cancel]")?.addEventListener("click", closeModal);
    confirm?.addEventListener("click", async () => {
      if (confirm.disabled) return;
      confirm.disabled = true;
      try {
        const response = await request(`/api/v1/projects/${encodeURIComponent(id)}/archive`, {
          method: "POST",
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          setModalHint(hint, projectErrorText(data, response.status));
          confirm.disabled = false;
          return;
        }
        closeModal();
        // archivedChats 为 0 时别假装有会话被一起归档（旧会话没有项目归属，本来就不会动）
        const archivedChats = Number(data.archivedChats) || 0;
        toast(
          archivedChats > 0
            ? `项目已归档，${archivedChats} 个会话一起归档`
            : "项目已归档（磁盘目录保留）",
        );
        // 归档管理 2026-11-18 并进会话页：归档列表的刷新守卫跟着改认 chats
    if (currentSettingsPage() === "chats") await loadArchivePage();
        else await loadProjectsSettings();
        void loadChats();
      } catch (error) {
        if (error.message === "forbidden") {
          closeModal();
          return;
        }
        setModalHint(hint, `没归档成：${error.message}`);
        confirm.disabled = false;
      }
    });
  });
}

/** 删除项目登记确认（2026-11-15；入口只在归档页——活跃项目没有删除，先归档再删）：
 *  只删 SQLite 里的登记行，永久不可恢复；磁盘目录一根手指不动；记忆一条不删；
 *  挂着这个项目的执事由后端一并解除挂载（响应带回条数）。
 *  历史会话不删，留在归档里分组「项目已删除」。 */
function confirmDeleteProject(id, name) {
  openModal("删除项目登记", (body) => {
    body.innerHTML = `
      <p class="modal-desc">永久删除「${esc(name)}」的<b>登记</b>。<b>磁盘上的目录和文件不动</b>；历史会话不删，留在归档里（分组「项目已删除」）。挂着这个项目的执事会一并解除挂载。<b>登记删了不可恢复</b>——重新登记同一个目录会是一个新项目。</p>
      <div class="modal-field"><span>这个项目的记忆</span>
        <select class="modal-input" id="proj-delete-memory">
          <option value="keep">保留（成为孤儿记忆，之后可再迁走）</option>
          <option value="archive">一并封存（不删，只是不再出现）</option>
          <option value="move">迁移到另一个范围</option>
        </select>
      </div>
      <select class="modal-input" id="proj-delete-target" hidden></select>
      <p class="modal-hint" id="proj-delete-hint"></p>
      <div class="modal-actions">
        <button class="ghost" type="button" data-modal-cancel>取消</button>
        <button class="modal-danger" type="button" id="proj-delete-confirm">删除登记</button>
      </div>`;
    const hint = body.querySelector("#proj-delete-hint");
    const confirm = body.querySelector("#proj-delete-confirm");
    const memorySelect = body.querySelector("#proj-delete-memory");
    const targetSelect = body.querySelector("#proj-delete-target");
    body.querySelector("[data-modal-cancel]")?.addEventListener("click", closeModal);

    // 选「迁移」时才去读目标清单（少打一次请求；读失败也让用户能退回保留/封存）
    memorySelect?.addEventListener("change", async () => {
      if (!targetSelect) return;
      if (memorySelect.value !== "move") {
        targetSelect.hidden = true;
        return;
      }
      targetSelect.hidden = false;
      targetSelect.innerHTML = `<option value="">正在读取…</option>`;
      try {
        const response = await request("/api/v1/projects", { cache: "no-store" });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.message || String(response.status));
        const rows = (Array.isArray(data.projects) ? data.projects : []).filter((project) => project.id !== id);
        targetSelect.innerHTML = [
          `<option value="global">我的记忆（全局）</option>`,
          ...rows.map(
            (project) => `<option value="${attr(`project:${project.id}`)}">${esc(project.name)}</option>`,
          ),
        ].join("");
      } catch (error) {
        targetSelect.innerHTML = `<option value="">读不到项目列表</option>`;
        setModalHint(hint, `读不到项目列表：${error.message}`);
      }
    });

    confirm?.addEventListener("click", async () => {
      if (confirm.disabled) return;
      const memory = memorySelect?.value || "keep";
      const into = targetSelect?.value || "";
      if (memory === "move" && !into) {
        setModalHint(hint, "先选一个迁移目标（项目或我的记忆）");
        return;
      }
      confirm.disabled = true;
      try {
        const query = new URLSearchParams({ memory });
        if (memory === "move") query.set("into", into);
        const response = await request(
          `/api/v1/projects/${encodeURIComponent(id)}?${query.toString()}`,
          { method: "DELETE" },
        );
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          setModalHint(hint, projectErrorText(data, response.status));
          confirm.disabled = false;
          return;
        }
        closeModal();
        const detached = Number(data.detachedPartners) || 0;
        const moved = Number(data.memory?.records) || 0;
        const memoryNote =
          memory === "move"
            ? `记忆已迁移 ${moved} 条`
            : memory === "archive"
              ? "记忆已封存"
              : "记忆保留为孤儿";
        toast(
          detached > 0
            ? `登记已删除，${detached} 个执事解除挂载（磁盘保留）· ${memoryNote}`
            : `登记已删除（磁盘保留）· ${memoryNote}`,
        );
        // 入口只在归档页，但接线函数两页共用：按当前页刷新对应那份数据
        // 归档管理 2026-11-18 并进会话页：归档列表的刷新守卫跟着改认 chats
    if (currentSettingsPage() === "chats") await loadArchivePage();
        else await loadProjectsSettings();
        void refreshProjectPill();
      } catch (error) {
        if (error.message === "forbidden") {
          closeModal();
          return;
        }
        setModalHint(hint, `没删成：${error.message}`);
        confirm.disabled = false;
      }
    });
  });
}

/**
 * 合并项目（2026-11-17 项目合并与记忆迁移）：把当前项目并进另一个**活**项目。
 *
 * 服务端顺序是「先搬后删」，跨库无事务；失败可能部分完成，但搬的动作幂等，
 * 再点一次就能补齐。界面把这一点如实写在弹窗里（不假装是原子的）。
 */
async function confirmMergeProject(id, name) {
  let targets = [];
  try {
    const response = await request("/api/v1/projects", { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || String(response.status));
    targets = (Array.isArray(data.projects) ? data.projects : []).filter((project) => project.id !== id);
  } catch (error) {
    toast(`读不到项目列表：${error.message}`);
    return;
  }
  if (targets.length === 0) {
    toast("没有别的项目可以合并（先建一个目标项目）");
    return;
  }
  openModal("合并项目", (body) => {
    body.innerHTML = `
      <p class="modal-desc">把「${esc(name)}」并进另一个项目：<b>文件夹登记、会话归属、执事挂载、记忆全部转过去，然后删掉这个项目的登记</b>。磁盘目录一个都不动。</p>
      <p class="modal-hint">跨三个库执行，不是一次原子操作；万一中途失败，再点一次就能补齐（已经搬过的不会重复搬）。</p>
      <div class="modal-field"><span>并进</span>
        <select class="modal-input" id="proj-merge-target">
          ${targets
            .map((project) => `<option value="${attr(project.id)}">${esc(project.name)}</option>`)
            .join("")}
        </select>
      </div>
      <p class="modal-hint" id="proj-merge-hint"></p>
      <div class="modal-actions">
        <button class="ghost" type="button" data-modal-cancel>取消</button>
        <button class="modal-danger" type="button" id="proj-merge-confirm">合并</button>
      </div>`;
    const hint = body.querySelector("#proj-merge-hint");
    const confirm = body.querySelector("#proj-merge-confirm");
    const select = body.querySelector("#proj-merge-target");
    body.querySelector("[data-modal-cancel]")?.addEventListener("click", closeModal);
    confirm?.addEventListener("click", async () => {
      if (confirm.disabled) return;
      const into = select?.value || "";
      if (!into) return;
      confirm.disabled = true;
      confirm.textContent = "合并中…";
      try {
        const response = await request(`/api/v1/projects/${encodeURIComponent(id)}/merge`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ into }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          setModalHint(hint, projectErrorText(data, response.status));
          confirm.disabled = false;
          confirm.textContent = "合并";
          return;
        }
        closeModal();
        toast(
          `已合并：文件夹 ${Number(data.rootsMoved) || 0} 个、会话 ${Number(data.chatsRebound) || 0} 条、记忆 ${Number(data.memory?.records) || 0} 条`,
        );
        // 归档管理 2026-11-18 并进会话页：归档列表的刷新守卫跟着改认 chats
    if (currentSettingsPage() === "chats") await loadArchivePage();
        else await loadProjectsSettings();
        void refreshProjectPill();
      } catch (error) {
        if (error.message === "forbidden") {
          closeModal();
          return;
        }
        setModalHint(hint, `没合并成：${error.message}`);
        confirm.disabled = false;
        confirm.textContent = "合并";
      }
    });
  });
}


export { PROJECT_ERROR_TEXT, beginRootPathEdit, confirmArchiveProject, confirmDeleteProject, closeProjMenu, confirmRemoveRoot, doProjectAction, loadProjectsSettings, openAddRootModal, openProjMenu, projectCardHint, projectCardMarkup, projectErrorText, promoteRoot, renderProjectList, rootRowMarkup, saveRootPath, settingsWorkspace, wireProjectActions, wireWorkspaceRow, workspaceRowMarkup };
