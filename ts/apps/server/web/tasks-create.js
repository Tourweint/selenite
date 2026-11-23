/**
 * 「新建任务」弹窗（2026-11-22 底层工人统一进池）。
 *
 * 用户口径：从侧栏新建的不是“再开一个宿主助手会话”，而是一件直接交给底层
 * worker 的活；worker 在第二套运行时（独立进程池）里跑。
 *
 * 提交走 `POST /api/v1/agent/tasks`：服务端先分配单号、建任务专线、把这句话
 * 落成真 user 条目，再落单（强制 pool，`DIRECT_TASK_POOL=false` 可回滚）。
 * 成功后直接打开 `task-<单号>` 线程；专线建不起来（没模型）就退回任务中心。
 */

import { openConversation } from "./chat-open.js";
import { esc } from "./markdown.js";
import { request } from "./net.js";
import { applyProjectData, fetchProjectSwitchData } from "./project-switch.js";
import { go } from "./route.js";
import { state } from "./state.js";
import { closeModal, openModal, toast } from "./ui-atoms.js";

/** 项目前置失败的 message 有时是 JSON 字符串（needs_project 契约），拆出人话。 */
function errorText(data) {
  const message = typeof data?.message === "string" ? data.message : "";
  if (!message) return "没派出去，稍后再试";
  try {
    const parsed = JSON.parse(message);
    if (parsed && typeof parsed.message === "string") return parsed.message;
  } catch {
    // 不是 JSON：原样用
  }
  return message;
}

function projectOptions(currentId) {
  const items = Array.isArray(state.switcher?.items) ? state.switcher.items : [];
  if (items.length === 0) {
    return `<option value="">（先选一个项目）</option>`;
  }
  const fallback = currentId || items[0]?.id || "";
  return items
    .map(
      (item) =>
        `<option value="${esc(item.id)}"${item.id === fallback ? " selected" : ""}>${esc(
          item.name || item.id,
        )}${item.missing ? "（目录丢了）" : ""}</option>`,
    )
    .join("");
}

export async function openCreateTaskModal() {
  // 项目清单可能还没拉过：进弹窗先拉一次，失败就只给“默认项目”。
  try {
    const data = await fetchProjectSwitchData();
    if (data) applyProjectData(data);
  } catch {
    // 读不到项目不挡派活：服务端还会按默认项目再判一次
  }
  const currentId = state.switcher?.currentProjectId || "";
  openModal("新建任务", (body) => {
    body.innerHTML = `
      <p class="modal-desc">把要办的事说清楚，直接交给底层 worker（独立进程）。它跑完、需要你拍板或卡住时，会出现在这条任务线程里。</p>
      <label class="modal-field">
        <span>要办的事</span>
        <textarea class="modal-input rm-textarea" id="task-create-text" rows="6"
          placeholder="例：把项目里的 README 过一遍，列出过期命令并改掉；改完跑一遍测试。"></textarea>
      </label>
      <label class="modal-field">
        <span>项目</span>
        <select class="modal-input" id="task-create-project">${projectOptions(currentId)}</select>
      </label>
      <p class="modal-hint" id="task-create-hint" hidden></p>
      <div class="modal-actions">
        <button class="ghost" type="button" data-modal-cancel>取消</button>
        <button class="btn-primary" type="button" id="task-create-go">派出去</button>
      </div>`;
    const text = body.querySelector("#task-create-text");
    const project = body.querySelector("#task-create-project");
    const hint = body.querySelector("#task-create-hint");
    const goButton = body.querySelector("#task-create-go");
    const setHint = (value) => {
      hint.hidden = value === "";
      hint.textContent = value;
    };
    body.querySelector("[data-modal-cancel]")?.addEventListener("click", closeModal);
    const submit = async () => {
      const requirement = String(text?.value ?? "").trim();
      if (!requirement) {
        setHint("先写清楚要办什么。");
        text?.focus();
        return;
      }
      if (!project?.value) {
        setHint("还没有项目；先在侧栏「项目」里选一个或新建一个，再派活。");
        return;
      }
      goButton.disabled = true;
      setHint("正在派出去…");
      try {
        const response = await request("/api/v1/agent/tasks", {
          method: "POST",
          body: JSON.stringify({
            requirement,
            ...(project?.value ? { project: project.value } : {}),
          }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          setHint(errorText(data));
          goButton.disabled = false;
          return;
        }
        closeModal();
        toast("已派出，底层 worker 在独立进程里跑");
        // 任务行下一次轮询就会出现；这里不伪造列表项。
        state.ticketsFetchedAt = 0;
        if (data.conversationReady && data.conversationId) {
          go("chat");
          void openConversation(data.conversationId);
        } else {
          go("tasks");
        }
      } catch (error) {
        setHint(`没派出去：${error.message === "forbidden" ? "鉴权失败" : error.message}`);
        goButton.disabled = false;
      }
    };
    goButton?.addEventListener("click", () => void submit());
    text?.addEventListener("keydown", (event) => {
      // Ctrl/⌘+Enter 发送；普通 Enter 留给换行（任务书通常多行）。
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void submit();
      }
    });
  });
}
