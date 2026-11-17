import { PLAN_TIMEOUT_MS } from "./config.ts";
import { askInternal } from "./internal.ts";
import { normalizeProjectPath } from "./paths.ts";
import type {
  DroppedDep,
  EmployeeCapabilities,
  PlanAttempt,
  PlanResult,
  PlannedTask,
  Ticket,
  WorkerKind,
} from "./types.ts";

export interface PlanValidation {
  tasks: PlannedTask[];
  droppedDeps: DroppedDep[];
}

export function extractJsonBlock(text: string): string | null {
  const match = /```json\s*([\s\S]*?)```/i.exec(text);
  if (match && match[1] !== undefined) return match[1].trim();
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  return null;
}

export function parsePlan(text: string, maxTasks: number): PlanValidation {
  const block = extractJsonBlock(text);
  if (!block) throw new Error("输出里没有 ```json 代码块");
  let data: unknown;
  try {
    data = JSON.parse(block);
  } catch (error) {
    throw new Error(`json 解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
  return validatePlan(data, maxTasks);
}

export function validatePlan(data: unknown, maxTasks: number): PlanValidation {
  if (data === null || typeof data !== "object") {
    throw new Error("顶层不是对象");
  }
  const tasksRaw = (data as Record<string, unknown>).tasks;
  if (!Array.isArray(tasksRaw)) throw new Error("tasks 不是数组");
  if (tasksRaw.length < 1 || tasksRaw.length > maxTasks) {
    throw new Error(`tasks 数量是 ${tasksRaw.length}，必须在 1-${maxTasks} 之间`);
  }
  const droppedDeps: DroppedDep[] = [];
  const tasks = tasksRaw.map((raw, index) => {
    if (raw === null || typeof raw !== "object") {
      throw new Error(`tasks[${index}] 不是对象`);
    }
    const obj = raw as Record<string, unknown>;
    const seq = index + 1;
    const slug = requireString(obj.slug, `tasks[${index}].slug`);
    if (!/^[a-z0-9-]+$/.test(slug)) {
      throw new Error(`tasks[${index}].slug "${slug}" 只能用小写字母、数字、连字符`);
    }
    const dependsOn = normalizeDependsOn(obj.dependsOn, seq, droppedDeps);
    return {
      title: requireString(obj.title, `tasks[${index}].title`),
      slug,
      instruction: requireString(obj.instruction, `tasks[${index}].instruction`),
      done_when: requireString(obj.done_when, `tasks[${index}].done_when`),
      dependsOn,
      writes: normalizeWrites(obj.writes),
    };
  });
  return { tasks, droppedDeps };
}

/**
 * 写集只收项目内相对路径；绝对路径 / `..` / 空串直接忽略。
 * 被忽略的条目等于没声明，实际写到了会在合并前判越权——这是刻意从严。
 */
function normalizeWrites(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const normalized = normalizeProjectPath(item);
    if (normalized && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}

/** 非法依赖不重试整单：过滤掉并记录，任务照跑。 */
function normalizeDependsOn(
  raw: unknown,
  seq: number,
  dropped: DroppedDep[],
): number[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    dropped.push({ seq, value: raw, reason: "dependsOn 不是数组，已忽略" });
    return [];
  }
  const deps: number[] = [];
  for (const value of raw) {
    if (!Number.isInteger(value)) {
      dropped.push({ seq, value, reason: "依赖项不是整数 seq" });
      continue;
    }
    const dep = value as number;
    if (dep < 1) {
      dropped.push({ seq, value, reason: "seq 必须 >= 1" });
      continue;
    }
    if (dep >= seq) {
      dropped.push({ seq, value, reason: "只能依赖前面的任务" });
      continue;
    }
    if (!deps.includes(dep)) deps.push(dep);
  }
  return deps;
}

/**
 * 按雇员把拆单结果收敛到可验收的形状（2026-11-04 批次八）。
 *
 * 手机雇员不写项目工作区，`writes` 恒为空：规划器仍可能按提示词习惯声明路径，
 * 不靠祈祷，这里确定性抹掉。否则没有项目时 scheduler 清 writes、review 拿原始
 * writes 判 → blocked；挂了项目时快照拍了但手机不写项目文件 → 0 变更 fail。
 */
export function applyEmployeePlanPolicy(
  tasks: PlannedTask[],
  employee?: WorkerKind,
): PlannedTask[] {
  if (employee !== "phone") return tasks;
  return tasks.map((task) => (task.writes.length === 0 ? task : { ...task, writes: [] }));
}

export async function planTicket(
  ticket: Ticket,
  maxTasks: number,
  signal?: AbortSignal,
  capabilities?: EmployeeCapabilities,
  employee?: WorkerKind,
): Promise<PlanResult> {
  const attempts: PlanAttempt[] = [];
  let lastError = "未知错误";
  let lastRaw = "";
  let hint: string | null = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    if (signal?.aborted) {
      lastError = "已停止";
      attempts.push({ attempt, ok: false, error: lastError });
      break;
    }

    const response = await askInternal({
      prompt: buildPlanPrompt(
        appendPlanSteps(ticket.prompt, ticket.steps),
        maxTasks,
        hint,
        capabilities?.note,
      ),
      cwd: ticket.options.workRoot,
      tools: "none",
      timeoutMs: PLAN_TIMEOUT_MS,
      label: "plan",
      signal,
    });

    if (response.aborted) {
      lastError = "已停止";
      attempts.push({ attempt, ok: false, error: lastError });
      break;
    }
    if (!response.ok) {
      lastError = response.timedOut ? "拆单超时" : (response.error ?? "qoder 调用失败");
      attempts.push({ attempt, ok: false, error: lastError });
      hint = lastError;
      continue;
    }

    lastRaw = response.result;
    try {
      const validation = parsePlan(response.result, maxTasks);
      attempts.push({ attempt, ok: true, error: null });
      return {
        ok: true,
        tasks: applyEmployeePlanPolicy(validation.tasks, employee),
        droppedDeps: validation.droppedDeps,
        attempts,
        error: null,
        raw: response.result,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      attempts.push({ attempt, ok: false, error: lastError });
      hint = lastError;
    }
  }

  return {
    ok: false,
    tasks: [],
    droppedDeps: [],
    attempts,
    error: lastError,
    raw: lastRaw,
  };
}

/**
 * 计划附件（2026-11-09 保证实现纵深 §2.1）：把宿主给的动作序列拼在需求尾部。
 *
 * 为什么拼在 prompt 而不是改 JSON 契约：规划器只读一段自然语言，多一个字段它也不看；
 * 拼成 `## 步骤` 段是最小改动，且与"落不进去就退化 requirement 尾部"的兜底同形。
 * 空 / 未传 → 原样返回（旧行为逐字节一致）。
 */
export function appendPlanSteps(requirement: string, steps?: string[]): string {
  if (!Array.isArray(steps) || steps.length === 0) return requirement;
  const list = steps.map((step, index) => `${index + 1}. ${step}`).join("\n");
  return `${requirement}\n\n## 步骤（宿主给的核对序列；按这个顺序安排任务，不要漏项）\n${list}`;
}

export function buildPlanPrompt(
  requirement: string,
  maxTasks: number,
  hint: string | null,
  capabilityNote?: string,
): string {
  return `你是任务拆解器。把下面这句需求拆成 1-${maxTasks} 个 task，每个 task 必须是「一个 worker 一次能干完」的粒度。

需求原话：
"""
${requirement}
"""

只输出一个 \`\`\`json 代码块，不要输出任何其他内容，格式严格如下：
\`\`\`json
{"tasks":[
  {"title":"读取 source.txt","slug":"read-source","instruction":"读取 D:/data/source.txt 的全文，把原文写入项目里的 excerpt.txt。不要做别的事。","done_when":"excerpt.txt 存在且内容与 source.txt 原文一致","dependsOn":[],"writes":["excerpt.txt"]},
  {"title":"总结 source.txt","slug":"summarize-source","instruction":"基于前置任务读到的原文，在项目里写 summary.md 总结其内容。","done_when":"summary.md 存在，且总结内容来自前置任务提供的原文","dependsOn":[1],"writes":["summary.md"]}
]}
\`\`\`

约束：
- tasks 数量必须在 1 到 ${maxTasks} 之间。
- slug 只用小写字母、数字、连字符，例如 write-hello。
- instruction 写清楚要在项目里做什么；done_when 写可机械验证的完成标准。
- 每个 task 只做一件事，不要把一个 task 拆得过大。
- done_when 必须描述用户真正想要的最终结果（文件存在且内容正确、代码改完且测试通过等）。
- 严禁把「无法完成时说明原因」「报告文件不存在」「确认读取失败」写成完成标准。做不到就是 blocked，不是 done。
- **writes 必填**：列出这个 task 会写入/删除的项目内相对路径（相对项目根，用 / 分隔）。
  目录通配可以写 docs/**；只读任务给空数组 []。绝对路径和 .. 一律无效。
  写集就是独占租约的范围：没声明的路径一旦被写入，整个 task 判失败且不会合并。
- task 之间共享同一个项目副本；后一个 task 默认能看到前一个 task 合并进项目的结果。
  如果必须等前一个 task 的结果才能开工，用 dependsOn 声明依赖的 seq。
- 并行安全：没有依赖关系的 task 可能同时跑。写同一个文件的 task 必须串成依赖，
  或者由计划合并成一个 task。
- dependsOn 是整数 seq 数组，只能依赖更小的 seq（不能依赖自己或后面的任务），省略等价于 []。
- 有依赖时，后一个 task 的 instruction 要明确说「基于前置任务的结果」，不要重复前置任务已经做完的事。
${capabilityNote ? `- 这只手的能力：${capabilityNote}\n` : ""}${hint ? `\n你上一次的输出有问题：${hint}\n请修正后重新输出。` : ""}`;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} 缺失或不是非空字符串`);
  }
  return value.trim();
}
