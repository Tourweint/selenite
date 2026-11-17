import type {
  JudgeCallRecord,
  JudgeFile,
  JudgeInput,
  JudgeOutcome,
  JudgeVerdictKind,
  PlannedTask,
  Review,
  TaskRun,
  Ticket,
} from "./types.ts";

/**
 * 证据裁判（2026-11-10 批 14，上位方案 `docs/设计方案/2026-11-10-批14方案`）。
 *
 * 现状：验收（D13 快照 / LLM 验收 / 任务级目标核对）都是**看材料下判断**。
 * 裁判补的是"能不能自己去查"：验收判 fail 时，宿主起一个 read-only 子会话
 * （`read` + 只读白名单 bash），自己读工作区后给 done / continue / blocked / wait。
 *
 * 为什么裁判逻辑在这一层：**判定规则必须与宿主无关**（谁跑 chancellor 都同一套），
 * 而"怎么起一个只读会话"是宿主的事（chancellor 不 import harness）。所以这里只放
 * 纯逻辑 + 落盘口径，真正的模型会话由 `ChancellorOptions.judge` 注入。
 *
 * 铁律（写进这里的代码，不是只写进提示词）：
 * 1. **没查不许给 done**：`toolsUsed === 0` 或 `evidence` 为空 → 降级 continue + warning。
 * 2. **同一个理由连续两次 → blocked**：说明返工方向没变，再修也是同一处。
 * 3. **开关默认关**：`DELEGATION_JUDGE` 未设 → 一段代码都不进，行为与今天逐字节一致。
 * 4. **裁判异常不改结局**：`ok=false` / 中止 → 按原有失败路径走，不新增挂起。
 */

export const JUDGE_ENV = "DELEGATION_JUDGE";
export const JUDGE_MAX_ROUNDS_ENV = "DELEGATION_JUDGE_MAX_ROUNDS";
export const JUDGE_MAX_TOOLS_ENV = "DELEGATION_JUDGE_MAX_TOOLS";
export const DEFAULT_JUDGE_MAX_ROUNDS = 3;
export const DEFAULT_JUDGE_MAX_TOOLS = 8;

/**
 * 默认**关**：裁判 = 额外一次带工具的模型调用，个人机器上按需开更诚实。
 * 只认显式的 1/true/on——写错值不该悄悄开始花钱。
 */
export function judgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[JUDGE_ENV] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}

/** 裁判最多来看几次（与 `DELEGATION_ACCEPT_ROUNDS` 正交：那是返工轮数）。 */
export function judgeMaxRounds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[JUDGE_MAX_ROUNDS_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_JUDGE_MAX_ROUNDS;
  const value = Number(raw.trim());
  if (!Number.isFinite(value)) return DEFAULT_JUDGE_MAX_ROUNDS;
  return Math.max(0, Math.floor(value));
}

/**
 * 一次裁判最多几次工具调用。非正数回落默认值（0 会让"自己查"变成不可能，
 * 那不是配置选项，是配错了）。
 */
export function judgeMaxTools(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[JUDGE_MAX_TOOLS_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_JUDGE_MAX_TOOLS;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value < 1) return DEFAULT_JUDGE_MAX_TOOLS;
  return Math.floor(value);
}

/** 这一轮之前裁判已经来过几次（judge.json 缺失 / 坏了 → 0）。 */
export function judgeCallsOf(file: JudgeFile | null | undefined): JudgeCallRecord[] {
  if (!file || !Array.isArray(file.calls)) return [];
  return file.calls.filter(
    (call): call is JudgeCallRecord =>
      Boolean(call) &&
      typeof call === "object" &&
      typeof (call as JudgeCallRecord).verdict === "string" &&
      typeof (call as JudgeCallRecord).reason === "string",
  );
}

export function nextJudgeRound(file: JudgeFile | null | undefined): number {
  return judgeCallsOf(file).length + 1;
}

/**
 * 该不该叫裁判：开关关 / 没注入 / 轮次用完 / 已中止 → 不叫。
 * 这几个条件是**全部**的开闸判据，集中在纯函数里，单测能直接断言"关着时一次都不进"。
 */
export function shouldConsultJudge(input: {
  enabled: boolean;
  hasJudge: boolean;
  calls: number;
  maxRounds: number;
  aborted: boolean;
}): boolean {
  if (!input.enabled || !input.hasJudge) return false;
  if (input.aborted) return false;
  if (input.maxRounds <= 0) return false;
  return input.calls < input.maxRounds;
}

export interface JudgeDecision {
  /** 实际生效的结论（可能被铁律改写）。 */
  verdict: JudgeVerdictKind;
  /** 裁判给的理由（降级 / 改判后仍用它做返工要求）。 */
  reason: string;
  warnings: string[];
  /** done 因为没自查被降级成 continue。 */
  downgraded: boolean;
  /** continue 因为同一理由连续两次被改判 blocked。 */
  repeated: boolean;
}

/** 压成一行做比较：换行 / 多余空格不该让"同一个理由"看起来不同。 */
function oneLine(text: string, max = 400): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * 判"同一个理由"的口径：去掉**全部**空白再比。
 * 中文理由里"：缺 X" 与 "：\n缺 X" 是同一句；用一个空格归一反而会把它们判成不同。
 */
function reasonKey(text: string): string {
  return text.replace(/\s+/g, "").slice(0, 400);
}

/**
 * 把裁判的原始输出收敛成可用的四态。
 * 返回 null = 裁判没给出结论（调用失败 / 输出坏了），调用方按原有失败路径走。
 */
export function decideJudgeOutcome(
  outcome: JudgeOutcome,
  previous: JudgeCallRecord | null,
): JudgeDecision | null {
  if (!outcome.ok || !outcome.verdict) return null;

  let verdict: JudgeVerdictKind = outcome.verdict;
  const warnings: string[] = [];
  let downgraded = false;
  let repeated = false;

  if (verdict === "done") {
    // "执行者说完成了不是证据"——裁判自己也得有证据。工具一次没动、
    // 或者 evidence 全是空串，都算没查。
    const selfChecked =
      outcome.toolsUsed > 0 && outcome.evidence.some((item) => item.trim() !== "");
    if (!selfChecked) {
      verdict = "continue";
      downgraded = true;
      warnings.push("裁判没查就给通过（没有工具调用或没有证据），已降级为 continue");
    }
  }

  if (
    verdict === "continue" &&
    previous !== null &&
    previous.verdict === "continue" &&
    reasonKey(previous.reason) === reasonKey(outcome.reason)
  ) {
    // 同一个理由连续出现两次：返工方向没变，再修也是同一处。交人。
    verdict = "blocked";
    repeated = true;
    warnings.push("同一个理由连续出现两次，判 blocked 交人");
  }

  const reason =
    outcome.reason.trim() !== ""
      ? outcome.reason.trim()
      : downgraded
        ? "裁判没查就给通过，按未完成处理"
        : "（裁判未给理由）";
  return { verdict, reason, warnings, downgraded, repeated };
}

/**
 * 拼裁判材料（§2.2 四样：用户原话 / steps 与 writes / 落盘事实 / 执行者自报）。
 * 只做形状收敛与截断，不判断——判断在裁判会话里做。
 */
export function buildJudgeInput(input: {
  ticket: Ticket;
  tasks: PlannedTask[];
  runs: TaskRun[];
  reviews: Review[];
  ticketDir: string;
  failureReason: string;
  maxTools: number;
}): JudgeInput {
  const cwd = input.ticket.options.project?.rootPath ?? input.ticketDir;
  const tasks = input.tasks.map((task, index) => {
    const seq = index + 1;
    const run = input.runs.find((item) => item.seq === seq);
    return {
      seq,
      slug: task.slug,
      title: task.title,
      doneWhen: task.done_when,
      writes: [...(task.writes ?? [])],
      changedPaths: [...(run?.changedPaths ?? [])],
      changedDetected: Array.isArray(run?.changedPaths),
      reportStatus: run?.report?.status ?? null,
      reportSummary: run?.report ? oneLine(run.report.summary, 600) : null,
      reportError: run?.reportError ?? null,
      employee: run?.employee ?? "未知",
    };
  });

  return {
    ticketId: input.ticket.id,
    prompt: input.ticket.prompt,
    steps: [...(input.ticket.steps ?? [])],
    cwd,
    failureReason: input.failureReason,
    tasks,
    reviews: input.reviews.map((review) => ({
      seq: review.seq,
      slug: review.slug,
      verdict: review.verdict,
      reason: review.reason,
    })),
    maxTools: input.maxTools,
  };
}
