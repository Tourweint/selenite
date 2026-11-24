import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { MANAGER_TIMEOUT_MS, profileEnv } from "../config.ts";
import type { ManagerInfo } from "../manager/registry.ts";
import type { EmployeeProfile, ProjectRef, WorkerKind } from "../types.ts";
import { effectiveWorkerTools, workerAllowedTools } from "../worker-tools-source.ts";
import { killTree } from "./kill.ts";
import { getManagerPoolBridge } from "./pool.ts";

const WORKER_ENTRY = fileURLToPath(new URL("../worker-main.ts", import.meta.url));

export interface ManagerTask {
  domain: string;
  requirement: string;
  manager: ManagerInfo;
  /** 这张单落在哪个项目；由总管校验后透传，负责人只读不猜。 */
  project?: ProjectRef;
  /** 父任务单号；子单收口用。 */
  parentTicketId?: string;
  /**
   * 分管子单用的 worker 与参数（2026-11-16 多 CLI）。
   * 子进程里再派单时没有宿主的 ChancellorRequest，只能靠 env 继承。
   */
  employee: WorkerKind;
  employeeProfile: EmployeeProfile;
  /**
   * 宿主注入的宰相身份（批次D D2）。只作为两个字符串透传给子进程，
   * chancellor 不解读；soul 宿主侧已截断 ≤4KB。用 `--opt=value` 形式传，
   * 避免值以 `-` 开头时被 parseArgs 误认成选项、也避免 shell 拆词。
   */
  managerIdentity?: { name: string; soul: string };
  /**
   * 来源宿主对话标识（2026-11-05，跨仓契约）。只透传给子进程，子单据此继承；
   * chancellor 不解读格式与语义。
   */
  originConversationId?: string;
}

export interface ManagerOutcome {
  processOk: boolean;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  /** 分管宰相最后一行结论；没给就是 null。 */
  finalLine: string | null;
  stderrTail: string;
  error: string | null;
}

/**
 * 分管宰相：独立进程里的 pi-durable 实例。
 *
 * 进程按需起、干完退；会话和 SQLite 留在 managers/<domain>/，下次续用。
 * 这里只负责起进程和收最后一行，不解析它的业务结论。
 */
export function runManager(task: ManagerTask, signal?: AbortSignal): Promise<ManagerOutcome> {
  if (signal?.aborted) {
    return Promise.resolve(outcome({ aborted: true, error: "已停止" }));
  }

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let forceTimer: NodeJS.Timeout | null = null;

    const finish = (result: ManagerOutcome): void => {
      if (settled) return;
      settled = true;
      if (forceTimer) clearTimeout(forceTimer);
      resolve(result);
    };

    let child;
    try {
      child = spawn(
        process.execPath,
        [
          WORKER_ENTRY,
          "--role",
          "manager",
          "--dir",
          task.manager.root,
          "--domain",
          task.domain,
          "--requirement",
          task.requirement,
          ...(task.project
            ? [
                "--project-id",
                task.project.id,
                "--project-name",
                task.project.name,
                "--project-root",
                task.project.rootPath,
                ...(task.project.head ? ["--project-head", task.project.head] : []),
                ...(task.project.dataDir
                  ? ["--project-data-dir", task.project.dataDir]
                  : []),
                // 项目全部文件夹（2026-11-24）：manager 子进程再派活时只凭这份 project，
                // 不传的话子单会退回"只给主文件夹"。
                ...(task.project.roots?.length
                  ? ["--project-roots", JSON.stringify(task.project.roots)]
                  : []),
              ]
            : []),
          ...(task.parentTicketId
            ? ["--parent-ticket-id", task.parentTicketId]
            : []),
          ...(task.managerIdentity
            ? [
                `--manager-name=${task.managerIdentity.name}`,
                `--manager-soul=${task.managerIdentity.soul}`,
              ]
            : []),
          ...(task.originConversationId
            ? [`--origin-conversation-id=${task.originConversationId}`]
            : []),
        ],
        {
          cwd: task.manager.work_dir,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          env: {
            ...process.env,
            // 分管子单在子进程里再派活；执行器与模型/权限只能靠 env 带过去。
            CHANCELLOR_EMPLOYEE: task.employee,
            // ticket 准入（2026-11-22 M1b）：manager 的 child ticket 一次只跑一单。
            // 必须显式写，不能靠继承——宿主进程自己的上限是 3。
            CHANCELLOR_MAX_ACTIVE_TICKETS:
              process.env.CHANCELLOR_MANAGER_MAX_ACTIVE_TICKETS?.trim() || "1",
            ...profileEnv(task.employee, task.employeeProfile),
            // 2026-11-22 池桥：manager 子进程里的 `createEmployee("pool")` 没有宿主
            // 注入口，只能按这两个 env 连回宿主。token 只进这一条子进程环境。
            // 只在 manager 的工人档就是 pool 时注入：外部 CLI 打手的子进程不该拿到
            // 宿主池桥的 token（最小权限；它也用不上）。
            ...(() => {
              const bridge = getManagerPoolBridge();
              return task.employee === "pool" && bridge
                ? {
                    CHANCELLOR_POOL_ENDPOINT: bridge.endpoint,
                    CHANCELLOR_POOL_TOKEN: bridge.token,
                  }
                : {};
            })(),
            // 2026-11-22 工具面：宿主勾选的 worker 工具（canonical 四件）带进子进程，
            // 子单的 native / pool 执行器都按同一份名单过滤。没注入 = 不设（全开）。
            ...(() => {
              const allowed = workerAllowedTools();
              return allowed === null
                ? {}
                : { CHANCELLOR_WORKER_TOOLS: effectiveWorkerTools(allowed).join(",") };
            })(),
          },
        },
      );
    } catch (error) {
      finish(outcome({ error: `起分管宰相子进程失败：${messageOf(error)}` }));
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      forceTimer = setTimeout(() => {
        finish(
          outcome({
            timedOut: true,
            stderrTail: stderr,
            error: `超时（${MANAGER_TIMEOUT_MS}ms）后进程未退出`,
          }),
        );
      }, 5000);
    }, MANAGER_TIMEOUT_MS);

    const onAbort = (): void => {
      aborted = true;
      killTree(child);
      forceTimer = setTimeout(() => {
        finish(outcome({ aborted: true, stderrTail: stderr, error: "已停止" }));
      }, 5000);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = tail(stdout + chunk, 16_000);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = tail(stderr + chunk, 8000);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      finish(
        outcome({
          stderrTail: stderr,
          error: `分管宰相子进程出错：${error.message}`,
        }),
      );
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);

      if (timedOut) {
        finish(
          outcome({
            timedOut: true,
            exitCode: code,
            stderrTail: stderr,
            error: `超时（${MANAGER_TIMEOUT_MS}ms）被杀`,
          }),
        );
        return;
      }
      if (aborted) {
        finish(
          outcome({
            aborted: true,
            exitCode: code,
            stderrTail: stderr,
            error: "已停止",
          }),
        );
        return;
      }

      finish(
        outcome({
          processOk: code === 0,
          exitCode: code,
          finalLine: lastLine(stdout),
          stderrTail: stderr,
          error: code === 0 ? null : `分管宰相退出码 ${code === null ? "null" : code}`,
        }),
      );
    });
  });
}

function lastLine(text: string): string | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.length === 0 ? null : (lines[lines.length - 1] ?? null);
}

function outcome(patch: Partial<ManagerOutcome>): ManagerOutcome {
  return {
    processOk: false,
    exitCode: null,
    timedOut: false,
    aborted: false,
    finalLine: null,
    stderrTail: "",
    error: null,
    ...patch,
  };
}

function tail(text: string, max: number): string {
  return text.length <= max ? text : text.slice(-max);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
