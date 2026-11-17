import { REVIEW_TIMEOUT_MS } from "./config.ts";
import { askInternal } from "./internal.ts";
import { extractJsonBlock } from "./plan.ts";
import {
  collectArtifactContents,
  filterArtifacts,
  formatArtifactContents,
} from "./review.ts";
import { listFiles } from "./store.ts";
import type {
  GoalCheckResult,
  GoalOutcome,
  PlannedTask,
  TaskRun,
  Ticket,
} from "./types.ts";

export interface GoalCheckInput {
  ticket: Ticket;
  tasks: PlannedTask[];
  runs: TaskRun[];
  ticketDir: string;
}

/**
 * 所有 task 都 pass 之后的最后一道核对：任务各自达标，不等于用户要的结果达成。
 * 拿用户原话对照实际结果，拦「把失败写成 done_when」这类假成功。
 */
export async function checkTicketGoal(
  input: GoalCheckInput,
  signal?: AbortSignal,
): Promise<GoalCheckResult> {
  let hint = "";
  let lastError = "目标核对模型没有给出结论";

  for (let attempt = 1; attempt <= 3; attempt++) {
    if (signal?.aborted) {
      return { satisfied: false, reason: "已停止", aborted: true, inconclusive: false };
    }
    const response = await askInternal({
      prompt: buildGoalPrompt(input, hint),
      cwd: input.ticketDir,
      tools: "none",
      timeoutMs: REVIEW_TIMEOUT_MS,
      label: "goal",
      signal,
    });
    if (response.aborted) {
      return { satisfied: false, reason: "已停止", aborted: true, inconclusive: false };
    }
    if (!response.ok) {
      lastError = response.timedOut ? "目标核对超时" : (response.error ?? "目标核对调用失败");
      hint = lastError;
      continue;
    }
    try {
      const parsed = parseGoal(response.result);
      return {
        satisfied: parsed.satisfied,
        reason: parsed.reason,
        aborted: false,
        inconclusive: "inconclusive" in parsed && parsed.inconclusive === true,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      hint = lastError;
    }
  }

  return {
    satisfied: false,
    reason: `目标核对没能给出结论：${lastError}`,
    aborted: false,
    inconclusive: true,
  };
}

export function parseGoal(text: string): GoalOutcome {
  const block = extractJsonBlock(text);
  if (!block) throw new Error("输出里没有 ```json 代码块");
  let data: unknown;
  try {
    data = JSON.parse(block);
  } catch (error) {
    throw new Error(`json 解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (data === null || typeof data !== "object") throw new Error("顶层不是对象");
  const obj = data as Record<string, unknown>;
  if (typeof obj.satisfied !== "boolean") {
    throw new Error("satisfied 必须是 true 或 false");
  }
  const reason =
    typeof obj.reason === "string" && obj.reason.trim() !== ""
      ? obj.reason.trim()
      : "（目标核对未给理由）";
  if (obj.satisfied === true) return { satisfied: true, reason };
  // 手机单：汇报说完成、但材料与目标完全对不上 → 没结论，报人（不是 failed）。
  // 老输出不带 inconclusive，照旧当「有结论但没达成」。
  return obj.inconclusive === true
    ? { satisfied: false, inconclusive: true, reason }
    : { satisfied: false, reason };
}

export function buildGoalPrompt(input: GoalCheckInput, hint: string): string {
  const sections = input.tasks.map((task, index) => {
    const seq = index + 1;
    const run = input.runs.find((item) => item.seq === seq);
    const artifacts = run?.report ? filterArtifacts(run.report.artifacts) : [];
    const sizes = new Map(
      run ? listFiles(run.dir).map((file) => [file.path, file.size] as const) : [],
    );
    const artifactText =
      artifacts.length > 0
        ? artifacts
            .map((path) => {
              const size = sizes.get(path);
              return size === undefined ? path : `${path}（${size} 字节）`;
            })
            .join("、")
        : "（无）";
    const phone = run?.employee === "phone";
    return `### ${String(seq).padStart(2, "0")}-${task.slug}  ${task.title}
雇员：${run?.employee ?? "未知"}${phone ? "（按汇报验收）" : ""}
done_when：${task.done_when}
REPORT 状态：${run?.report?.status ?? "缺失"}
REPORT 摘要：${run?.report?.summary ?? (run?.reportError ?? "无")}
产物：${artifactText}${phone && run ? phoneReportMaterial(run) : ""}`;
  });
  const hasPhone = input.runs.some((run) => run.employee === "phone");

  return `你是 chancellor 的最终目标核对员。所有 task 都已被判定通过；现在只判断一件事：这些任务合起来，是否真的达成了用户原话要求的结果。

你没有工具，不能读文件、不能执行命令，也不要输出任何工具调用。只根据下面给出的材料判断；材料不足就直接判 satisfied=false。

用户原话：
"""
${input.ticket.prompt}
"""

拆出的任务与实际结果：
${sections.join("\n\n")}

判定规则：
- satisfied=true 当且仅当用户真正要的结果已经达成。只要结果达成了，不要因为风格、措辞、额外做了无关的事而判否。
- 如果某个 done_when 把「报告失败」「说明文件不存在」「确认无法读取」当成完成标准，而用户原话要的是实际结果，那么即使每个 task 都 pass，也必须 satisfied=false。这是最常见的假成功。
- 用户明确要求读取/总结某个文件时，如果结果只是「说明该文件不存在」，没有实际总结，必须 satisfied=false。
- 不要因为 worker 在 REPORT 里说「完成了」就相信；以给出的任务结果和产物清单为准。
- 不要尝试读取文件或调用工具；材料已经足够。证据不足以下结论 → satisfied=false（宁可严格，不可放水）。
${hasPhone ? `- **手机任务专规（优先于上面的「证据不足 → satisfied=false」）**：手机任务没有独立的项目产物，result.md 就是 worker 的汇报，**没有独立产物不构成不合格**。
- 汇报明确说没达成，或与用户原话明显相反 → satisfied=false。
- 汇报说完成，但给出的材料与目标完全对不上、无从核对 → satisfied=false 且 inconclusive=true（报人，不算失败）。
- 其余按汇报定：汇报与用户原话对得上就 satisfied=true。
` : ""}
只输出一个 \`\`\`json 代码块，不要输出其他内容：
\`\`\`json
{"satisfied":true,"reason":"一句话理由"}
\`\`\`${hasPhone ? `
无从核对时输出：
\`\`\`json
{"satisfied":false,"inconclusive":true,"reason":"一句话理由"}
\`\`\`` : ""}
${hint ? `\n上一次的输出有问题：${hint}\n禁止调用任何工具，只输出上面的 JSON 代码块，不要输出解释。` : ""}`;
}

/** 手机单的证据只有汇报本身：result.md 全文（截断照 artifacts 既有口径：≤2 KB 全文，超出取前 2 KB）。 */
function phoneReportMaterial(run: TaskRun): string {
  const excerpt = collectArtifactContents(run.dir, ["result.md"]);
  if (excerpt[0]?.kind === "unreadable") {
    return "\n汇报原文（result.md）：（读取失败，只有上面的 REPORT 摘要）";
  }
  return `\n汇报原文（result.md）：\n${formatArtifactContents(excerpt, "####")}`;
}
