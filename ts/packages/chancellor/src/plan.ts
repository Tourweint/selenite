import process from "node:process";
import { normalizeProjectPath } from "./paths.ts";
import type { DroppedDep, PlannedTask, WorkerKind } from "./types.ts";

export interface PlanValidation {
  tasks: PlannedTask[];
  droppedDeps: DroppedDep[];
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

/**
 * 调度简化（2026-11-23）：拆单归调用方（总管 / 领域经理）自己给 tasks。
 * 这里只做确定性校验，不调任何模型；规范化仍复用 validatePlan。
 * 与 validatePlan 的区别是更严：writes 必须显式给（只读任务给 []），避免
 * "漏写写集"被 normalizeWrites 静默当成只读任务。
 */
export function validateTaskInput(raw: unknown, maxTasks: number): PlanValidation {
  if (!Array.isArray(raw)) throw new Error("tasks 必须是数组");
  if (raw.length < 1 || raw.length > maxTasks) {
    throw new Error(`tasks 数量是 ${raw.length}，必须在 1-${maxTasks} 之间`);
  }
  raw.forEach((item, index) => {
    if (item === null || typeof item !== "object") {
      throw new Error(`tasks[${index}] 不是对象`);
    }
    const obj = item as Record<string, unknown>;
    requireString(obj.title, `tasks[${index}].title`);
    const slug = requireString(obj.slug, `tasks[${index}].slug`);
    if (!/^[a-z0-9-]+$/.test(slug)) {
      throw new Error(`tasks[${index}].slug "${slug}" 只能用小写字母、数字、连字符`);
    }
    requireString(obj.instruction, `tasks[${index}].instruction`);
    requireString(obj.done_when, `tasks[${index}].done_when`);
    if (!Array.isArray(obj.writes)) {
      throw new Error(`tasks[${index}].writes 缺失或不是数组（只读任务请显式给 []）`);
    }
    obj.writes.forEach((path, pathIndex) => {
      if (typeof path !== "string" || normalizeProjectPath(path) === null) {
        throw new Error(
          `tasks[${index}].writes[${pathIndex}] 不是合法的项目内相对路径（不要绝对路径 / ..）`,
        );
      }
    });
  });
  return validatePlan({ tasks: raw }, maxTasks);
}

/**
 * 没给 tasks 的入口（前端直派 / 手机 / 远端设备）兜底成整单一个任务。
 * writes 给 `**`（整项目）：调用方没拆，就按最宽写集独占，靠 worktree + 合并冲突兜底。
 */
export function singleTaskFromRequirement(requirement: string, steps?: string[]): PlannedTask {
  return {
    title: "整单任务",
    slug: "task",
    instruction: appendPlanSteps(requirement.trim(), steps),
    done_when: "完成用户交代的事；有产物时在 REPORT.md 的 artifacts 里列出，并逐个读回自检",
    dependsOn: [],
    writes: ["**"],
  };
}

export type RequestTasksResolution =
  | { ok: true; tasks: PlannedTask[]; droppedDeps: DroppedDep[]; source: "dispatcher" | "single" }
  | { ok: false; error: string };

/** 缺省开；只有显式 false/0/off 才关（与仓库其它开关同口径）。 */
function tasksDirectEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.CHANCELLOR_TASKS_DIRECT ?? "").trim().toLowerCase();
  if (raw === "") return true;
  return !["false", "0", "off"].includes(raw);
}

/**
 * 调用方给了 tasks 就校验直用；没给就单任务兜底。两条路径都按雇员收敛写集。
 * CHANCELLOR_TASKS_DIRECT=false 时忽略 tasks，回落单任务。
 */
export function resolveRequestTasks(input: {
  raw: unknown;
  maxTasks: number;
  requirement: string;
  steps?: string[];
  employee?: WorkerKind;
}): RequestTasksResolution {
  const raw = tasksDirectEnabled() ? input.raw : undefined;
  if (raw === undefined || raw === null) {
    const tasks = applyEmployeePlanPolicy(
      [singleTaskFromRequirement(input.requirement, input.steps)],
      input.employee,
    );
    return { ok: true, tasks, droppedDeps: [], source: "single" };
  }
  try {
    const validation = validateTaskInput(raw, input.maxTasks);
    return {
      ok: true,
      tasks: applyEmployeePlanPolicy(validation.tasks, input.employee),
      droppedDeps: validation.droppedDeps,
      source: "dispatcher",
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 计划附件（2026-11-09 保证实现纵深 §2.1）：把宿主给的动作序列拼在需求尾部。
 *
 * 为什么拼进文本而不是改 JSON 契约：worker 只读一段自然语言，多一个字段它也不看；
 * 拼成 `## 步骤` 段是最小改动。2026-11-23 起没有拆单器，只在单任务兜底时用到。
 * 空 / 未传 → 原样返回（旧行为逐字节一致）。
 */
export function appendPlanSteps(requirement: string, steps?: string[]): string {
  if (!Array.isArray(steps) || steps.length === 0) return requirement;
  const list = steps.map((step, index) => `${index + 1}. ${step}`).join("\n");
  return `${requirement}\n\n## 步骤（宿主给的核对序列；按这个顺序安排任务，不要漏项）\n${list}`;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} 缺失或不是非空字符串`);
  }
  return value.trim();
}
