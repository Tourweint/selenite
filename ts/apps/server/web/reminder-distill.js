/**
 * 提醒沉淀（2026-11-19 批4）：入口共享流。
 *
 * 照技能评估批 30 的"跳总管 + 预填"通用模式：
 *   点入口 → GET /api/v1/agent/reminder-candidates（服务端代码确定性收集，0 token）
 *   → 确认弹窗（收集到 N 条候选，去总管处蒸馏）→ 跳总管会话、提示词预填进输入框
 *   （不替用户发送）；总管合并同类、去掉一次性语境后调 save_reminder_advice 落建议快照；
 *   主人回设置 → 注入 → 索引页逐条点「采纳」才写进偏好（D18：只建议、人采纳）。
 *
 * REMINDER_DISTILL_ENABLED=false：候选端点 404 → 入口给一句 toast；建议卡不出现。
 */

import { el } from "./dom.js";
import { request } from "./net.js";
import { openChiefChat } from "./partners-status.js";
import { resize } from "./plus-menu.js";
import { closeModal, openModal, toast } from "./ui-atoms.js";

/** 拉候选清单；404 = 未启用（返回 null，调用方给一句 toast，不当错误吵）。 */
async function fetchReminderCandidates() {
  const response = await request("/api/v1/agent/reminder-candidates", { cache: "no-store" });
  if (response.status === 404) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.message || String(response.status));
  return data;
}

/**
 * 入口动作（记忆页 / 人设页共用同一份）：收集 → 确认弹窗 → 跳总管预填。
 * button 是发起点击的那个按钮：请求期间禁用，回来（成功或失败）都恢复。
 */
export async function runReminderDistill(button) {
  if (button) {
    if (button.disabled) return;
    button.disabled = true;
  }
  try {
    const data = await fetchReminderCandidates();
    if (!data) {
      toast("提醒沉淀未启用（服务端 REMINDER_DISTILL_ENABLED=false）");
      return;
    }
    const counts = data.counts || { utterances: 0, taught: 0, verified: 0 };
    const total = Array.isArray(data.candidates) ? data.candidates.length : 0;
    if (!total || !data.prompt) {
      toast("最近 30 天没收集到可蒸馏的候选（说过的话里没有提醒词，库里也没有教诲/问答沉淀）");
      return;
    }
    openModal("沉淀我的提醒", (body) => {
      body.innerHTML = `
        <p class="modal-desc">从最近 ${Number(data.windowDays) || 30} 天收集到 <b>${total}</b> 条候选（反复说过 ${Number(counts.utterances) || 0} · 已记教诲 ${Number(counts.taught) || 0} · 确认过的问答 ${Number(counts.verified) || 0}）。</p>
        <p class="modal-hint">去总管处把它们蒸馏成教诲建议：合并同类、去掉一次性语境。蒸馏只写建议清单，不写记忆库；回来后你逐条点「采纳」才算数。</p>
        <div class="modal-actions">
          <button class="ghost" type="button" data-modal-cancel>取消</button>
          <button class="modal-primary" type="button" id="mem-distill-go">去总管蒸馏</button>
        </div>`;
      body.querySelector("[data-modal-cancel]")?.addEventListener("click", closeModal);
      body.querySelector("#mem-distill-go")?.addEventListener("click", () => {
        closeModal();
        openChiefChat();
        // 照 runSkillAdvice：预填不代发——主人看过、点发送，总管在主人选的模型上干活
        el.input.value = String(data.prompt || "");
        resize();
        el.input.focus();
        toast("沉淀提示词已填进总管输入框——看过没问题就发送");
      });
    });
  } catch (error) {
    if (error.message === "forbidden") return;
    toast(`收集提醒候选失败：${error.message}`);
  } finally {
    if (button) button.disabled = false;
  }
}
