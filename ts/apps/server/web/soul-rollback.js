/**
 * 人设保存后的「回到上一版」按钮（2026-11-15 人设停存版本快照方案）。
 *
 * 服务端把 SOUL.md 与 SOUL.prev.md **交换**（单槽）：点一次回到上一份，
 * 再点一次等于撤销回滚。按钮只在保存成功后出现——那一刻 SOUL.prev.md 一定有货；
 * 回滚完成或失败就摘掉，不常驻。
 *
 * 三处保存共用：改人设二级页（partner-profile）/ 设置→总管人设（settings-persona）/
 * 执事档案编辑弹窗（partner-editor）。
 */
import { request } from "./net.js";

/** 在提示行末尾追加「回到上一版」；回填正文走 onRestored（拿服务端返回的 SOUL 原文）。 */
export function showRollbackOffer(hint, partnerId, onRestored) {
  if (!hint) return;
  const label = document.createElement("span");
  label.textContent = hint.textContent;
  hint.textContent = "";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "hint-rollback";
  btn.textContent = "回到上一版";
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      const response = await request(
        `/api/v1/partners/${encodeURIComponent(partnerId)}/soul/rollback`,
        { method: "POST" },
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        hint.textContent = data.message || "没回到上一版。";
        return;
      }
      hint.textContent = "已回到上一版，下一轮起用。";
      onRestored?.(String(data.soul ?? ""));
    } catch (error) {
      if (error.message !== "forbidden") hint.textContent = `没回到上一版：${error.message}`;
    }
  });
  hint.append(label, " ", btn);
}
