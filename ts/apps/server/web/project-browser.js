/**
 * 文件浏览器与项目菜单
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { el } from "./dom.js";
import { request } from "./net.js";
import { baseNameOf, closeProjectMenu, openAddProjectModal, openAddWorkspaceModal } from "./project-modal.js";
import { SERVICE_TOO_OLD_HINT, openExplorerInOs, projActionButton, projectIcon, selectProject } from "./project-switch.js";
import { state } from "./state.js";
import { openModal } from "./ui-atoms.js";

function openFileBrowser(projectName, startRel, rootLabel, projectId = "", rootId = "") {
  const browser = { name: projectName, rel: startRel || "", projectId, rootId };
  const base = rootLabel || projectName;
  const projectQuery = browser.projectId
    ? `&projectId=${encodeURIComponent(browser.projectId)}` +
      (browser.rootId ? `&rootId=${encodeURIComponent(browser.rootId)}` : "")
    : "";
  const crumbOf = (rel) => (rel ? `${base}/${rel}` : `${base}/`);
  openModal(`文件 · ${projectName}`, (body) => {
    body.classList.add("file-browser");
    const bar = document.createElement("div");
    bar.className = "fb-bar";
    const up = document.createElement("button");
    up.type = "button";
    up.className = "ghost fb-up";
    up.textContent = "上一级";
    const crumb = document.createElement("span");
    crumb.className = "fb-crumb";
    bar.append(up, crumb);
    const list = document.createElement("div");
    list.className = "fb-list";
    const viewer = document.createElement("pre");
    viewer.className = "fb-view";
    viewer.hidden = true;
    body.append(bar, list, viewer);

    const parentOf = (rel) => {
      const idx = rel.lastIndexOf("/");
      return idx === -1 ? "" : rel.slice(0, idx);
    };

    up.addEventListener("click", () => {
      if (viewer.hidden) {
        if (browser.rel) load(parentOf(browser.rel));
      } else {
        // 从正文退回列表：面包屑要跟着退回目录，不能停在文件名上
        viewer.hidden = true;
        list.hidden = false;
        crumb.textContent = crumbOf(browser.rel);
      }
    });

    const entryPath = (name) => (browser.rel ? `${browser.rel}/${name}` : name);

    async function load(rel) {
      browser.rel = rel;
      viewer.hidden = true;
      list.hidden = false;
      crumb.textContent = crumbOf(rel);
      up.disabled = !rel;
      list.replaceChildren();
      const loading = document.createElement("div");
      loading.className = "fb-empty";
      loading.textContent = "读取中…";
      list.append(loading);
      try {
        const response = await request(`/api/v1/files?path=${encodeURIComponent(rel)}${projectQuery}`, {
          cache: "no-store",
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) {
          loading.textContent =
            response.status === 404
              ? SERVICE_TOO_OLD_HINT
              : data.message || `读不到（HTTP ${response.status}）`;
          return;
        }
        list.replaceChildren();
        if (!data.entries.length) {
          const empty = document.createElement("div");
          empty.className = "fb-empty";
          empty.textContent = "空目录";
          list.append(empty);
          return;
        }
        for (const entry of data.entries) {
          const row = document.createElement("button");
          row.type = "button";
          row.className = `fb-row is-${entry.type}`;
          const name = document.createElement("span");
          name.className = "fb-name";
          name.textContent = entry.type === "dir" ? `${entry.name}/` : entry.name;
          const meta = document.createElement("span");
          meta.className = "fb-meta";
          meta.textContent = entry.type === "dir" ? "目录" : `${entry.size} 字节`;
          row.append(name, meta);
          row.addEventListener("click", () => {
            if (entry.type === "dir") load(entryPath(entry.name));
            else view(entryPath(entry.name), entry.size);
          });
          list.append(row);
        }
      } catch (error) {
        loading.textContent =
          error.message === "forbidden" ? "没有权限" : "读不到文件列表，重启服务后再试";
      }
    }

    async function view(path, size) {
      list.hidden = true;
      viewer.hidden = false;
      viewer.textContent = "读取中…";
      crumb.textContent = crumbOf(path);
      try {
        const response = await request(
          `/api/v1/files/content?path=${encodeURIComponent(path)}${projectQuery}`,
          { cache: "no-store" },
        );
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) {
          viewer.textContent =
            response.status === 404
              ? SERVICE_TOO_OLD_HINT
              : data.message || `读不到（HTTP ${response.status}）`;
          return;
        }
        if (data.content === null) {
          viewer.textContent =
            data.truncated && data.size > 524288
              ? `文件过大（${data.size} 字节），不预览正文`
              : "二进制文件，不预览正文";
          return;
        }
        viewer.textContent = data.content;
      } catch (error) {
        viewer.textContent = error.message === "forbidden" ? "没有权限" : "读不到文件内容";
      }
    }

    load(browser.rel);
  });
}

/** 弹层内容：工作区根（默认目录）+ 项目总览 + 底部「添加项目 · 设置工作区根目录 · 管理项目」。
 *  行本身仍只读总览；行尾两颗小钮是文件入口（2026-11-06 文件浏览入口）。
 *
 *  2026-11-12 多根语义：工作区根与项目是**平级目录**，项目可以在任意位置；
 *  所有已登记目录都在助手可读写范围内（回滚开关见 PROJECT_OUTSIDE_WORKSPACE）。 */
function renderProjectMenu(items) {
  const menu = el.projectMenu;
  if (!menu) return;
  menu.replaceChildren();
  const workspace = state.switcher.workspace;
  const hasWorkspace = Boolean(workspace?.rootPath);

  // 2026-11-16 用户拍板：工作区要在弹层里看得见（<主工作区> 这类默认目录）——
  // 它不是项目；点它 = 回工作区（取消当前项目），和展开态侧栏那一行同一语义。
  if (hasWorkspace) {
    const ws = document.createElement("button");
    ws.type = "button";
    ws.className = "proj-ws";
    ws.title = `${workspace.rootPath}（普通对话的默认落点）`;
    const label = document.createElement("span");
    label.className = "proj-ws-label";
    label.textContent = "主工作区 · 默认对话";
    const name = document.createElement("span");
    name.className = "proj-ws-name";
    name.textContent = baseNameOf(workspace.rootPath) || "工作区";
    const path = document.createElement("span");
    path.className = "proj-ws-path is-mono";
    path.textContent = workspace.rootPath;
    path.title = workspace.rootPath;
    ws.append(label, name, path);
    ws.addEventListener("click", () => {
      closeProjectMenu();
      void selectProject(null);
    });
    menu.append(ws);
  }

  // 2026-11-13：工作区根不再占「项目」列表的一行（它只是杂事态的默认目录，
  // 不是项目）；位置在 设置 → 项目 的第一块。收起轨道的弹层沿用同一口径。
  if (!hasWorkspace) {
    const empty = document.createElement("div");
    empty.className = "proj-empty";
    empty.textContent = "还没有工作区。先设置工作区根目录，项目才能登记进来。";
    menu.append(empty);
  }

  if (items.length) {
    const sep = document.createElement("div");
    sep.className = "proj-sep";
    sep.setAttribute("role", "none");
    menu.append(sep);
  }

  for (const project of items) {
    if (!hasWorkspace) break;
    const row = document.createElement("div");
    row.className = "proj-item is-static is-sub";
    row.title = project.rootPath || project.name;
    const name = document.createElement("span");
    name.className = "proj-item-name";
    name.textContent = project.name;
    row.append(projectIcon("sub"), name);
    if (project.roots?.length) {
      const count = document.createElement("span");
      count.className = "proj-tag";
      count.textContent = `${project.roots.length} 个文件夹`;
      row.append(count);
    }
    if (project.missing) {
      const tag = document.createElement("span");
      tag.className = "proj-tag is-warn";
      tag.textContent = "主文件夹不在了";
      row.append(tag);
    } else {
      row.append(
        projActionButton("browse", "浏览文件", `在界面里看「${project.name}」的文件夹`, () =>
          openFileBrowser(project.name, "", project.name, project.id),
        ),
        projActionButton("explorer", "在资源管理器中打开", `在系统的文件资源管理器里打开「${project.name}」的主文件夹`, () =>
          openExplorerInOs(project.id),
        ),
      );
    }
    menu.append(row);
  }

  if (hasWorkspace && !items.length) {
    const empty = document.createElement("div");
    empty.className = "proj-empty";
    empty.textContent = "还没有项目。";
    menu.append(empty);
  }

  // 底部只留两个动作（2026-11-13 再减字）：平级目录的说明与「管理项目 → 设置」
  // 都退役——说明收进展开态分区头的 data-tip，管理走设置页侧栏。
  const foot = document.createElement("div");
  foot.className = "proj-foot";

  // 添加项目：没有工作区时置灰，title 指明先去设置工作区
  const addSub = document.createElement("button");
  addSub.type = "button";
  addSub.className = "proj-manage";
  addSub.textContent = "添加项目";
  if (hasWorkspace) {
    addSub.addEventListener("click", () => {
      closeProjectMenu();
      openAddProjectModal();
    });
  } else {
    addSub.setAttribute("aria-disabled", "true");
    addSub.title = "先设置工作区根目录";
  }

  const addMain = document.createElement("button");
  addMain.type = "button";
  addMain.className = "proj-manage";
  addMain.textContent = "设置工作区根目录";
  addMain.title = hasWorkspace ? "更换默认工作区目录" : "设定默认工作区目录";
  addMain.addEventListener("click", () => {
    closeProjectMenu();
    openAddWorkspaceModal();
  });

  foot.append(addSub, addMain);
  menu.append(foot);
}

export { openFileBrowser, renderProjectMenu };
