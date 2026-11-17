import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { WORKER_TIMEOUT_MS } from "../config.ts";
import { workerToolsArgValue } from "../worker-tools-source.ts";
import type { EmployeeCapabilities } from "../types.ts";
import type { Employee, EmployeeOutcome, EmployeeTask } from "./index.ts";
import { killTree } from "./kill.ts";

const WORKER_ENTRY = fileURLToPath(new URL("../worker-main.ts", import.meta.url));

/** 原生 worker 就在任务目录里跑，产物直接落盘。 */
export const NATIVE_CAPABILITIES: EmployeeCapabilities = {
  artifacts: "taskDir",
  canWriteFiles: true,
};

/**
 * native 的模型覆盖（2026-11-16 通用 worker 配置统一 批1）：
 * 建单快照 `settings.model` 非空时，给 worker 子进程带 `CHANCELLOR_LLM_MODEL`，
 * worker-main 优先读它（其后才是 LLM_MODEL / 默认）。留空 = 不覆盖，回落启动 env——
 * 与"执行器设置里 native 模型框留空"是同一条语义。纯函数，单测直接喂。
 */
export function childEnvWithModel(
  settings: EmployeeTask["settings"],
  base: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const model = settings?.model?.trim();
  if (!model) return base;
  return { ...base, CHANCELLOR_LLM_MODEL: model };
}

/**
 * 原生雇员：起一个独立进程跑 worker-main.ts。
 *
 * 为什么必须是进程：pi-durable 一个进程一个 Harness、一份存储。
 * 在同一进程里再开一个 Harness 会和宰相的库打架。
 */
export function createNativeEmployee(): Employee {
  return {
    kind: "native",
    capabilities: NATIVE_CAPABILITIES,
    run(task: EmployeeTask, signal?: AbortSignal): Promise<EmployeeOutcome> {
      if (signal?.aborted) {
        return Promise.resolve({
          processOk: false,
          exitCode: null,
          timedOut: false,
          aborted: true,
          reportRaw: readReport(task.dir),
          stderrTail: "",
          error: "已停止",
        });
      }

      return new Promise((resolve) => {
        let stderr = "";
        let timedOut = false;
        let aborted = false;
        let settled = false;
        let forceTimer: NodeJS.Timeout | null = null;

        const finish = (outcome: EmployeeOutcome): void => {
          if (settled) return;
          settled = true;
          if (forceTimer) clearTimeout(forceTimer);
          resolve(outcome);
        };

        let child;
        try {
          const workDir = task.workDir ?? task.dir;
          // --tools（2026-11-17 批4）：宿主勾选的工具面；null = 没装配 / 回滚 → 不传参数（全开）。
          const toolsArg = workerToolsArgValue();
          const argv = [WORKER_ENTRY, "--dir", task.dir, "--work-dir", workDir];
          if (toolsArg !== null) argv.push("--tools", toolsArg);
          child = spawn(
            process.execPath,
            argv,
            {
            cwd: workDir,
            stdio: ["ignore", "ignore", "pipe"],
            windowsHide: true,
            env: childEnvWithModel(task.settings, process.env),
            },
          );
        } catch (error) {
          finish({
            processOk: false,
            exitCode: null,
            timedOut: false,
            aborted: false,
            reportRaw: readReport(task.dir),
            stderrTail: "",
            error: `起 worker 子进程失败：${messageOf(error)}`,
          });
          return;
        }

        const timer = setTimeout(() => {
          timedOut = true;
          killTree(child);
          forceTimer = setTimeout(() => {
            finish({
              processOk: false,
              exitCode: null,
              timedOut: true,
              aborted: false,
              reportRaw: readReport(task.dir),
              stderrTail: stderr,
              error: `超时（${WORKER_TIMEOUT_MS}ms）后进程未退出`,
            });
          }, 5000);
        }, WORKER_TIMEOUT_MS);

        const onAbort = (): void => {
          aborted = true;
          killTree(child);
          forceTimer = setTimeout(() => {
            finish({
              processOk: false,
              exitCode: null,
              timedOut: false,
              aborted: true,
              reportRaw: readReport(task.dir),
              stderrTail: stderr,
              error: "已停止",
            });
          }, 5000);
        };
        signal?.addEventListener("abort", onAbort, { once: true });

        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => {
          stderr = tail(stderr + chunk, 8000);
        });

        child.on("error", (error) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          finish({
            processOk: false,
            exitCode: null,
            timedOut: false,
            aborted: false,
            reportRaw: readReport(task.dir),
            stderrTail: stderr,
            error: `worker 子进程出错：${error.message}`,
          });
        });

        child.on("close", (code) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);

          if (timedOut) {
            finish({
              processOk: false,
              exitCode: code,
              timedOut: true,
              aborted: false,
              reportRaw: readReport(task.dir),
              stderrTail: stderr,
              error: `超时（${WORKER_TIMEOUT_MS}ms）被杀`,
            });
            return;
          }
          if (aborted) {
            finish({
              processOk: false,
              exitCode: code,
              timedOut: false,
              aborted: true,
              reportRaw: readReport(task.dir),
              stderrTail: stderr,
              error: "已停止",
            });
            return;
          }

          finish({
            processOk: code === 0,
            exitCode: code,
            timedOut: false,
            aborted: false,
            reportRaw: readReport(task.dir),
            stderrTail: stderr,
            error: code === 0 ? null : `worker 退出码 ${code === null ? "null" : code}`,
          });
        });
      });
    },
  };
}

function readReport(dir: string): string | null {
  try {
    return fs.readFileSync(path.join(dir, "REPORT.md"), "utf8");
  } catch {
    return null;
  }
}

function tail(text: string, max: number): string {
  return text.length <= max ? text : text.slice(-max);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
