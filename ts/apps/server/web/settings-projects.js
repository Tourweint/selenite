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
import { currentSettingsPage, go } from "./route.js";
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
  project_in_flight: "这个项目还有没跑完的任务，先取消或等任务完结，再归档。",
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
const REPLACE_WORKSPACE_WARNING = "更换根目录会清空当前项目选择（回到主工作区）。";

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

/** 工作区根行（2026-11-12 与项目行同一种卡片）：路径可改，默认目录用标签标出。 */
function workspaceRowMarkup(workspace) {
  const hasWorkspace = Boolean(workspace);
  const tip = hasWorkspace
    ? "工作区根是默认目录。项目和它平级，可以放在任意位置；所有已登记目录助手都能读写。更换根目录会清空当前项目选择（回到主工作区）。"
    : "还没有设定。先选一个代码目录或空目录；之后可以添加任意位置的项目目录。";
  return `<div class="proj-card is-workspace" id="workspace-card">
    <div class="proj-card-main">
      <div class="proj-card-line">
        <span class="proj-card-title" data-tip="${attr(tip)}">工作区根目录</span>
        <input class="set-input is-mono proj-path-input" id="workspace-path" type="text" spellcheck="false"
               aria-label="工作区根目录" placeholder="例如：D:/Projects"
               value="${hasWorkspace ? attr(workspace.rootPath) : ""}" />
        <span class="proj-card-vcs">默认目录</span>
        ${inShell() ? '<button class="ghost" type="button" id="workspace-pick">选择</button>' : ""}
        <button class="btn-primary" type="button" id="workspace-save">${hasWorkspace ? "保存" : "设定"}</button>
      </div>
      <div class="proj-card-note">没有项目时，助手在这里干活。它不是项目（没有名字、不能加文件夹），所以不在下面的列表里。</div>
      <div class="proj-card-hint" id="workspace-hint" hidden></div>
    </div>
  </div>`;
}

function wireWorkspaceRow(workspace) {
  const hasWorkspace = Boolean(workspace);
  const input = document.getElementById("workspace-path");
  const hint = (text) => {
    const node = document.getElementById("workspace-hint");
    if (!node) return;
    node.textContent = text;
    node.classList.toggle("is-error", Boolean(text) && text !== REPLACE_WORKSPACE_WARNING);
    node.hidden = !text;
  };
  // 编辑根目录时才提醒「会清空当前项目选择」——这条直接影响操作后果，值得当面说。
  const restoreHint = () => hint(hasWorkspace ? REPLACE_WORKSPACE_WARNING : "");

  document.getElementById("workspace-pick")?.addEventListener("click", async () => {
    const chosen = await selectDirectory();
    if (!chosen) return; // 取消选择：保留原值
    input.value = chosen;
    restoreHint();
  });
  input?.addEventListener("input", restoreHint);
  document.getElementById("workspace-save")?.addEventListener("click", async () => {
    const value = input.value.trim();
    if (!value) {
      hint("填一个绝对路径，或者点「选择」。");
      input.focus();
      return;
    }
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
  });
}

/** 一个项目 = 名字 + 一组文件夹（2026-11-13 项目容器），恰好一个主文件夹。
 *  文件夹行里的动作**一律是按钮**（`.ghost.is-mini`），不用裸文字当按钮。 */
function projectCardMarkup(project) {
  const archived = Boolean(project.archived);
  const id = attr(project.id);
  const roots = Array.isArray(project.roots) ? project.roots : [];
  const count = roots.length;
  const vcs = project.vcs === "git" ? "git" : "无版本控制";
  const warnings = [
    project.exists === false ? '<span class="pill-tag warn">主文件夹丢失</span>' : "",
    archived ? '<span class="pill-tag">已归档</span>' : "",
  ]
    .filter(Boolean)
    .join("");
  const rows = roots.map((root) => rootRowMarkup(id, root, archived)).join("");
  return `<div class="proj-card${archived ? " is-archived" : ""}" data-project-id="${id}">
    <div class="proj-card-main">
      <div class="proj-card-line">
        <span class="proj-card-title">${esc(project.name)}</span>
        <span class="proj-card-meta">${count || 1} 个文件夹 · ${vcs}</span>
        ${warnings}
        <span class="proj-card-actions">
          ${
            archived
              ? `<button class="ghost" type="button" data-project-action="restore" data-project-id="${id}">恢复</button>`
              : `<button class="ghost" type="button" data-project-action="add-root" data-project-id="${id}" data-project-name="${attr(project.name)}">添加文件夹</button>
                 <button class="ghost" type="button" data-project-action="rename" data-project-id="${id}" data-project-name="${attr(project.name)}">改名</button>
                 <button class="ghost" type="button" data-project-action="archive" data-project-id="${id}" data-project-name="${attr(project.name)}">归档项目</button>`
          }
        </span>
      </div>
      <div class="proj-roots">${rows}</div>
      <div class="proj-card-hint" data-project-hint="${id}" hidden></div>
    </div>
  </div>`;
}

/** 一行文件夹：主/附、名字、路径、动作。归档态只读，不给动作。 */
function rootRowMarkup(projectId, root, archived) {
  const primary = root.role === "primary";
  const missing = root.exists === false;
  const rid = attr(root.id);
  const acts = archived
    ? ""
    : `<span class="proj-root-acts">
        <button class="ghost is-mini" type="button" data-root-action="path" data-project-id="${projectId}" data-root-id="${rid}">改路径</button>
        ${
          primary
            ? ""
            : `<button class="ghost is-mini" type="button" data-root-action="promote" data-project-id="${projectId}" data-root-id="${rid}">设为主</button>
               <button class="ghost is-mini" type="button" data-root-action="remove" data-project-id="${projectId}" data-root-id="${rid}" data-root-label="${attr(root.label)}">移除</button>`
        }
      </span>`;
  return `<div class="proj-root-row${primary ? " is-primary" : ""}" data-root-row="${rid}">
    <span class="proj-root-dot" aria-hidden="true"></span>
    <span class="proj-root-label" title="${attr(root.label)}">${esc(root.label)}${primary ? '<span class="proj-tag">主</span>' : ""}</span>
    <span class="proj-root-path is-mono${missing ? " is-missing" : ""}" title="${attr(root.path)}">${esc(root.path)}</span>
    ${missing ? '<span class="pill-tag warn">不在了</span>' : ""}
    ${acts}
  </div>`;
}

function renderProjectList(workspace, projects) {
  const box = document.getElementById("project-list");
  if (!box) return;
  const active = projects.filter((project) => !project.archived);
  const archivedCount = projects.length - active.length;
  const empty = active.length
    ? ""
    : `<div class="set-empty">
        <div class="set-card-title">还没有项目</div>
        <div class="set-hint">点右上角「添加项目」登记一个已有目录；项目可以在任意位置，不要求在工作区下面。一个项目可以再加多个文件夹，其中一个是主文件夹。</div>
      </div>`;
  // 归档项目不再在这里展开折叠区（2026-11-12 归档模块）：只留一行入口指向归档页。
  box.innerHTML = `${workspaceRowMarkup(workspace)}${active.map(projectCardMarkup).join("")}${empty}
    <div class="proj-archive-entry">
      <span>已归档的项目目录（${archivedCount}）</span>
      <button class="ghost" type="button" id="project-open-archive">查看归档</button>
    </div>`;

  wireWorkspaceRow(workspace);
  wireProjectActions(box);
  document
    .getElementById("project-open-archive")
    ?.addEventListener("click", () => go("settings", "archive"));
}

/** 项目卡片动作接线（项目页与归档页共用）：每次 innerHTML 重建后重新挂即可。
 *  `[data-project-action]` 是项目级，`[data-root-action]` 是文件夹行级。 */
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
        case "add-root":
          openAddRootModal(id, name);
          break;
      }
    });
  }
  for (const button of box.querySelectorAll("[data-root-action]")) {
    button.addEventListener("click", () => {
      const projectId = button.dataset.projectId || "";
      const rootId = button.dataset.rootId || "";
      const row = button.closest(".proj-root-row");
      switch (button.dataset.rootAction) {
        case "path":
          if (row) beginRootPathEdit(projectId, rootId, row);
          break;
        case "cancel-path":
          void loadProjectsSettings();
          break;
        case "save-path":
          if (row) void saveRootPath(projectId, rootId, row);
          break;
        case "promote":
          void promoteRoot(projectId, rootId);
          break;
        case "remove":
          confirmRemoveRoot(projectId, rootId, button.dataset.rootLabel || "");
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

/** 「改路径」：把这一行的路径换成输入框，并把动作换成「保存 / 取消」两个按钮。
 *  平时不摆四个输入框——路径只是只读文本，改的时候才切换到编辑态（2026-11-13 定稿）。 */
function beginRootPathEdit(projectId, rootId, row) {
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
    acts.innerHTML = `<button class="ghost is-mini" type="button" data-root-action="save-path" data-project-id="${attr(projectId)}" data-root-id="${attr(rootId)}">保存</button>
      <button class="ghost is-mini" type="button" data-root-action="cancel-path">取消</button>`;
    wireProjectActions(acts);
  }
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
    if (currentSettingsPage() === "archive") await loadArchivePage();
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
    body.innerHTML = `
      <p class="modal-desc">归档「${esc(name)}」后，它会从项目列表和派活选择里收起。<b>磁盘上的目录和文件不动</b>；历史任务和会话都还在。这个项目下新建的会话会一起归档；更早的会话没有项目归属，仍留在列表里。之后可以在「归档」里恢复项目，会话要单独恢复。</p>
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
        if (currentSettingsPage() === "archive") await loadArchivePage();
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

export { PROJECT_ERROR_TEXT, REPLACE_WORKSPACE_WARNING, beginRootPathEdit, confirmArchiveProject, confirmRemoveRoot, doProjectAction, loadProjectsSettings, openAddRootModal, projectCardHint, projectCardMarkup, projectErrorText, promoteRoot, renderProjectList, rootRowMarkup, saveRootPath, settingsWorkspace, wireProjectActions, wireWorkspaceRow, workspaceRowMarkup };
