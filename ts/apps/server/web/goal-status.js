/**
 * 目标状态（2026-11-25 目标模式；服务端 `GOAL_MODE` 默认关）
 *
 * 目标正文仍是「当前目标」那一行文字；这里只管它的**状态**：推进中 / 已暂停 / 到上限 / 已完成。
 * 开关关着时详情端点不带 `goal` 字段，调用方拿不到状态，这一层就整段不出——
 * 界面回到"目标只是一行文字"的样子。
 *
 * 纯文案 + 一个动作按钮的判定 + 一个请求；加号菜单的「新建目标」弹层与
 * 人设页「岗位」的当前目标弹层共用，免得两处各写一遍口径。
 * 契约：docs/基线文档/接口-端点4-执事例行与自主轮.md §2.11「目标模式」。
 */

import { request } from "./net.js";

/** 卡片摘要上的短状态。 */
export function goalStatusShort(goal) {
  if (!goal) return "";
  if (goal.status === "active") return `推进中 ${goal.roundsUsed}/${goal.maxRounds}`;
  if (goal.status === "budget_limited") return "到上限";
  if (goal.status === "done") return "已完成";
  return "已暂停";
}

/** 弹层里的整行状态：为什么停、用了多少。只说数字与枚举，不复述目标正文。 */
export function goalStatusText(goal) {
  if (!goal) return "";
  const budget = goal.tokenBudget ? `，token ${goal.tokensUsed}/${goal.tokenBudget}` : "";
  const rounds = `${goal.roundsUsed}/${goal.maxRounds} 轮`;
  if (goal.status === "active") return `推进中 · 已用 ${rounds}${budget}`;
  if (goal.status === "budget_limited") return `已到上限，等你决定 · 已用 ${rounds}${budget}`;
  if (goal.status === "done") return `已标记完成 · 共 ${rounds}${budget}`;
  const why = {
    not_started: "还没开始推进",
    user: "已暂停",
    stopped: "你停掉了那一轮，已暂停",
    no_progress: "连续几轮没动手，已自动暂停",
    blocked: "等你介入才能继续",
  }[goal.reason];
  return `${why || "已暂停"} · 已用 ${rounds}${budget}`;
}

/**
 * 当前状态下那颗按钮该是什么。没有可做的（没目标 / 开关关）= null。
 * 到上限时按钮顺手把上限抬一档——否则界面里没有别的地方能改上限，点了只会收到一句"先上调"。
 */
export function goalActionFor(goal) {
  if (!goal) return null;
  if (goal.status === "active") return { action: "pause", label: "暂停推进", toast: "已暂停，不会再自动续跑" };
  if (goal.status === "done") return { action: "reopen", label: "没完成，继续", toast: "已重新开始推进" };
  if (goal.status === "budget_limited") {
    if (goal.reason === "tokens" && goal.tokenBudget) {
      return {
        action: "resume",
        label: "预算翻倍并继续",
        toast: "已加预算并继续推进",
        tokenBudget: goal.tokenBudget * 2,
      };
    }
    return {
      action: "resume",
      label: "再加 10 轮并继续",
      toast: "已加 10 轮并继续推进",
      maxRounds: goal.maxRounds + 10,
    };
  }
  if (goal.reason === "not_started") return { action: "start", label: "开始推进", toast: "已开始推进" };
  return { action: "resume", label: "继续推进", toast: "已继续推进" };
}

/** 调动作端点，返回最新状态（清除目标后 = null）。失败抛带说明的 Error。 */
export async function postGoalAction(partnerId, next) {
  const response = await request(`/api/v1/partners/${encodeURIComponent(partnerId)}/goal`, {
    method: "POST",
    body: JSON.stringify({
      action: next.action,
      maxRounds: next.maxRounds,
      tokenBudget: next.tokenBudget,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.error || `HTTP ${response.status}`);
  return data.goal ?? null;
}
