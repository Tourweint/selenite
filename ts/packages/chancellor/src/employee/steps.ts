import fs from "node:fs";

/**
 * 外部 CLI 的统一步骤事件（2026-11-23 外部 CLI 流式事件方案 D1）。
 *
 * 只回答「大概干了啥」：工具名 / 操作对象 / 成败。**不塞工具结果全文，也不塞思考过程**。
 * 落点只有两处：任务目录的 `steps.jsonl`（按需查）与任务事件流（任务中心最近动作）。
 * 任何一层都不许把这里的事件拼进总管 / 执事 / 用户的模型上下文。
 */

export type CliStepType = "tool" | "status" | "text";

export interface CliStepEvent {
  type: CliStepType;
  /** 工具名（read / write / bash / …）或状态名。 */
  name?: string;
  /** 一句话细节：文件名 / 命令 / 成败原因摘要，不含结果全文。 */
  detail?: string;
  /** 工具失败或状态失败。 */
  failed?: boolean;
  /** ISO 时间；由 `makeStep` 统一填。 */
  at: string;
}

export interface ToolStats {
  /** 读类工具次数（read / glob / grep / list / 搜索…）。 */
  reads: number;
  /** 写类工具次数（write / edit / apply_patch…）。 */
  writes: number;
  /** 命令执行次数（bash / shell / exec…）。 */
  commands: number;
  /** 其它工具次数。 */
  other: number;
  /** 工具事件总数（含其它）。 */
  total: number;
  /** 失败次数（工具失败或状态失败）。 */
  failed: number;
}

export const STEPS_FILE = "steps.jsonl";

/** 事件时间戳统一在构造处填，适配器只关心语义字段。 */
export function makeStep(
  patch: Omit<CliStepEvent, "at"> & { at?: string },
): CliStepEvent {
  return { ...patch, at: patch.at ?? new Date().toISOString() };
}

const READ_TOOLS = new Set([
  "read",
  "read_file",
  "readfile",
  "read_many_files",
  "glob",
  "grep",
  "list",
  "ls",
  "search",
  "find",
  "websearch",
  "web_search",
  "webfetch",
  "web_fetch",
  "fetch",
  "notebookread",
]);

const WRITE_TOOLS = new Set([
  "write",
  "write_file",
  "edit",
  "multiedit",
  "multi_edit",
  "notebookedit",
  "apply_patch",
  "create_file",
  "str_replace_editor",
  "patch",
]);

const COMMAND_TOOLS = new Set([
  "bash",
  "shell",
  "command",
  "exec",
  "execute_command",
  "run_command",
  "terminal",
  "powershell",
]);

export type ToolCategory = "read" | "write" | "command" | "other";

export function toolCategory(name: string | undefined): ToolCategory {
  const key = (name ?? "").trim().toLowerCase();
  if (READ_TOOLS.has(key)) return "read";
  if (WRITE_TOOLS.has(key)) return "write";
  if (COMMAND_TOOLS.has(key)) return "command";
  return "other";
}

/** 工具参数里挑一句可读细节；只取路径的文件名或命令首行，绝不取结果全文。 */
export function toolDetail(name: string | undefined, input: unknown): string {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return "";
  }
  const record = input as Record<string, unknown>;
  const category = toolCategory(name);
  if (category === "command") {
    return compact(record.command ?? record.cmd ?? record.script ?? "");
  }
  const raw =
    record.file_path ??
    record.filePath ??
    record.path ??
    record.notebook_path ??
    record.pattern ??
    record.query ??
    record.url ??
    record.description ??
    record.prompt ??
    "";
  const text = compact(raw);
  // URL 保留完整（截断到上限），文件路径只留最后一段：够认事，又不把工作目录绝对路径带进界面 / 落盘。
  if (typeof raw === "string" && /^https?:\/\//i.test(raw)) return text;
  if (typeof raw === "string" && looksLikePath(raw) && !text.includes(" ")) {
    const segments = text.replace(/[\\/]+$/, "").split(/[\\/]/);
    return segments[segments.length - 1] ?? text;
  }
  return text;
}

/** 单行、去控制字符、限长；步骤条只要一句。 */
export function compact(value: unknown, max = 120): string {
  if (typeof value !== "string") return "";
  const oneLine = value
    .replace(/\r?\n/g, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
}

function looksLikePath(value: string): boolean {
  return (
    value.includes("/") ||
    value.includes("\\") ||
    /^[A-Za-z]:/.test(value) ||
    /\.(?:[A-Za-z0-9]{1,8})$/.test(value)
  );
}

/** 一行给人看（任务中心最近动作 / steps.jsonl 的 detail 都能用）。 */
export function stepLineOf(step: CliStepEvent): string {
  const name = compact(step.name ?? "", 40);
  const detail = compact(step.detail ?? "", 100);
  if (step.type === "text") return detail || name || "输出";
  if (step.type === "status") {
    const base = detail || name || "状态更新";
    return step.failed ? `${base}（失败）` : base;
  }
  const category = toolCategory(name);
  const verb =
    category === "read"
      ? "读取"
      : category === "write"
        ? "修改"
        : category === "command"
          ? "运行"
          : name || "调用工具";
  const body = detail ? `${verb} ${detail}` : verb;
  return step.failed ? `${body}（失败）` : body;
}

export function emptyToolStats(): ToolStats {
  return { reads: 0, writes: 0, commands: 0, other: 0, total: 0, failed: 0 };
}

/** 从事件序列算统计；只有工具事件计数，状态 / 文本事件只计失败。 */
export function summarizeSteps(steps: readonly CliStepEvent[]): ToolStats {
  const stats = emptyToolStats();
  for (const step of steps) {
    if (step.type === "tool") {
      stats.total += 1;
      const category = toolCategory(step.name);
      if (category === "read") stats.reads += 1;
      else if (category === "write") stats.writes += 1;
      else if (category === "command") stats.commands += 1;
      else stats.other += 1;
    }
    if (step.failed === true) stats.failed += 1;
  }
  return stats;
}

/** 多张任务的统计合并（收口时只回写一行）。 */
export function mergeToolStats(all: readonly ToolStats[]): ToolStats {
  const merged = emptyToolStats();
  for (const stats of all) {
    merged.reads += stats.reads;
    merged.writes += stats.writes;
    merged.commands += stats.commands;
    merged.other += stats.other;
    merged.total += stats.total;
    merged.failed += stats.failed;
  }
  return merged;
}

/**
 * 结果回写的那一行统计（方案 D1：最多一行）。
 * 没有工具事件就返回 null——不给没跑工具的档位硬凑一句。
 */
export function formatStatsLine(stats: ToolStats): string | null {
  if (stats.total === 0 && stats.failed === 0) return null;
  const parts: string[] = [];
  if (stats.reads > 0) parts.push(`读了 ${stats.reads} 个文件`);
  if (stats.commands > 0) parts.push(`跑了 ${stats.commands} 条命令`);
  if (stats.writes > 0) parts.push(`改了 ${stats.writes} 个文件`);
  if (stats.other > 0) parts.push(`调用了 ${stats.other} 次其他工具`);
  const failure = stats.failed > 0 ? `${stats.failed} 次失败` : "";
  if (parts.length === 0) return failure === "" ? null : `（过程：${failure}）`;
  return `（过程：${parts.join("、")}${failure ? `；${failure}` : ""}）`;
}

/** 追加一行 JSON；写失败不挡执行（步骤是旁证，不是交付物）。 */
export function appendStep(file: string, step: CliStepEvent): void {
  try {
    fs.appendFileSync(file, `${JSON.stringify(step)}\n`, "utf8");
  } catch {
    // 磁盘 / 权限问题不打断 CLI；调用方也不该因为步骤落盘失败而判失败。
  }
}

/** 读回任务目录里的步骤（按需查；坏行跳过）。 */
export function readSteps(file: string, limit = 500): CliStepEvent[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: CliStepEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const value = JSON.parse(trimmed) as unknown;
      if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      if (record.type !== "tool" && record.type !== "status" && record.type !== "text") {
        continue;
      }
      out.push({
        type: record.type,
        ...(typeof record.name === "string" ? { name: record.name } : {}),
        ...(typeof record.detail === "string" ? { detail: record.detail } : {}),
        ...(record.failed === true ? { failed: true } : {}),
        at: typeof record.at === "string" ? record.at : "",
      });
    } catch {
      // 半行 / 坏行：跳过，读侧不因为一行坏数据整体失败。
    }
  }
  return out.slice(-limit);
}
