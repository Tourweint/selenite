/**
 * 二级页 · 权限
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { el } from "./dom.js";
import { request } from "./net.js";
import { mountSegmented, syncSegmented } from "./settings-atoms.js";
import { cs, csHead, refreshCsPolicy } from "./settings-drawer.js";
import { toast } from "./ui-atoms.js";

/* ── 二级页 · 权限（B 版）：三档授权竖排成可读的选项行 + 审批三档分段 ──
   轻量重实现，不复用 loadPolicy（那是 getElementById 硬编码 #policy-switch，
   与全屏设置页双绑会打架）；GET /agent/policy 读档、POST 回写（2026-11-07 定论）。
   2026-11-13：授权三档从「分段按钮」改成「一行一档 + 一句解释」——权限是要看懂才敢选的，
   三个词并排时「只读」和「不跑命令」的区别得靠猜。审批三档仍用分段（三个词够直白）。 */
function renderCsPolicyPage() {
  const drawer = el.chatSettingsDrawer;
  if (!drawer) return;
  drawer.replaceChildren(csHead("权限", { back: true }));
  const body = document.createElement("div");
  body.className = "cs-body";
  body.dataset.cards = ""; // 卡片化排版（群设置共用骨架，不吃这一套）
  body.innerHTML = `
    <div class="cs-card">
      <div class="cs-field">
        <span class="cs-field-label">它能替你动到什么程度</span>
        <div class="cs-policy-list" role="radiogroup" aria-label="权限" id="cs-policy-switch">
          <button type="button" class="cs-opt" data-policy="full" aria-checked="false">
            <span class="cs-opt-main">
              <span class="cs-opt-title">完全访问</span>
              <span class="cs-opt-sub">能改文件、能跑命令</span>
            </span>
            <span class="cs-opt-dot" aria-hidden="true"></span>
          </button>
          <button type="button" class="cs-opt" data-policy="read-only" aria-checked="false">
            <span class="cs-opt-main">
              <span class="cs-opt-title">只读</span>
              <span class="cs-opt-sub">能看，不改，不跑</span>
            </span>
            <span class="cs-opt-dot" aria-hidden="true"></span>
          </button>
          <button type="button" class="cs-opt" data-policy="no-shell" aria-checked="false">
            <span class="cs-opt-main">
              <span class="cs-opt-title">不跑命令</span>
              <span class="cs-opt-sub">改文件可以，命令一律不跑</span>
            </span>
            <span class="cs-opt-dot" aria-hidden="true"></span>
          </button>
        </div>
        <span class="cs-hint">改完立刻生效，下一轮起按这一档走。</span>
      </div>
      <div class="cs-field">
        <span class="cs-field-label">动手之前问不问我</span>
        <div class="segmented slide" role="radiogroup" aria-label="审批档" id="cs-policy-approval-level">
          <button type="button" data-approval="ask-all" aria-checked="false">全部问我</button>
          <button type="button" data-approval="ask-critical" aria-checked="false">只问重要的</button>
          <button type="button" data-approval="none" aria-checked="false">全不问</button>
        </div>
        <span class="cs-hint">只问重要的 = 只拦跑命令、派活等会起执行的动作；改文件自动放行。</span>
      </div>
    </div>`;
  drawer.append(body);

  // 授权三档：选项行自己管选中态（radio），事件只绑抽屉这一份
  const box = body.querySelector("#cs-policy-switch");
  if (box) {
    for (const button of box.querySelectorAll("[data-policy]")) {
      button.setAttribute("aria-checked", String(button.dataset.policy === cs.policy?.access));
    }
    for (const button of box.querySelectorAll("[data-policy]")) {
      button.addEventListener("click", async () => {
        for (const other of box.querySelectorAll("[data-policy]")) {
          other.setAttribute("aria-checked", String(other === button));
        }
        if (cs.policy) cs.policy.access = button.dataset.policy;
        try {
          await request("/api/v1/agent/policy", {
            method: "POST",
            body: JSON.stringify({ access: button.dataset.policy }),
          });
        } catch {
          // 写失败：回读服务端真值，撤销乐观切档，避免用户误以为已保存
          toast("权限保存失败，请重试");
          void refreshCsPolicy();
        }
      });
    }
  }

  // 审批三档（2026-11-08 扫尾批 10-C）：与「权限」同源 /policy，抽屉里只改确认轴
  const approvalBox = body.querySelector("#cs-policy-approval-level");
  if (approvalBox) {
    mountSegmented(approvalBox);
    for (const button of approvalBox.querySelectorAll("[data-approval]")) {
      button.setAttribute(
        "aria-checked",
        String(button.dataset.approval === cs.policy?.approvalLevel),
      );
    }
    syncSegmented(approvalBox);
    for (const button of approvalBox.querySelectorAll("[data-approval]")) {
      button.addEventListener("click", async () => {
        for (const other of approvalBox.querySelectorAll("[data-approval]")) {
          other.setAttribute("aria-checked", String(other === button));
        }
        syncSegmented(approvalBox);
        if (cs.policy) cs.policy.approvalLevel = button.dataset.approval;
        try {
          await request("/api/v1/agent/policy", {
            method: "POST",
            body: JSON.stringify({ approvalLevel: button.dataset.approval }),
          });
        } catch {
          toast("审批档保存失败，请重试");
          void refreshCsPolicy();
        }
      });
    }
  }
}

/** 逐行校验：非法行（超长）整批拦下并列明行号；合法行去重后与既有清单合并回写 */

export { renderCsPolicyPage };
