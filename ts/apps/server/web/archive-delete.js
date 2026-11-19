/**
 * 永久删除 / 重命名 / 课题提案列表
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { archiveTimeText, archiveView, loadArchivePage } from "./archive-page.js";
import { chatLabel, loadChats } from "./chats-list.js";
import { attr, esc } from "./markdown.js";
import { request } from "./net.js";
import { clearModalHint, setModalHint } from "./project-modal.js";
import { loadProjectsSettings, projectErrorText } from "./settings-projects.js";
import { closeModal, modalOpen, openModal, toast } from "./ui-atoms.js";


/* ── 永久删除（2026-11-13 对齐 ZCode §4）────────────────
   归档是唯一门槛；预检（GET deletion-preview）→ 名单 + 输入标题确认 → POST delete。
   blocked 时只给原因不给确认框；子树（编辑分叉）整条列出、连根删。 */

/** blocked 原因 → 人话。detail 是服务端的补充说明，有就带上。 */
function archiveDeleteBlockedText(blocked) {
  const detail = String(blocked?.detail || "").trim();
  const reason = String(blocked?.reason || "");
  const base =
    reason === "not-archived"
      ? "这个会话已不在归档里（可能刚被恢复）。先归档才能永久删除。"
      : reason === "busy"
        ? "会话正在运行，请先停止再删除。"
        : reason === "has-branches"
          ? "这条会话下面还有分支，先删子分支再删它。"
          : reason === "chief"
            ? "总管会话不能永久删除。"
            : reason === "task"
              ? "任务会话不能永久删除。"
              : reason === "partner"
                ? "执事与群会话不能永久删除。"
                : reason === "kind"
                  ? "只允许删除普通会话或执事副会话。"
                  : "现在不能删除这个会话。";
  return detail ? `${base}（${detail}）` : base;
}

function openDeleteChatModal(id) {
  if (!id) return;
  const chat = archiveView.chats.find((item) => item.conversationId === id);
  openModal("永久删除", (body) => {
    // 防竞态：预检回来前弹窗被关掉又为另一条打开时，旧响应不许覆盖新内容
    const token = `${id}:${Date.now()}`;
    body.dataset.delToken = token;
    const isStale = () => body.dataset.delToken !== token || !modalOpen();
    body.innerHTML = `<p class="modal-desc">正在读取删除预检…</p>`;
    const renderCancel = (text) => {
      body.innerHTML = `<p class="modal-hint is-error">${esc(text)}</p>
        <div class="modal-actions">
          <button class="ghost" type="button" data-modal-cancel>关闭</button>
        </div>`;
      body.querySelector("[data-modal-cancel]")?.addEventListener("click", closeModal);
    };
    void (async () => {
      let preview;
      try {
        const response = await request(
          `/api/v1/agent/chat/${encodeURIComponent(id)}/deletion-preview`,
          { cache: "no-store" },
        );
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          if (isStale()) return;
          renderCancel(
            data?.message || data?.error || `预检没通过：HTTP ${response.status}`,
          );
          return;
        }
        preview = data;
      } catch (error) {
        if (error.message === "forbidden") return;
        if (isStale()) return;
        renderCancel(`读取删除预检失败：${error.message}`);
        return;
      }
      if (isStale()) return;
      if (preview.blocked) {
        renderCancel(archiveDeleteBlockedText(preview.blocked));
        return;
      }
      const title = String(preview.title || "").trim() || chatLabel(chat || {});
      const subtree = Array.isArray(preview.subtree) ? preview.subtree : [];
      const forks = Math.max(0, subtree.length - 1);
      const estimate = preview.estimate || {};
      const entries = Number(estimate.entries);
      const conversations = Number(estimate.conversations);
      const estimateText = Number.isFinite(entries)
        ? `预计删除 会话 ${Number.isFinite(conversations) ? conversations : subtree.length} 条 / 记录 ${entries} 条；文件、记忆、磁盘不受影响。`
        : "文件、记忆、磁盘不受影响。";
      body.innerHTML = `
        <p class="modal-desc">将永久删除「${esc(title)}」${
          subtree.length > 1 ? `，含 <b>${forks}</b> 条编辑分叉，将一并删除。名单：` : "。名单："
        }</p>
        <div class="del-list">${subtree
          .map((item) => {
            const at = archiveTimeText(item.lastAt) || archiveTimeText(item.archivedAt);
            return `<div class="del-row">
              <span class="del-row-title" title="${attr(chatLabel(item))}">${esc(chatLabel(item))}</span>
              ${at ? `<span class="del-row-at">最后一句 ${at}</span>` : ""}
            </div>`;
          })
          .join("")}</div>
        <p class="modal-hint">${esc(estimateText)}<b>删除不可恢复。</b></p>
        <input class="modal-input" id="del-confirm-input" type="text" spellcheck="false"
               placeholder="输入会话标题确认" aria-label="输入会话标题确认" />
        <p class="modal-hint" id="del-hint"></p>
        <div class="modal-actions">
          <button class="ghost" type="button" data-modal-cancel>取消</button>
          <button class="modal-danger" type="button" id="del-confirm" disabled>永久删除</button>
        </div>`;
      const input = body.querySelector("#del-confirm-input");
      const hint = body.querySelector("#del-hint");
      const confirm = body.querySelector("#del-confirm");
      body.querySelector("[data-modal-cancel]")?.addEventListener("click", closeModal);
      input?.addEventListener("input", () => {
        clearModalHint(hint);
        confirm.disabled = input.value.trim() !== title;
      });
      input?.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !confirm.disabled) confirm.click();
      });
      confirm?.addEventListener("click", async () => {
        if (confirm.disabled) return;
        confirm.disabled = true;
        try {
          const response = await request(`/api/v1/agent/chat/${encodeURIComponent(id)}/delete`, {
            method: "POST",
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) {
            setModalHint(hint, data?.message || data?.error || `删除没成功：HTTP ${response.status}`);
            confirm.disabled = false;
            return;
          }
          closeModal();
          const deleted = data.deleted || {};
          toast(
            `已永久删除（会话 ${Number(deleted.conversations) || 1} 条 / 记录 ${Number(deleted.entries) || 0} 条）`,
          );
          await loadArchivePage();
          void loadChats();
        } catch (error) {
          if (error.message === "forbidden") {
            closeModal();
            return;
          }
          setModalHint(hint, `删除没成功：${error.message}`);
          confirm.disabled = false;
        }
      });
      input?.focus();
    })();
  });
}

/** 改名弹窗（与既有「新建项目待确认」同风格）：只改登记名，不动磁盘。 */
function openRenameProjectModal(id, name) {
  openModal("项目改名", (body) => {
    body.innerHTML = `
      <p class="modal-desc">只改登记里的名字，不改动磁盘目录。</p>
      <input class="modal-input" id="proj-rename-input" type="text" maxlength="60" value="${attr(name)}" spellcheck="false" />
      <p class="modal-hint" id="proj-rename-hint"></p>
      <div class="modal-actions">
        <button class="ghost" type="button" data-modal-cancel>取消</button>
        <button class="btn-primary" type="button" id="proj-rename-save">保存</button>
      </div>`;
    const input = body.querySelector("#proj-rename-input");
    const hint = body.querySelector("#proj-rename-hint");
    const save = body.querySelector("#proj-rename-save");
    body.querySelector("[data-modal-cancel]")?.addEventListener("click", closeModal);
    input?.addEventListener("input", () => clearModalHint(hint));
    input?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        save?.click();
      }
    });
    save?.addEventListener("click", async () => {
      if (save.disabled) return;
      const next = String(input.value || "").trim();
      if (!next) {
        setModalHint(hint, "项目名不能为空");
        return;
      }
      save.disabled = true;
      try {
        const response = await request(`/api/v1/projects/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify({ name: next }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          setModalHint(hint, projectErrorText(data, response.status));
          save.disabled = false;
          return;
        }
        closeModal();
        toast("已改名");
        await loadProjectsSettings();
      } catch (error) {
        if (error.message === "forbidden") {
          closeModal();
          return;
        }
        setModalHint(hint, `没改成功：${error.message}`);
        save.disabled = false;
      }
    });
  });
}

function renderProposalList(proposals) {
  const box = document.getElementById("proposal-list");
  if (!box) return;
  // 2026-11-14：没有待确认请求时整块不出现（以前是一个常驻空卡 + 一句解释，纯占地方）。
  if (!proposals.length) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  box.hidden = false;
  box.innerHTML = proposals
    .map(
      (proposal) => `<div class="proposal-card">
        <div class="proposal-card-main">
          <div class="proj-card-title">${esc(proposal.name)}</div>
          <div class="proj-card-path">${esc(proposal.relativePath)}</div>
        </div>
        <div class="proposal-actions">
          <button class="btn-primary is-quiet" type="button" data-proposal-confirm="${esc(proposal.id)}">确认</button>
          <button class="ghost" type="button" data-proposal-reject="${esc(proposal.id)}">拒绝</button>
        </div>
      </div>`,
    )
    .join("");

  for (const button of box.querySelectorAll("[data-proposal-confirm]")) {
    button.addEventListener("click", () => void decideProjectProposal(button.dataset.proposalConfirm, "confirm"));
  }
  for (const button of box.querySelectorAll("[data-proposal-reject]")) {
    button.addEventListener("click", () => void decideProjectProposal(button.dataset.proposalReject, "reject"));
  }
}

async function decideProjectProposal(id, action) {
  const box = document.getElementById("proposal-list");
  for (const button of box ? box.querySelectorAll("button") : []) button.disabled = true;
  try {
    const response = await request(`/api/v1/projects/${encodeURIComponent(id)}/${action}`, {
      method: "POST",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      toast(projectErrorText(data, response.status));
      await loadProjectsSettings();
      return;
    }
    toast(action === "confirm" ? "已确认并登记" : "已拒绝");
    await loadProjectsSettings();
  } catch (error) {
    if (error.message !== "forbidden") toast(`没处理成：${error.message}`);
    await loadProjectsSettings();
  }
}

export { archiveDeleteBlockedText, decideProjectProposal, openDeleteChatModal, openRenameProjectModal, renderProposalList };
