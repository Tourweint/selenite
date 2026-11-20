import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { WORKER_TIMEOUT_MS } from "../config.ts";
import { ESCALATION_LINE_PREFIX, parseEscalationLine, type WorkerEscalation } from "../escalation-payload.ts";

export type { WorkerEscalation };
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
 * 正在跑的 native worker 子进程（按单号索引，2026-11-19 插话统一 批1）。
 *
 * 插话通道的宿主侧：dispatchTask 的任务目录固定是 `<runsRoot>/<ticketId>/<NN>-<slug>`
 * （worktree 副本也是 `<…>/worktrees/<ticketId>/<NN>-<slug>`），所以从 task.dir 的
 * 上一级目录名就能还原单号，不必改 EmployeeTask 契约。子进程 close / error 时摘除。
 */
const liveWorkers = new Map<string, ChildProcess>();

/**
 * 每个活子进程的"超时顺延"回调（2026-11-19 批2）：worker 等上报答复 / 等插话期间
 * 合法地长时间不退出，`WORKER_TIMEOUT_MS` 只该盯"没有活动的跑死"，不该把等待杀掉。
 * stderr 收到上报行、stdin 写入插话（= 有活动）都顺延一次；顺延失败静默（跑死照旧被杀）。
 */
const liveWorkerBumps = new Map<string, () => void>();

/** task.dir 的上一级目录名 = 单号（布局见 liveWorkers 注释）。 */
function ticketIdOfTask(task: EmployeeTask): string | null {
  const parent = path.basename(path.dirname(task.dir));
  return parent || null;
}

function unregisterWorker(ticketId: string | null, child: ChildProcess): void {
  if (!ticketId) return;
  if (liveWorkers.get(ticketId) === child) liveWorkers.delete(ticketId);
  if (liveWorkerBumps.has(ticketId)) liveWorkerBumps.delete(ticketId);
}

/** 转发失败的可识别错误：端点 / 工具据此如实回"worker 不在跑"，而不是笼统失败。 */
export class WorkerNotRunningError extends Error {
  constructor(ticketId: string) {
    super(
      `worker_not_running：单 ${ticketId} 没有在跑的 native worker 子进程（没起、已收尾，或执行器不是本机 native）`,
    );
    this.name = "WorkerNotRunningError";
  }
}

/**
 * 把一条插话写进对应单的 native worker 子进程 stdin（2026-11-19 插话统一 批1）。
 *
 * 消息形状与 worker-main.ts 的 stdin 协议一致：一行 JSON
 * `{"type":"message","mode":"steer"|"followUp","text":"..."}`。
 * 同步 write、不等待消费：worker 已收尾的极端窗口里 EPIPE 只落在 stdin 的
 * error 监听上（run 里已吞掉），不会把宿主打挂；查不到活进程就抛可识别错误。
 * 批2：写入算一次活动，顺延该单的超时计时（等待答复期间不被误杀）。
 */
export function forwardNativeWorkerMessage(
  ticketId: string,
  message: { mode: "steer" | "followUp"; text: string },
): void {
  const child = liveWorkers.get(ticketId);
  if (!child || child.exitCode !== null || !child.stdin || child.stdin.destroyed) {
    throw new WorkerNotRunningError(ticketId);
  }
  child.stdin.write(
    `${JSON.stringify({ type: "message", mode: message.mode, text: message.text })}\n`,
  );
  liveWorkerBumps.get(ticketId)?.();
}

/**
 * 给对应单的 native worker 发一条**控制帧**（2026-11-19 批2）：一行 JSON
 * `{"type":"control","action":"abort"}`。worker-main 收到后立刻停掉续行与等待，
 * 收完已受理的提交就退场。单据作废（cancelTicketAction）时调用——拉检查对不上
 * 作废位的实时性，推送一条比轮询可靠，且复用同一条 stdin 通道（不发明第二条）。
 */
export function abortNativeWorker(ticketId: string): void {
  const child = liveWorkers.get(ticketId);
  if (!child || child.exitCode !== null || !child.stdin || child.stdin.destroyed) {
    throw new WorkerNotRunningError(ticketId);
  }
  child.stdin.write(`${JSON.stringify({ type: "control", action: "abort" })}\n`);
}

/**
 * native 的模型覆盖（2026-11-16 通用 worker 配置统一 批1；2026-11-19 加模型路由）：
 * 建单快照 `settings.model` 非空时，给 worker 子进程带 `CHANCELLOR_LLM_MODEL`，
 * worker-main 优先读它（其后才是 LLM_MODEL / 默认）。留空 = 不覆盖，回落启动 env。
 *
 * `settings.modelRoute`（2026-11-19 模型分工）存在时再带 baseUrl + key：
 * 宿主已按已连接供应商解析好，key 从 base env 的 `keyEnv` 变量现取——
 * 只有变量名进 ticket 快照，密钥值不落盘。纯函数，单测直接喂。
 */
export function childEnvWithModel(
  settings: EmployeeTask["settings"],
  base: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const model = settings?.model?.trim();
  const route = settings?.modelRoute;
  if (!model && !route) return base;
  const env: NodeJS.ProcessEnv = { ...base };
  if (model) env.CHANCELLOR_LLM_MODEL = model;
  if (route) {
    env.CHANCELLOR_LLM_BASE_URL = route.baseUrl;
    const key = base[route.keyEnv]?.trim();
    if (key) env.CHANCELLOR_LLM_API_KEY = key;
  }
  return env;
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
        // 插话通道（2026-11-19 批1）：stdin 从 ignore 改 pipe——worker-main 在 stdin 上
        // 收一行 JSON 消息；不注入时宿主不写它，行为与改动前一致。
        const workerTicketId = ticketIdOfTask(task);
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
            stdio: ["pipe", "ignore", "pipe"],
            windowsHide: true,
            env: childEnvWithModel(task.settings, process.env),
            },
          );
          if (workerTicketId && child.stdin) {
            liveWorkers.set(workerTicketId, child);
            // worker 已退出的窗口里写入会 EPIPE：只吞掉，转发方靠查表如实报"不在跑"。
            child.stdin.on("error", () => undefined);
          }
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
        // 超时顺延（2026-11-19 批2）：等待上报答复 / 插话往来期间有活动就重置计时。
        // 只是把"活动"当作心跳，上限语义不变——连续无活动超过 WORKER_TIMEOUT_MS 照杀。
        const bumpTimeout = (): void => {
          clearTimeout(timer);
          timer.refresh?.();
        };
        if (workerTicketId) liveWorkerBumps.set(workerTicketId, bumpTimeout);

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
        // 决策上报（2026-11-19 批2）：worker 把一条 `[escalate] {json}` 结构行写上
        // stderr（escalation-payload.ts 的线协议），这里逐行解析后经
        // `EmployeeTask.onEscalation` 沿既有事件链送回宿主。行缓冲：chunk 可能把
        // 一行劈成两半，只在完整行上匹配；解析失败静默——stderr 上别的日志行照旧。
        let stderrLineBuf = "";
        child.stderr?.on("data", (chunk: string) => {
          stderr = tail(stderr + chunk, 8000);
          stderrLineBuf += chunk;
          let index = stderrLineBuf.indexOf("\n");
          while (index >= 0) {
            const line = stderrLineBuf.slice(0, index);
            stderrLineBuf = stderrLineBuf.slice(index + 1);
            if (line.includes(ESCALATION_LINE_PREFIX)) {
              const escalation = parseEscalationLine(line);
              if (escalation) {
                bumpTimeout();
                if (task.onEscalation) {
                  try {
                    task.onEscalation(escalation);
                  } catch {
                    // 上报回调失败不拖垮 worker 本体；这条上报丢失由宿主侧日志如实记。
                  }
                } else {
                  // 没有回调（崩溃恢复路径 / 简化装配）：上报没有可去的宿主路由。
                  // 直接 steer 回 worker 让它别等——不给它一个永远等不到的答复，
                  // 等待会一直占着超时顺延（批2 的 bumpTimeout）把进程拖成永活。
                  try {
                    child.stdin?.write(
                      `${JSON.stringify({
                        type: "message",
                        mode: "steer",
                        text:
                          "[插话]\n（系统）这次上报没有投递出去（宿主此刻不接管上报路由）：不要等待答复，" +
                          "按已有信息继续推进；确实要人的部分写进 REPORT.md 的 attention（status 用 blocked + question）。",
                      })}\n`,
                    );
                  } catch {
                    /* stdin 已关：worker 马上会自行退场 */
                  }
                }
              }
            }
            index = stderrLineBuf.indexOf("\n");
          }
        });

        child.on("error", (error) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          unregisterWorker(workerTicketId, child);
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
          unregisterWorker(workerTicketId, child);

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
