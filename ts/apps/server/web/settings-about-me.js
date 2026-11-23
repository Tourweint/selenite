/**
 * 设置 → 关于我（2026-11-19）
 *
 * 全局一份的主人档案：每轮作为 system 段注入给会读它的 Agent，不进记忆、不参与召回。
 * 编辑入口在这里；「谁读」按 Agent 一行一个开关（总管 + 在职执事），普通 worker 固定不读。
 * 端点：GET/PUT /api/v1/agent/user-profile、PUT /api/v1/agent/user-profile/agents/:id。
 *
 * 页面只做三件事：改正文、保存、切开关。上下文是否真的注入了，去
 * 设置 → 注入 → 上下文 看 `user_profile` 段（默认开销与当前会话两处都会显示）。
 */

import { esc } from "./markdown.js";
import { request } from "./net.js";
import { sectionMarkup, setSwitchChecked, switchMarkup } from "./settings-atoms.js";
import { toast } from "./ui-atoms.js";

const UP_ENDPOINT = "/api/v1/agent/user-profile";
const UP_PLACEHOLDER = [
  "比如：",
  "我常用语音输入，文字里可能有识别错字：先按意思理解，不确定再问。",
  "称呼我「……」。",
  "不要……（说话 / 做事上的禁忌）。",
].join("\n");

function upBytes(text) {
  return new TextEncoder().encode(String(text ?? "")).length;
}

function upAgentRow(agent) {
  const kind = agent.kind === "partner" ? '<span class="set-hint"> · 执事</span>' : "";
  return `<div class="row" data-up-agent="${esc(agent.id)}">
    <div class="row-main">
      <div class="row-label">${esc(agent.name)}${kind}</div>
    </div>
    <div class="row-control">${switchMarkup(agent.read, {
      label: `${agent.name}是否读取「关于我」`,
      attrs: `data-up-switch="${esc(agent.id)}"`,
    })}</div>
  </div>`;
}

function upWorkerRow() {
  return `<div class="row">
    <div class="row-main">
      <div class="row-label">普通 worker<span class="set-hint"> · 固定不读</span></div>
    </div>
    <div class="row-control">${switchMarkup(false, {
      label: "普通 worker 不读「关于我」",
      attrs: "disabled",
    })}</div>
  </div>`;
}

export function aboutMeMarkup() {
  return `${sectionMarkup(
    "关于我",
    `<div class="card pf-panel">
      <p class="set-hint">每轮作为系统提示词注入给会读它的 Agent；不进记忆、不参与召回。改完下一轮生效。</p>
      <textarea class="pf-soul" id="up-text" spellcheck="false" aria-label="关于我"
                placeholder="${esc(UP_PLACEHOLDER)}"></textarea>
      <div class="pf-foot">
        <span class="pf-sec-note" id="up-count">0 / 8192 字节</span>
        <button class="ghost" type="button" id="up-reset" disabled>撤销</button>
        <button class="btn-primary" type="button" id="up-save" disabled>保存</button>
      </div>
      <p class="pf-hint" id="up-hint"></p>
    </div>`,
  )}${sectionMarkup(
    "谁读这份档案",
    `<div class="card pf-panel">
      <div id="up-agents"><div class="set-hint">读取中…</div></div>
      <p class="pf-hint">开关下一轮生效。普通 worker 与派活工人固定不读。</p>
      <p class="pf-hint"><a href="#/settings/context">去 设置 → 注入 → 上下文 看实际注入</a></p>
    </div>`,
  )}`;
}

async function upReadPayload() {
  const response = await request(UP_ENDPOINT, { cache: "no-store" });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
    throw new Error(data?.message || "读取失败");
  }
  return data;
}

/** 页面接线：一次拉取，正文本地编辑；开关点一下立刻落库，失败回滚。 */
export async function wireAboutMe() {
  const text = document.getElementById("up-text");
  const count = document.getElementById("up-count");
  const hint = document.getElementById("up-hint");
  const save = document.getElementById("up-save");
  const reset = document.getElementById("up-reset");
  const agentsBox = document.getElementById("up-agents");
  if (!text || !count || !save || !reset || !agentsBox) return;

  let initial = "";
  let limit = 8192;
  let editable = true;

  const paintCount = () => {
    const bytes = upBytes(text.value);
    count.textContent = `${bytes} / ${limit} 字节`;
    count.classList.toggle("is-error", bytes > limit);
  };
  const paintDirty = () => {
    const dirty = text.value !== initial;
    save.disabled = !editable || !dirty || upBytes(text.value) > limit;
    reset.disabled = !editable || !dirty;
    paintCount();
  };

  const paintAgents = (agents) => {
    agentsBox.innerHTML = agents.length
      ? agents.map(upAgentRow).join("") + upWorkerRow()
      : upWorkerRow();
    for (const button of agentsBox.querySelectorAll("[data-up-switch]")) {
      button.addEventListener("click", async () => {
        const id = button.dataset.upSwitch;
        const next = button.getAttribute("aria-checked") !== "true";
        const previous = !next;
        button.disabled = true;
        setSwitchChecked(button, next);
        try {
          const response = await request(`${UP_ENDPOINT}/agents/${encodeURIComponent(id)}`, {
            method: "PUT",
            body: JSON.stringify({ read: next }),
          });
          const data = await response.json().catch(() => null);
          if (!response.ok || !data) throw new Error(data?.message || "保存失败");
          paintAgents(data.agents ?? []);
          toast(next ? "已设为读取" : "已设为不读");
        } catch (error) {
          setSwitchChecked(button, previous);
          button.disabled = false;
          if (hint) hint.textContent = error instanceof Error ? error.message : String(error);
        }
      });
    }
  };

  const apply = (data) => {
    editable = data.editable !== false;
    limit = Number(data.limit) || 8192;
    initial = String(data.content ?? "");
    text.value = initial;
    text.readOnly = !editable;
    save.hidden = !editable;
    reset.hidden = !editable;
    if (hint) {
      hint.textContent = editable ? "" : "「关于我」已关闭（USER_PROFILE_ENABLED=false），只能查看";
      hint.classList.toggle("is-error", !editable);
    }
    paintAgents(data.agents ?? []);
    paintDirty();
  };

  text.addEventListener("input", () => {
    // 待保存时先说清代价：「关于我」是 system 固定前缀的一段。
    if (hint) {
      hint.textContent =
        text.value !== initial
          ? "保存后下一轮生效；这段在固定前缀里，本会话下次请求会重建一次。"
          : "";
    }
    paintDirty();
  });
  reset.addEventListener("click", () => {
    text.value = initial;
    if (hint) hint.textContent = "";
    paintDirty();
  });
  save.addEventListener("click", async () => {
    if (save.disabled) return;
    save.disabled = true;
    if (hint) {
      hint.textContent = "保存中…";
      hint.classList.remove("is-error");
    }
    try {
      const response = await request(UP_ENDPOINT, {
        method: "PUT",
        body: JSON.stringify({ content: text.value }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data) throw new Error(data?.message || "保存失败");
      apply(data);
      // 「关于我」是 system 固定前缀的一段：保存后本会话下一次请求必然重建一次前缀。
      // 这是一次性的、用户显式改动的代价，先说清楚，免得看到命中率掉了以为是 bug。
      if (hint) {
        hint.textContent =
          "已保存，下一轮生效。这段在固定前缀里，本会话下次请求会重建一次（缓存掉一截属正常）。";
      }
      toast("已保存，下一轮生效");
    } catch (error) {
      if (hint) {
        hint.textContent = error instanceof Error ? error.message : String(error);
        hint.classList.add("is-error");
      }
    } finally {
      paintDirty();
    }
  });

  try {
    apply(await upReadPayload());
  } catch (error) {
    if (hint) {
      hint.textContent = error instanceof Error ? error.message : String(error);
      hint.classList.add("is-error");
    }
    save.disabled = true;
    reset.disabled = true;
  }
}
