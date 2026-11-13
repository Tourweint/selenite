/**
 * 归档页
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { openDeleteChatModal } from "./archive-delete.js";
import { chatLabel, loadChats } from "./chats-list.js";
import { attr, esc } from "./markdown.js";
import { request } from "./net.js";
import { projectCardMarkup, wireProjectActions } from "./settings-projects.js";
import { toast } from "./ui-atoms.js";


/* ── 归档页（2026-11-12 归档模块；2026-11-13 对齐 ZCode 重做）────
   两类软对象：已归档的会话 / 已归档的项目目录。
   会话卡按项目分组折叠（真实项目名一组；有 projectId 但项目没了 →「项目已删除」；
   没有 projectId →「未归类」），顶部 标题搜索 + 排序 + 项目筛选 叠加生效，
   每组展开首屏 50 条递增；行内 恢复 / 永久删除，组头 全部取消归档。
   页级「全部恢复」退役（组级恢复取代之）；POST /chats/restore 端点保留不删（方案 §1）。
   数据并行取两份：GET /agent/chats/archived?limit=200（服务端按 chat-meta 反查，
   不受活跃列表截断）与 GET /projects?includeArchived=1（前端过滤 archived）。 */
const ARCHIVE_PAGE_SIZE = 50;
const archiveView = {
  chats: [],
  projects: [],
  total: 0,
  seq: 0,
  sort: "archived", // archived = 归档时间倒序（默认）| last = 最后活跃倒序
  project: "", // 项目筛选：空 = 全部；值为 projectName
  open: new Set(), // 展开的分组 key（默认全折叠）
  shown: new Map(), // 分组 key → 已显示条数（递增切片）
};

/** 归档页的时间：YYYY-MM-DD HH:mm；无效 / 缺省返回空串。 */
function archiveTimeText(at) {
  const value = Number(at);
  if (!Number.isFinite(value) || value <= 0) return "";
  const date = new Date(value);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  return `${date.getFullYear()}-${mm}-${dd} ${hh}:${mi}`;
}

/** 分组归属：p:名字 = 真实项目；u = 未归类；d = 项目已删除（有 projectId 但查不到项目）。 */
function archiveGroupOf(chat) {
  const name = String(chat.projectName || "").trim();
  if (name) return { key: `p:${name}`, label: name };
  if (chat.projectId) return { key: "d", label: "项目已删除" };
  return { key: "u", label: "未归类" };
}

/** 排序键：按当前下拉取归档时间或最后活跃；都缺时排最后。 */
function archiveSortAt(chat) {
  const primary = Number(archiveView.sort === "last" ? chat.lastAt : chat.archivedAt);
  if (Number.isFinite(primary) && primary > 0) return primary;
  const fallback = Number(archiveView.sort === "last" ? chat.archivedAt : chat.lastAt);
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 0;
}

/** 项目下拉只列真实项目名（按数据里出现过的 projectName）；「未归类 / 项目已删除」
 *  由分组标签承载，不进下拉（方案 §1）。数据刷新后重建，尽量保留原选中项。 */
function syncArchiveProjectOptions() {
  const select = document.getElementById("archive-project");
  if (!select) return;
  const names = [...new Set(archiveView.chats.map((chat) => String(chat.projectName || "").trim()).filter(Boolean))];
  names.sort((a, b) => a.localeCompare(b, "zh"));
  const previous = archiveView.project;
  const keep = names.includes(previous);
  if (!keep) archiveView.project = "";
  select.replaceChildren(
    new Option("全部项目", ""),
    ...names.map((name) => new Option(name, name)),
  );
  select.value = archiveView.project;
}

async function loadArchivePage() {
  const seq = ++archiveView.seq;
  try {
    const [chatsResponse, projectsResponse] = await Promise.all([
      request("/api/v1/agent/chats/archived?limit=200", { cache: "no-store" }),
      request("/api/v1/projects?includeArchived=1", { cache: "no-store" }),
    ]);
    if (!chatsResponse.ok || !projectsResponse.ok) {
      const bad = !chatsResponse.ok
        ? `会话归档清单 HTTP ${chatsResponse.status}`
        : `项目清单 HTTP ${projectsResponse.status}`;
      throw new Error(bad);
    }
    const chatsData = await chatsResponse.json().catch(() => ({}));
    const projectsData = await projectsResponse.json().catch(() => ({}));
    if (seq !== archiveView.seq) return;
    archiveView.chats = Array.isArray(chatsData.chats) ? chatsData.chats : [];
    // total 可能大于本页 200 条：标题上的数量以服务端 total 为准
    const total = Number(chatsData.total);
    archiveView.total = Number.isFinite(total)
      ? Math.max(total, archiveView.chats.length)
      : archiveView.chats.length;
    archiveView.projects = (Array.isArray(projectsData.projects) ? projectsData.projects : []).filter(
      (project) => project && project.archived,
    );
    syncArchiveProjectOptions();
    renderArchiveChats();
    renderArchiveProjects();
  } catch (error) {
    if (seq !== archiveView.seq) return;
    if (error.message === "forbidden") return;
    renderArchiveLoadError(`读取归档失败：${error.message}`);
  }
}

/** 归档会话卡的当前分组视图：搜索 + 项目筛选叠加生效，组内按排序键倒序，
 *  组间真实项目优先（组内最新一条新的在前），未归类 / 项目已删除固定垫底。
 *  返回 { list, query, project }：筛选状态以下拉/输入框现值为准并同步进 archiveView
 *  （缓存只留给选项重建与组级恢复取数用），调用方据此渲染，避免新旧值错位。 */
function computeArchiveGroups() {
  const query = String(document.getElementById("archive-filter")?.value || "").trim();
  const needle = query.toLowerCase();
  // 排序与项目下拉都以下拉现值为准（change/input 后才重渲，缓存只留给选项重建用）
  const projectSelect = document.getElementById("archive-project");
  if (projectSelect) archiveView.project = projectSelect.value;
  const project = archiveView.project;
  const sortSelect = document.getElementById("archive-sort");
  if (sortSelect) archiveView.sort = sortSelect.value === "last" ? "last" : "archived";
  const chats = archiveView.chats.filter((chat) => {
    if (project && String(chat.projectName || "").trim() !== project) return false;
    if (needle && !`${chat.title || ""} ${chat.firstText || ""}`.toLowerCase().includes(needle)) {
      return false;
    }
    return true;
  });
  const groups = new Map();
  for (const chat of chats) {
    const group = archiveGroupOf(chat);
    if (!groups.has(group.key)) groups.set(group.key, { ...group, chats: [] });
    groups.get(group.key).chats.push(chat);
  }
  const list = [...groups.values()];
  for (const group of list) {
    group.chats.sort((a, b) => archiveSortAt(b) - archiveSortAt(a));
  }
  const rank = (key) => (key === "u" ? 1 : key === "d" ? 2 : 0);
  list.sort((a, b) => {
    const byRank = rank(a.key) - rank(b.key);
    if (byRank) return byRank;
    return archiveSortAt(b.chats[0]) - archiveSortAt(a.chats[0]);
  });
  return { list, query, project };
}

function renderArchiveChats() {
  const box = document.getElementById("archive-chat-list");
  if (!box) return;
  const countEl = document.getElementById("archive-chat-count");
  const { list, query, project } = computeArchiveGroups();
  const filtered = Boolean(query || project);
  if (countEl) {
    const shown = list.reduce((sum, group) => sum + group.chats.length, 0);
    countEl.textContent = filtered
      ? `筛出 ${shown} / ${archiveView.total}`
      : String(archiveView.total);
  }
  if (!archiveView.chats.length) {
    // 空态只说"没有"，操作指引收进标题悬停（界面文案密度口径：解释别常驻）
    box.innerHTML = `<div class="archive-empty" title="在会话列表里点归档图标，就会出现在这里">还没有归档的会话</div>`;
    return;
  }
  if (!list.length) {
    box.innerHTML = `<div class="archive-empty">${
      query ? `没有匹配「${esc(query)}」的归档会话` : "这个项目下没有已归档的会话"
    }</div>`;
    return;
  }
  box.innerHTML = list.map(archiveGroupMarkup).join("");
  wireArchiveChatList(box);
}

function archiveGroupMarkup(group) {
  const open = archiveView.open.has(group.key);
  const shownCount = archiveView.shown.get(group.key) ?? ARCHIVE_PAGE_SIZE;
  const visible = open ? group.chats.slice(0, Math.max(ARCHIVE_PAGE_SIZE, shownCount)) : [];
  const hidden = group.chats.length - visible.length;
  return `<div class="archive-group" data-group-key="${attr(group.key)}">
    <div class="archive-group-head">
      <button class="archive-group-toggle" type="button" aria-expanded="${open}"
              data-group-toggle="${attr(group.key)}">
        <svg class="archive-group-folder" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>
        <span class="archive-group-title" title="${attr(group.label)}">${esc(group.label)}</span>
        <span class="archive-group-count">${group.chats.length}</span>
        <svg class="archive-group-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
      </button>
      <button class="archive-group-restore" type="button" data-group-restore="${attr(group.key)}"
              title="全部取消归档" aria-label="把这组会话全部恢复到列表">${ARCHIVE_ICON_UNDO}</button>
    </div>
    ${
      open
        ? `<div class="archive-group-body">
            <div class="archive-group-card">
              ${visible.map(archiveChatRowMarkup).join("")}
              ${hidden > 0 ? `<button class="ghost archive-more" type="button" data-group-more="${attr(group.key)}">显示更多（还有 ${hidden} 条）</button>` : ""}
            </div>
          </div>`
        : ""
    }
  </div>`;
}

/* 行尾两枚图标（Lucide undo-2 / trash-2）：archive=收起可恢复、trash-2=不可恢复，
   两枚并排时删除用警示色但尺寸同排（删除是高危动作，hover 才显文字）。 */
const ARCHIVE_ICON_UNDO =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/></svg>';
const ARCHIVE_ICON_TRASH =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>';

function archiveChatRowMarkup(chat) {
  const id = attr(chat.conversationId);
  const title = chatLabel(chat);
  const turns = Number(chat.turns) || 0;
  const lastAt = archiveTimeText(chat.lastAt);
  // archivedAt 是归档清单保证的字段；旧数据没有时退回最后一句时间
  const archivedAt = archiveTimeText(chat.archivedAt) || lastAt;
  // 行里的时间跟排序键一致：按归档时间排就显归档时间，按最后活跃排就显最后活跃
  const stamp = archiveView.sort === "last" ? lastAt : archivedAt;
  const stampLabel = archiveView.sort === "last" ? "最后活跃" : "归档于";
  // 项目名不挂行内 pill：分组头已经是项目名，行里再挂一遍是重复信息
  const meta = [turns ? `${turns} 轮` : "", stamp ? `${stampLabel} ${stamp}` : ""]
    .filter(Boolean)
    .join(" · ");
  return `<div class="archive-row">
    <div class="archive-row-main">
      <div class="archive-row-title" title="${attr(title)}">${esc(title)}</div>
      <div class="archive-row-meta">${esc(meta)}</div>
    </div>
    <div class="archive-row-actions">
      <button class="archive-act is-danger" type="button" data-archive-delete="${id}"
              title="永久删除（不可恢复）" aria-label="永久删除会话">${ARCHIVE_ICON_TRASH}</button>
      <button class="ghost archive-restore-btn" type="button" data-archive-restore="${id}"
              title="恢复到列表">恢复</button>
    </div>
  </div>`;
}

function wireArchiveChatList(box) {
  for (const button of box.querySelectorAll("[data-archive-restore]")) {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void restoreArchivedChat(button.dataset.archiveRestore, button);
    });
  }
  for (const button of box.querySelectorAll("[data-archive-delete]")) {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      openDeleteChatModal(button.dataset.archiveDelete);
    });
  }
  for (const button of box.querySelectorAll("[data-group-toggle]")) {
    button.addEventListener("click", () => toggleArchiveGroup(button.dataset.groupToggle));
  }
  for (const button of box.querySelectorAll("[data-group-restore]")) {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void restoreArchiveGroup(button.dataset.groupRestore, button);
    });
  }
  for (const button of box.querySelectorAll("[data-group-more]")) {
    button.addEventListener("click", () => {
      const key = button.dataset.groupMore;
      archiveView.shown.set(key, (archiveView.shown.get(key) ?? ARCHIVE_PAGE_SIZE) + ARCHIVE_PAGE_SIZE);
      renderArchiveChats();
    });
  }
}

function toggleArchiveGroup(key) {
  if (archiveView.open.has(key)) archiveView.open.delete(key);
  else archiveView.open.add(key);
  renderArchiveChats();
}

function renderArchiveProjects() {
  const box = document.getElementById("archive-project-list");
  if (!box) return;
  const countEl = document.getElementById("archive-project-count");
  if (countEl) countEl.textContent = String(archiveView.projects.length);
  // 没有归档项目时整节收起：空的大卡片白占一屏，项目页底部仍有「已归档的项目目录」入口
  const section = document.getElementById("archive-project-section");
  if (section) section.hidden = archiveView.projects.length === 0;
  if (!archiveView.projects.length) {
    box.innerHTML = "";
    return;
  }
  box.innerHTML = archiveView.projects.map(projectCardMarkup).join("");
  wireProjectActions(box);
}

/** 加载失败也要说人话：两张卡都换成同一句可读错误 + 重试，不静默空白。 */
function renderArchiveLoadError(text) {
  const html = `<div class="set-hint is-error">${esc(text)}</div>
    <button class="ghost archive-retry" type="button" data-archive-retry>重试</button>`;
  for (const id of ["archive-chat-list", "archive-project-list"]) {
    const box = document.getElementById(id);
    if (box) box.innerHTML = html;
  }
  for (const button of document.querySelectorAll("[data-archive-retry]")) {
    button.addEventListener("click", () => void loadArchivePage());
  }
  const chatCount = document.getElementById("archive-chat-count");
  const projectCount = document.getElementById("archive-project-count");
  if (chatCount) chatCount.textContent = "";
  if (projectCount) projectCount.textContent = "";
}

async function restoreArchivedChat(id, button) {
  if (!id || button?.disabled) return;
  if (button) button.disabled = true;
  try {
    const response = await request(`/api/v1/agent/chat/${encodeURIComponent(id)}/unarchive`, {
      method: "POST",
    });
    if (!response.ok) throw new Error(String(response.status));
    toast("已恢复到列表");
    await loadArchivePage();
    void loadChats();
  } catch (error) {
    if (button) button.disabled = false;
    if (error.message !== "forbidden") toast(`恢复失败：${error.message}`);
  }
}

/** 组级恢复（对齐 ZCode，2026-11-13）：组内逐条串行调 /unarchive；中途失败停在当前条，
 *  前面恢复的保留，报清剩量。页级「全部恢复」退役，端点 /chats/restore 保留不删（方案 §1）。 */
async function restoreArchiveGroup(key, button) {
  if (button?.disabled) return;
  const group = computeArchiveGroups().list.find((item) => item.key === key);
  if (!group || !group.chats.length) return;
  if (button) button.disabled = true;
  let restored = 0;
  try {
    for (const chat of group.chats) {
      const response = await request(
        `/api/v1/agent/chat/${encodeURIComponent(chat.conversationId)}/unarchive`,
        { method: "POST" },
      );
      if (!response.ok) throw new Error(String(response.status));
      restored += 1;
    }
    toast(`已恢复 ${restored} 个会话`);
    await loadArchivePage();
    void loadChats();
  } catch (error) {
    if (error.message === "forbidden") return;
    const left = group.chats.length - restored;
    toast(
      left > 0
        ? `已恢复 ${restored} 个，剩下 ${left} 个没成功：${error.message}`
        : `恢复失败：${error.message}`,
    );
    await loadArchivePage();
    void loadChats();
  }
}

export { ARCHIVE_ICON_TRASH, ARCHIVE_ICON_UNDO, ARCHIVE_PAGE_SIZE, archiveChatRowMarkup, archiveGroupMarkup, archiveGroupOf, archiveSortAt, archiveTimeText, archiveView, computeArchiveGroups, loadArchivePage, renderArchiveChats, renderArchiveLoadError, renderArchiveProjects, restoreArchiveGroup, restoreArchivedChat, syncArchiveProjectOptions, toggleArchiveGroup, wireArchiveChatList };
