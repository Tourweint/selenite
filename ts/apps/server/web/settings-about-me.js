/**
 * 设置 → 注入 → 偏好（2026-11-19 上线时叫「关于我」，2026-11-23 改名）
 *
 * 全局一份长期背景：每轮作为 system 段注入给会读它的 Agent，不进记忆、不参与召回。
 * 这一页只改正文与保存；「谁读」按人放在每个人自己的人设页（2026-11-23 用户口径：
 * 开关从这一页搬进人设页的「每轮固定注入」）。
 * 端点：GET/PUT /api/v1/agent/user-profile（正文）；每 Agent 的开关走
 * PUT /api/v1/agent/user-profile/agents/:id，由 partner-profile.js 调用。
 *
 * 2026-11-23 用户口径：撤掉解释性文案（注入时机 / 缓存重建 / 看实际注入的跳转），
 * 标题与 tab 由「关于我」改为「偏好」。
 */

import { esc } from "./markdown.js";
import { request } from "./net.js";
import { toast } from "./ui-atoms.js";

const UP_ENDPOINT = "/api/v1/agent/user-profile";
const UP_PLACEHOLDER = [
  "称呼我「……」。",
  "我常用语音输入，文字里可能有识别错字：先按意思理解，不确定再问。",
  "不要……（说话 / 做事上的禁忌）。",
].join("\n");

function upBytes(text) {
  return new TextEncoder().encode(String(text ?? "")).length;
}

export function aboutMeMarkup() {
  return `<div class="up-page">
    <div class="card pf-panel">
      <textarea class="pf-soul" id="up-text" spellcheck="false" aria-label="偏好"
                placeholder="${esc(UP_PLACEHOLDER)}"></textarea>
      <div class="pf-foot">
        <span class="pf-sec-note" id="up-count">0 / 8192 字节</span>
        <button class="ghost" type="button" id="up-reset" disabled>撤销</button>
        <button class="btn-primary" type="button" id="up-save" disabled>保存</button>
      </div>
      <p class="pf-hint" id="up-hint"></p>
    </div>
  </div>`;
}

async function upReadPayload() {
  const response = await request(UP_ENDPOINT, { cache: "no-store" });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
    throw new Error(data?.message || "读取失败");
  }
  return data;
}

/** 页面接线：一次拉取，正文本地编辑；保存走整份 PUT。 */
export async function wireAboutMe() {
  const text = document.getElementById("up-text");
  const count = document.getElementById("up-count");
  const hint = document.getElementById("up-hint");
  const save = document.getElementById("up-save");
  const reset = document.getElementById("up-reset");
  if (!text || !count || !save || !reset) return;

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

  const apply = (data) => {
    editable = data.editable !== false;
    limit = Number(data.limit) || 8192;
    initial = String(data.content ?? "");
    text.value = initial;
    text.readOnly = !editable;
    save.hidden = !editable;
    reset.hidden = !editable;
    if (hint) {
      hint.textContent = editable ? "" : "「偏好」已关闭（USER_PROFILE_ENABLED=false），只能查看";
      hint.classList.toggle("is-error", !editable);
    }
    paintDirty();
  };

  text.addEventListener("input", () => {
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
      toast("已保存");
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
