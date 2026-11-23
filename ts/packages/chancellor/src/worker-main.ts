import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  contentText,
  createModels,
  createProvider,
  envApiKeyAuth,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  Type,
  type FauxResponseFactory,
  type Message,
  type Model,
  type Models,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  hook,
  ToolTask,
  type Conversation,
  type ConversationId,
  type ToolHookCall,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { buildManagerPrompt } from "./manager-prompt.ts";
import { readManagerMeta, saveManagerMeta, type ManagerMeta } from "./manager/registry.ts";
import { MANAGER_CONTEXT_ROTATE_RATIO, MANAGER_CONTEXT_WINDOW } from "./config.ts";
import { readText, writeText } from "./store.ts";
import { WORKER_TOOL_NAMES, effectiveWorkerTools } from "./worker-tools-source.ts";
import {
  ESCALATION_CONTEXT_MAX,
  ESCALATION_OPTION_MAX,
  ESCALATION_OPTIONS_MAX,
  ESCALATION_QUESTION_MAX,
  escalationLine,
  normalizeEscalationInput,
  workerEscalateToolEnabled,
  workerTurnBudget,
  type WorkerEscalation,
} from "./escalation-payload.ts";
import {
  NO_PROGRESS_FUSE,
  buildContinueInput,
  countToolCallsSince,
  markReportBlocked,
  nextNoProgressStreak,
  planNextRound,
} from "./worker-continue.ts";
import { setInternalAsk } from "./internal.ts";
import type { ProjectRef, QoderResult } from "./types.ts";

/**
 * 原生工作的进程入口，两种角色：
 *
 * - worker（默认）：在 task 目录里把一件活干完，写 REPORT.md。
 * - manager（--role manager --domain <name>）：分管宰相，长期会话 + delegate。
 *
 * worker 绝不在 registry 里装 delegate；manager 的 delegate 参数里没有 domain，
 * 且调用 runChancellor 时写死 managers:false——递归在参数层断掉。
 */

type Role = "worker" | "manager";

const CTX = BACKGROUND_CONTEXT;
const PROVIDER_ID = "bailian";
// canonical 清单搬进 worker-tools-source.ts（宿主配置以它为界）；这里只留引用。
const WORKER_ALLOWED_TOOLS = WORKER_TOOL_NAMES;
const MANAGER_ALLOWED_TOOLS = ["read", "write", "edit", "bash", "delegate"] as const;
const WORKER_ALLOWED = new Set<string>(WORKER_ALLOWED_TOOLS);
const MANAGER_ALLOWED = new Set<string>(MANAGER_ALLOWED_TOOLS);

const WORKER_RULES = `你是 chancellor 的工人。你只做一件被交代的事。

## 你必须遵守
1. 只在给你的任务目录与项目工作目录里工作。不要读写这两个目录之外的任何文件。
2. 干完后，在这个目录写 \`REPORT.md\`，第一个 \`\`\`json 块必须是：
   {"status":"ready|waiting|blocked|failed|dropped","summary":"一句话","artifacts":["相对路径"],"attention":{"question":"...","kind":"need_input|need_decision|need_action"}}
   \`attention\` 可选，只在 blocked 且需要人回答/拍板/动手时填。
3. \`status\` 是**最终结论**，不是你跑没跑完：
   ready=目标达成待验收；waiting=这轮干完还差东西；blocked=需要人；failed=失败结束；
   dropped=这活本来不用做（summary 里说明理由）。progress 只能中途上报，最终 REPORT 不许用。
4. blocked 且要人帮忙时，\`attention.question\` 要具体到对方能直接回答；\`kind\` 只能三选一。
   不要写“卡住了，请指示”这种敷衍问题。
5. \`artifacts\` 只列产物，不要列 \`REPORT.md\` 和 \`TASK.md\`。
6. 写完必须用 \`read\` 把 \`artifacts\` 里每个文件读回来，确认存在且内容对；**没读到就不许写 \`status:"ready"\`**。
   自检只核对文件在不在、内容对不对，不判任务是否达成。
7. \`done_when\` 指定的文件名、格式、条数，照抄，不要自己改名。
8. 你没有跟人说话的工具。不要试图找人确认，按已有信息做判断；需要人时写进 \`attention\`。`;

const { values } = parseArgs({
  options: {
    dir: { type: "string" },
    "list-tools": { type: "boolean" },
    role: { type: "string" },
    domain: { type: "string" },
    requirement: { type: "string" },
    "project-id": { type: "string" },
    "project-name": { type: "string" },
    "project-root": { type: "string" },
    "project-head": { type: "string" },
    "project-data-dir": { type: "string" },
    "work-dir": { type: "string" },
    "parent-ticket-id": { type: "string" },
    // 宿主注入的宰相身份（批次D D2）；只在 manager 角色用，worker 角色不认这两个参数。
    "manager-name": { type: "string" },
    "manager-soul": { type: "string" },
    // 来源宿主对话标识（2026-11-05）：只透传给子单，chancellor 不解读。
    "origin-conversation-id": { type: "string" },
    // 宿主勾选的 worker 工具面（2026-11-17 批4）：逗号分隔，交集约束在 canonical 四件；
    // 不传 = 全开（旧行为）。
    tools: { type: "string" },
  },
  allowPositionals: true,
});

const role: Role = values.role?.trim() === "manager" ? "manager" : "worker";
const rootDir = path.resolve(values.dir ?? process.cwd());
const domain = values.domain?.trim() ?? "";

if (role === "manager") {
  startManager().catch((error: unknown) => {
    log(`[manager] 失败：${messageOf(error)}`);
    process.exitCode = 1;
  });
} else {
  startWorker().catch((error: unknown) => {
    log(`[worker] 失败：${messageOf(error)}`);
    process.exitCode = 1;
  });
}

async function startWorker(): Promise<void> {
  const taskDir = rootDir;
  const workDir = path.resolve(values["work-dir"] ?? rootDir);
  if (values["list-tools"]) {
    printTools(buildWorkerRegistry("", [taskDir, workDir]));
    return;
  }
  await runWorkerMain(
    taskDir,
    workDir,
    path.join(taskDir, ".agent.sqlite"),
    // 区分「没传（全开）」与「传了空串（宿主明确勾成零工具）」：只按 undefined 判断。
    values.tools === undefined ? undefined : values.tools,
  );
}

async function startManager(): Promise<void> {
  if (!domain) throw new Error("manager 角色必须给 --domain");
  const meta = readManagerMeta(rootDir);
  if (!meta) {
    throw new Error(`找不到分管领域的 meta.json：${rootDir}（领域只能由总管明确指定后创建）`);
  }
  if (meta.domain !== domain) {
    throw new Error(`--domain ${domain} 与 meta.json 里的 ${meta.domain} 不一致`);
  }
  if (values["list-tools"]) {
    printTools(buildManagerRegistry(meta));
    return;
  }
  const requirement = values.requirement?.trim() ?? "";
  if (!requirement) throw new Error("manager 角色必须给 --requirement");
  const project = readProjectArgs();
  const parentTicketId = values["parent-ticket-id"]?.trim() || undefined;
  const originConversationId = values["origin-conversation-id"]?.trim() || undefined;
  await runManagerMain(
    rootDir,
    meta,
    requirement,
    project,
    parentTicketId,
    readManagerIdentity(),
    originConversationId,
  );
}

/**
 * 宿主注入的身份只收两个字符串，缺任一个就当没有（与改动前提示词完全一致）。
 * 用 `--opt=value` 传，因此这里读到的是原文，不改写一个字。
 */
function readManagerIdentity(): { name: string; soul: string } | undefined {
  const name = values["manager-name"];
  const soul = values["manager-soul"];
  if (name === undefined || soul === undefined) return undefined;
  return { name, soul };
}

function readProjectArgs(): ProjectRef | undefined {
  const id = values["project-id"]?.trim() ?? "";
  const name = values["project-name"]?.trim() ?? "";
  const rootPath = values["project-root"]?.trim() ?? "";
  if (!id && !name && !rootPath) return undefined;
  if (!id || !rootPath) {
    throw new Error("--project-id 与 --project-root 必须成对给");
  }
  const head = values["project-head"]?.trim() || null;
  const dataDir = values["project-data-dir"]?.trim() || undefined;
  return { id, name, rootPath, head, ...(dataDir ? { dataDir } : {}) };
}

function printTools(registry: ReturnType<typeof createRegistry>): void {
  const names = registry
    .snapshot()
    .tools()
    .map((entry) => entry.tool.name);
  process.stdout.write(`${names.join("\n")}\n`);
}

/**
 * `ESCALATION_CHAIN_ENABLED`（批2 回滚开关，宿主侧同一把）：false / 0 / off =
 * 上报链整体降级为现状 attention 直达人。escalate 工具仍可注册（由
 * `WORKER_ESCALATE_TOOL` 单独管），但工具结果引导 worker 走老通道
 * （REPORT.md 的 attention），宿主侧不路由 escalation。
 */
function escalationChainEnabled(): boolean {
  const raw = process.env.ESCALATION_CHAIN_ENABLED?.trim().toLowerCase();
  if (!raw) return true;
  return raw !== "false" && raw !== "0" && raw !== "off";
}

/** v0.3 的工人流程：一次性会话，干完就退（批2 起例外：上报等待中挂起不退）。 */
async function runWorkerMain(
  taskDir: string,
  workDir: string,
  dbPath: string,
  toolsArg?: string,
): Promise<void> {
  const taskText = fs.readFileSync(path.join(taskDir, "TASK.md"), "utf8");
  const systemPrompt = `${WORKER_RULES}\n\n---\n\n${taskText}`;
  // 决策上报（2026-11-19 批2）：`WORKER_ESCALATE_TOOL=false` → 工具不注册（回滚形态）。
  const escalateOn = workerEscalateToolEnabled();
  // 任务单号从目录布局还原（与 employee/native.ts 的 ticketIdOfTask 同一布局）：
  // `<runsRoot>/<ticketId>/<NN>-<slug>`。还原不出（手工目录里直接跑）= 上报只发不路由，
  // 宿主侧解析不到单号会丢弃——如实打一行日志。
  const ticketId = path.basename(path.dirname(path.resolve(taskDir))) || "";
  if (escalateOn && !ticketId) {
    log("[worker] 上报工具已开但目录布局还原不出单号，上报仍会发出（宿主可能不路由）");
  }

  // 上报状态由 escalate 工具写、主循环读：闭包包一层，registry 构建期捕获回调。
  const escalationState: { pending: WorkerEscalation | null } = { pending: null };
  let abortedByHost = false;
  const submitEscalate = (
    args: Record<string, unknown>,
  ): { ok: true } | { ok: false; message: string } => {
    if (!escalationChainEnabled()) {
      return {
        ok: false,
        message:
          "上报链已关闭（ESCALATION_CHAIN_ENABLED=false）：请把这个问题写进 REPORT.md 的 " +
          'attention 字段（status 用 blocked），走"需要人答复"的老通道；本轮正常收尾。',
      };
    }
    if (escalationState.pending) {
      return {
        ok: false,
        message:
          `已有一条上报在等答复（escalationId=${escalationState.pending.escalationId.slice(0, 8)}），` +
          "一次只能等一条；先收尾本轮，答复到了再继续。",
      };
    }
    const normalized = normalizeEscalationInput(args);
    if (!normalized.ok) return { ok: false, message: normalized.message };
    escalationState.pending = normalized.value;
    // 线协议（escalation-payload.ts）：一条 `[escalate] {json}` 结构行写上 stderr，
    // 宿主（employee/native.ts）逐行解析后沿既有事件链送回派活方会话。
    process.stderr.write(`${escalationLine(normalized.value)}\n`);
    return { ok: true };
  };

  const registry = buildWorkerRegistry(systemPrompt, [taskDir, workDir], {
    escalate: escalateOn,
    submitEscalate,
  });
  const registeredTools = registry.snapshot().tools();
  const toolNames = registeredTools.map((entry) => entry.tool.name);
  // 显式列出工具：就算别处误装了 delegate，它也进不了这个会话。
  // --tools（2026-11-17 批4）：宿主勾选的面，交集钉死在 canonical 四件；
  // 不传 = 全开；传了（哪怕空串 / 全乱值）= 按交集跑，筛空就是真零工具
  // （worker 只凭 TASK.md 回话，REPORT 缺失由验收如实报，不静默回退全开）。
  // escalate（批2）不进 --tools 白名单口径（宿主勾的是干活工具），开关开着就随行上架。
  const requestedTools =
    toolsArg === undefined
      ? WORKER_ALLOWED_TOOLS
      : toolsArg
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean);
  const effectiveTools = effectiveWorkerTools(requestedTools);
  const allowedSet = new Set<string>([...effectiveTools, ...(escalateOn ? ["escalate"] : [])]);
  const allowedRegistrations = registeredTools
    .map((entry) => entry.tool)
    .filter((tool) => allowedSet.has(tool.name));

  // 这行是隔离验收的证据：进程、cwd、库、工具清单都打出来。
  log(
    `[worker] pid=${process.pid} parent=${process.ppid} cwd=${workDir} taskDir=${taskDir} db=${dbPath} tools=${allowedRegistrations.map((tool) => tool.name).join(",") || "none"}`,
  );

  const { models, model } = buildModels("worker");
  const storage = await openNodeSqliteStorage(dbPath);
  let harness: Harness | null = null;
  try {
    harness = await Harness.open(
      storage,
      {
        models,
        registry,
        env: () => new NodeExecutionEnv({ cwd: workDir }),
        onReport: (error, info) => {
          log(`[worker] ${info.type}: ${messageOf(error)}`);
        },
      },
      CTX,
    );
    harness.resume();

    const conversation = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model,
          tools: allowedRegistrations,
        },
      },
      CTX,
    );

    // 插话通道（2026-11-19 插话统一 批1）：宿主往 stdin 写一行 JSON
    //   {"type":"message","mode":"steer"|"followUp","text":"..."}
    // 收到就 conversation.submit（whenBusy 同 mode）——durable 收下，不拒不丢：
    // steer 插进正在跑的这一轮（下一边界生效），followUp 排到本轮收尾之后。
    // 批2 追加两种语义（仍同一条管道，不发明第二条）：
    //   {"type":"control","action":"abort"} —— 单据作废时宿主推送的终止帧，
    //     worker 停止续行与等待，收完已受理的提交就退场；
    //   message 且当前有上报未答 —— 第一条消息视为上报的答复，解除等待。
    // 退场条件：已受理的输入全部收尾、无上报等待、续行判定不再武装，就退
    // （见下方主循环）；收尾之后再写 stdin 会得到 EPIPE，宿主据此如实回"不在跑"。
    const pending: Promise<void>[] = [];
    let lastStatus: string | null = null;
    const submitInput = async (
      content: string,
      whenBusy?: "steer" | "followUp",
    ): Promise<void> => {
      try {
        const submission = await conversation.submit(
          whenBusy === undefined
            ? { type: "input", content }
            : { type: "input", content, whenBusy },
          CTX,
        );
        const record = await submission.wait(CTX);
        lastStatus = record.status;
      } catch (error) {
        // 宿主插话消费失败只记一笔，不拖垮整单；初始任务失败按改动前语义上抛。
        if (whenBusy === undefined) throw error;
        log(`[worker] 插话（${whenBusy}）没有进会话：${messageOf(error)}`);
      }
    };
    pending.push(submitInput("开始"));

    // 等待期的唤醒器：stdin 有新行（答复 / 控制）时唤醒，超时轮询父进程存活。
    const stdinWakers: Array<() => void> = [];
    let stdinClosed = false;
    const PARENT_POLL_MS = 5_000;
    const parentAlive = (): boolean => {
      try {
        if (process.ppid <= 0) return false;
        process.kill(process.ppid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const wakeStdinWaiters = (): void => {
      for (const wake of stdinWakers.splice(0, stdinWakers.length)) wake();
    };
    /**
     * 等下一条 stdin 输入（上报答复）：stdin 来了 → true；
     * stdin 关闭 / 父进程没了（答复永远不会来）→ false，等待方据此退场。
     */
    const waitForStdinOrParentGone = (): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        let settled = false;
        const done = (value: boolean): void => {
          if (settled) return;
          settled = true;
          clearInterval(poll);
          resolve(value);
        };
        stdinWakers.push(() => done(true));
        const poll = setInterval(() => {
          if (!parentAlive()) done(false);
        }, PARENT_POLL_MS);
      });

    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          log("[worker] stdin 消息不是合法 JSON，忽略");
          continue;
        }
        const frame = parsed as { type?: unknown; mode?: unknown; text?: unknown; action?: unknown };
        // 控制帧（批2）：单据作废 → 立即停止续行与等待，收完已受理的提交就退。
        if (frame?.type === "control" && frame.action === "abort") {
          abortedByHost = true;
          escalationState.pending = null;
          log("[worker] 收到宿主终止帧：停止续行与等待");
          wakeStdinWaiters();
          continue;
        }
        if (
          frame?.type !== "message" ||
          typeof frame.text !== "string" ||
          frame.text.trim() === ""
        ) {
          log('[worker] stdin 消息形状不认识，忽略（只收 {"type":"message","mode","text"} / {"type":"control","action":"abort"}）');
          continue;
        }
        // 上报等待中的第一条消息 = 答复（宿主侧总管/用户答复都走这条 steer）。
        if (escalationState.pending) {
          log(
            `[worker] 上报收到答复 escalationId=${escalationState.pending.escalationId.slice(0, 8)} chars=${frame.text.length}`,
          );
          escalationState.pending = null;
        }
        const mode = frame.mode === "followUp" ? "followUp" : "steer";
        pending.push(submitInput(frame.text, mode));
        wakeStdinWaiters();
      }
    });
    process.stdin.on("error", () => undefined);
    process.stdin.on("close", () => {
      stdinClosed = true;
      wakeStdinWaiters();
    });

    // ── 主循环（批2 重排：插话排水 → 上报等待 → 自主续行）────────────
    // 每一圈先排空已受理的提交；没有提交可等时，要么挂起等上报答复（不退场、
    // 不续轮），要么按 REPORT.md 状态与预算决定要不要自动接一段续轮。
    const maxBudget = workerTurnBudget();
    let usedBudget = 0;
    let noProgressStreak = 0;
    const contextMessages = async (): Promise<readonly Message[]> =>
      (await conversation.context(CTX)).messages;
    const readReportJson = (): { status: string | null; summary: string | null } => {
      try {
        const raw = fs.readFileSync(path.join(taskDir, "REPORT.md"), "utf8");
        const match = /```json\s*([\s\S]*?)```/i.exec(raw);
        if (!match || match[1] === undefined) return { status: null, summary: null };
        const data = JSON.parse(match[1]) as { status?: unknown; summary?: unknown };
        const status =
          typeof data.status === "string" ? (data.status === "done" ? "ready" : data.status) : null;
        const summary = typeof data.summary === "string" ? data.summary : null;
        return { status, summary };
      } catch {
        return { status: null, summary: null };
      }
    };

    while (true) {
      const batch = pending.splice(0, pending.length);
      if (batch.length > 0) {
        await Promise.all(batch);
        continue;
      }
      if (abortedByHost) {
        log("[worker] 宿主已终止这张单：停止续行，收尾退场");
        break;
      }
      if (escalationState.pending) {
        // 上报等待中：不武装续轮、也不退场，等答复经插话通道进来再继续。
        log(
          `[worker] 上报等待答复中 escalationId=${escalationState.pending.escalationId.slice(0, 8)} urgency=${escalationState.pending.urgency}`,
        );
        const woke = stdinClosed ? false : await waitForStdinOrParentGone();
        if (!woke) {
          log("[worker] 等待答复期间 stdin/宿主已关闭：放弃等待，退场");
          process.exitCode = 1;
          break;
        }
        continue;
      }
      // 每段续轮前重查宿主是否还活着：宿主没了，续出来的活没人验收，立即退。
      if (!parentAlive()) {
        log("[worker] 宿主进程已不在：停止续行，退场");
        process.exitCode = 1;
        break;
      }
      const report = readReportJson();
      const decision = planNextRound({
        reportStatus: report.status,
        usedBudget,
        maxBudget,
        noProgressStreak,
      });
      if (decision.kind === "stop") {
        if (decision.reason === "fuse") {
          markReportBlocked(
            taskDir,
            `续行保险丝触发：连续 ${NO_PROGRESS_FUSE} 个续行轮没有一次工具调用，停止续行（需要人接管）。`,
          );
          log(`[worker] 续行保险丝触发（连续 ${NO_PROGRESS_FUSE} 轮无工具调用）：REPORT 已改 blocked，退场`);
        } else if (decision.reason === "budget") {
          log(`[worker] 续行预算用尽（${usedBudget}/${maxBudget}）：按当前 REPORT 退场`);
        } else if (decision.reason === "terminal") {
          log(`[worker] REPORT 已是终态（${report.status}）：退场`);
        } else {
          log("[worker] 续行已关（WORKER_TURN_BUDGET=0）：按当前 REPORT 退场");
        }
        break;
      }
      // 自动武装下一段续轮：followUp 提交（空闲时等价新一轮）。
      usedBudget += 1;
      const before = (await contextMessages()).length;
      await submitInput(buildContinueInput(usedBudget, report.summary), "followUp");
      const toolCalls = countToolCallsSince(await contextMessages(), before);
      noProgressStreak = nextNoProgressStreak(noProgressStreak, toolCalls);
      log(
        `[worker] 续行轮 ${usedBudget}/${maxBudget} 工具调用=${toolCalls} 无进展连击=${noProgressStreak}`,
      );
    }
    // 插话窗口到此关闭：停掉 stdin，宿主后续写入会失败并如实上报。
    process.stdin.destroy();
    if (lastStatus !== "done") {
      log(`[worker] 本轮没有正常收尾：${lastStatus ?? "unknown"}`);
      process.exitCode = 1;
    }
  } finally {
    if (harness) {
      await harness.close(CTX).catch((error: unknown) => {
        log(`[worker] 关闭 Harness 失败：${messageOf(error)}`);
        process.exitCode = 1;
      });
    } else {
      await storage.close(CTX).catch(() => undefined);
    }
  }
}

/**
 * 分管宰相：复用 meta.json 里的会话，把这一轮的最后一行结论写到 stdout。
 *
 * 进程每次新起，会话和 SQLite 都在磁盘上续用——「常驻」是状态常驻，不是进程常驻。
 */
async function runManagerMain(
  root: string,
  meta: ManagerMeta,
  requirement: string,
  project?: ProjectRef,
  parentTicketId?: string,
  identity?: { name: string; soul: string },
  originConversationId?: string,
): Promise<void> {
  const registry = buildManagerRegistry(meta, project, parentTicketId, identity, originConversationId);
  const registeredTools = registry.snapshot().tools();
  const toolNames = registeredTools.map((entry) => entry.tool.name);
  const allowedRegistrations = registeredTools
    .map((entry) => entry.tool)
    .filter((tool) => MANAGER_ALLOWED.has(tool.name));

  log(
    `[manager] pid=${process.pid} parent=${process.ppid} domain=${meta.domain} cwd=${meta.work_dir} db=${meta.db_path} tools=${toolNames.join(",")}`,
  );

  const { models, model } = buildModels("manager");
  // 2026-11-22：manager 进程里再派子单时，拆单用的是 `askInternal()`——host 进程
  // 注入的核心模型在这里不存在，旧兜底会去 spawn Qoder CLI（本机未配 → 整个
  // managed 路径拆单失败）。用 manager 自己刚建好的模型装一份内部 ask：
  // 同一个上游、不挂工具、纯文本完成。
  installManagerInternalAsk(models, model);
  const storage = await openNodeSqliteStorage(meta.db_path);
  let harness: Harness | null = null;
  try {
    harness = await Harness.open(
      storage,
      {
        models,
        registry,
        env: () => new NodeExecutionEnv({ cwd: meta.work_dir }),
        // 负责人的自动压缩阈值对齐 §5.7：到 60% 就阻塞压缩，留 40% 给回答。
        // 手动换段在 runManagerMain 末尾做；这里只是兜底，防单轮直接顶到窗口。
        settings: {
          compaction: {
            reserveTokens: Math.max(
              1,
              Math.floor(MANAGER_CONTEXT_WINDOW * (1 - MANAGER_CONTEXT_ROTATE_RATIO)),
            ),
          },
        },
        onReport: (error, info) => {
          log(`[manager] ${info.type}: ${messageOf(error)}`);
        },
      },
      CTX,
    );
    harness.resume();

    let conversation =
      meta.conversation_id === null
        ? undefined
        : await harness.conversation(meta.conversation_id as ConversationId, CTX);
    const reused = conversation !== undefined;

    if (!conversation) {
      conversation = await harness.createConversation(
        {
          ownership: { kind: "ownerless" },
          agent: {
            model,
            tools: allowedRegistrations,
            cwd: meta.work_dir,
          },
        },
        CTX,
      );
    } else {
      // 复用时要确认模型、工具、工作目录仍是当前配置，避免旧会话带着过期权限跑。
      await conversation.configure(
        { model, tools: allowedRegistrations, cwd: meta.work_dir },
        CTX,
      );
    }

    saveManagerMeta(root, {
      ...meta,
      conversation_id: conversation.id,
      updated_at: new Date().toISOString(),
    });

    const before = await conversation.context(CTX);
    log(
      `[manager] conversation=${conversation.id} reused=${reused} history=${before.messages.length}`,
    );

    const submission = await conversation.submit(
      { type: "input", content: requirement },
      CTX,
    );
    const record = await submission.wait(CTX);
    const view = await conversation.context(CTX);
    const text = lastAssistantText(view.messages);

    // §5.7：到窗口 60% 就自动处理，不打扰用户。
    // 本轮正常收尾 = 告一段落 → 换新段（交接笔记落 handoff.md，旧段仍在 sqlite 里）；
    // 没有正常收尾 → 压缩，保留同一段上下文，避免把没做完的线索也扔掉。
    const rotateAt = Math.floor(MANAGER_CONTEXT_WINDOW * MANAGER_CONTEXT_ROTATE_RATIO);
    const estimated = estimateTokens(view.messages);
    if (estimated >= rotateAt) {
      try {
        if (record.status === "done" && text) {
          const handoff = buildHandoff(meta.domain, requirement, view.messages);
          const handoffFile = path.join(root, "handoff.md");
          const previous = readText(handoffFile);
          writeText(
            handoffFile,
            previous && previous.trim() !== "" ? `${previous.trimEnd()}\n\n---\n\n${handoff}` : handoff,
          );
          await conversation.reset(handoff, CTX);
          const current = readManagerMeta(root) ?? meta;
          saveManagerMeta(root, {
            ...current,
            conversation_id: conversation.id,
            updated_at: new Date().toISOString(),
            rotations: (meta.rotations ?? 0) + 1,
          });
          log(
            `[manager] 上下文 ${estimated}/${MANAGER_CONTEXT_WINDOW} 到阈值，已换段（第 ${
              (meta.rotations ?? 0) + 1
            } 次）`,
          );
        } else {
          await conversation.compact(undefined, CTX);
          log(`[manager] 上下文 ${estimated}/${MANAGER_CONTEXT_WINDOW} 到阈值，未告一段落，已压缩`);
        }
      } catch (error) {
        // 换段/压缩失败不能把这一轮结论也吞掉；只记一笔，下轮再试。
        log(`[manager] 上下文处理失败：${messageOf(error)}`);
      }
    }

    if (record.status !== "done") {
      log(`[manager] 本轮没有正常收尾：${record.status}`);
      process.exitCode = 1;
      return;
    }
    if (!text) {
      log("[manager] 本轮没有助手输出");
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${lastLine(text)}\n`);
  } finally {
    if (harness) {
      await harness.close(CTX).catch((error: unknown) => {
        log(`[manager] 关闭 Harness 失败：${messageOf(error)}`);
        process.exitCode = 1;
      });
    } else {
      await storage.close(CTX).catch(() => undefined);
    }
  }
}

function buildWorkerRegistry(
  prompt: string,
  dirs: string[],
  escalate?: {
    escalate: boolean;
    submitEscalate: (args: Record<string, unknown>) => { ok: true } | { ok: false; message: string };
  },
) {
  const registry = createRegistry();
  // 底座自带的读写改跑。只有这四个，没有 delegate。
  registry.install(CodingTools);
  registry.install(
    defineExtension({
      name: "chancellor-worker",
      // 决策上报工具（2026-11-19 批2）：`WORKER_ESCALATE_TOOL=false` 时不注册，
      // 工具面与改动前完全一致（回滚形态）。它不写盘、不起进程，只通过 stderr
      // 把一条上报送回宿主，因此不走宿主 WRITE_TOOLS 闸门。
      ...(escalate?.escalate
        ? { tools: [buildEscalateTool(escalate.submitEscalate)] }
        : {}),
      sections: [{ key: "task", render: () => prompt }],
      hooks: [
        hook(ToolTask, {
          beforeTool: (call: ToolHookCall) => {
            // escalate 不在 WORKER_ALLOWED（canonical 四件）里，开关开着时单独放行；
            // 关着时它根本没注册，模型看不到。
            if (call.name !== "escalate" && !WORKER_ALLOWED.has(call.name)) {
              return { block: `工具 ${call.name} 未获授权` };
            }
            return restrictPaths(call, dirs, "只能读写任务目录与项目工作目录内的文件");
          },
        }),
      ],
    }),
  );
  return registry;
}

/**
 * 决策上报工具（2026-11-19 批2）。worker 跑动中遇到要拍板 / 要问人的事调它；
 * 上报经 stderr 结构行送回宿主（走 attention/REPORT 同一条 stderr 实时流的可靠路），
 * 答复经批1 插话通道（steer）回到会话。工具立即返回：worker 本轮收尾后挂起等待，
 * 不退场、不自己猜答案。
 */
function buildEscalateTool(
  submitEscalate: (args: Record<string, unknown>) => { ok: true } | { ok: false; message: string },
) {
  return defineTool({
    name: "escalate",
    description:
      "把一个需要拍板 / 需要人回答的问题上报（决策上报链：宿主→总管→用户逐级处理）。" +
      "只在**真有分叉**时用：两条都合理的路线要人选、缺一个只有人知道的事实、" +
      "要不要做一件不可逆 / 花钱的事。能从文件、任务书、记忆里查到的先自己查，别上报。" +
      "**一次只报一件事**；发出后本轮先收尾，不要自己猜答案、也不要另找路子——" +
      "答复会以插话形式回到会话，到时你自然能看到。",
    parameters: Type.Object({
      question: Type.String({
        description: `要拍板 / 要问的那一句话，具体到对方能直接回答（例：「目录结构选 A 还是 B」）；≤${ESCALATION_QUESTION_MAX} 字`,
      }),
      context: Type.String({
        description: `背景：为什么问、已经试过什么、各自的代价，让答的人不用猜；≤${ESCALATION_CONTEXT_MAX} 字`,
      }),
      options: Type.Optional(
        Type.Array(Type.String(), {
          description: `候选答案，最多 ${ESCALATION_OPTIONS_MAX} 条、每条 ≤${ESCALATION_OPTION_MAX} 字；没有明确选项就不给`,
        }),
      ),
      urgency: Type.Optional(
        Type.Union([Type.Literal("low"), Type.Literal("normal"), Type.Literal("high")], {
          description: "紧急度：high=卡着整单、normal=影响这一步、low=可以慢慢答；缺省 normal",
        }),
      ),
    }),
    async execute(args) {
      const result = submitEscalate(args as Record<string, unknown>);
      // 统一一句话回给模型：受理了就说清"等答复"的纪律；拒绝就说原因。
      const text = result.ok
        ? "上报已发出，进入等待：本轮先收尾（REPORT.md 可照常更新），不要自己猜答案、" +
          "不要重试别的路、也不要再上报第二件事。答复会以插话形式回到会话，收到后按它继续。"
        : `上报没有发出：${result.message}`;
      return { output: [{ type: "text" as const, text }] };
    },
  });
}

function buildManagerRegistry(
  meta: ManagerMeta,
  project?: ProjectRef,
  parentTicketId?: string,
  identity?: { name: string; soul: string },
  originConversationId?: string,
) {
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(
    defineExtension({
      name: "chancellor-manager",
      tools: [buildDelegateTool(meta, project, parentTicketId, originConversationId)],
      // identity 在 registry 构建时由 section 闭包捕获（每次派单新起一个进程）。
      // 因此新身份只对新进程 / 新一轮生效，不会改写已续用会话里的旧提示词历史——
      // 与宿主「SOUL 改完下一轮生效」的版本化口径一致。
      sections: [{ key: "manager", render: () => buildManagerPrompt(meta, project, identity) }],
      hooks: [
        hook(ToolTask, {
          beforeTool: (call: ToolHookCall) => {
            if (!MANAGER_ALLOWED.has(call.name)) {
              return { block: `工具 ${call.name} 未获授权` };
            }
            return restrictPaths(call, [meta.work_dir], "只能读写本领域工作目录内的文件");
          },
        }),
      ],
    }),
  );
  return registry;
}

/**
 * 分管宰相唯一的派活工具。
 *
 * 参数里没有 domain——它没法指定领域；调用 runChancellor 时写死 managers:false——
 * 它也没法再建一层分管宰相。递归断在参数层，不靠提示词自觉。
 */
function buildDelegateTool(
  meta: ManagerMeta,
  project?: ProjectRef,
  parentTicketId?: string,
  originConversationId?: string,
) {
  return defineTool({
    name: "delegate",
    description:
      "把一个多步任务交给 chancellor 的工人集群：它会自己拆单、派活、验收，返回一行结论。只有 requirement 一个参数；不能指定领域，也不会再创建分管宰相。",
    parameters: Type.Object({
      requirement: Type.String({
        description: "要办的事，一句话说清目标和完成标准",
      }),
    }),
    async execute(args, _api, context) {
      const { runChancellor } = await import("./index.ts");
      const result = await runChancellor(
        {
          requirement: args.requirement,
          managers: false,
          workRoot: meta.runs_dir,
          // 子任务沿用本单的项目，不再另找落点。
          ...(project ? { project } : {}),
          // 子单记父单号：父单完成闸门要能看到自己所有子单。
          ...(parentTicketId ? { parentTicketId } : {}),
          // 子单继承父单的来源对话标识（只透传，不解读）。
          ...(originConversationId ? { originConversationId } : {}),
        },
        { signal: context.abortSignal },
      );
      return { output: [{ type: "text" as const, text: result.line }] };
    },
  });
}

function restrictPaths(
  call: ToolHookCall,
  dirs: string[],
  message: string,
): { block: string } | undefined {
  if (call.name !== "read" && call.name !== "write" && call.name !== "edit") {
    return undefined;
  }
  const args = call.arguments as Record<string, unknown>;
  const raw = args.path;
  if (typeof raw === "string" && !dirs.some((dir) => isInside(dir, raw))) {
    return { block: message };
  }
  return undefined;
}

function isInside(parent: string, child: string): boolean {
  const resolved = path.resolve(parent, child);
  const rel = path.relative(parent, resolved);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * manager 进程的内部模型（拆单用）。
 *
 * 宿主进程由 `installInternalAsk()` 注入核心模型；manager 是独立进程，拿不到
 * 那份注入。以前没有注入时 `askInternal()` 回落到 Qoder CLI，而 Qoder 在
 * 「只维护本机运行时」的部署里没有配置 → 所有 managed 子单拆单 ENOENT。
 * 这里用 manager 自己的 `models` / `model` 做同一个纯文本完成。
 */
function installManagerInternalAsk(
  models: Models,
  model: { provider: string; modelId: string },
): void {
  setInternalAsk(async (call) => {
    const target = models.getModel(model.provider, model.modelId);
    if (!target) {
      return internalFailure(`内部模型不在模型目录里：${model.provider}/${model.modelId}`);
    }
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, call.timeoutMs);
    const onAbort = (): void => controller.abort();
    call.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await models.completeSimple(
        target,
        {
          systemPrompt: "你是一个只输出所要求格式的内部文本模型。不要输出解释、前言或额外内容。",
          messages: [{ role: "user", content: call.prompt, timestamp: Date.now() }],
        },
        {
          signal: controller.signal,
          maxTokens: call.label === "plan" ? 4000 : 1600,
          temperature: 0,
        },
      );
      if (response.stopReason === "aborted") {
        return internalFailure(timedOut ? "内部模型超时" : "已停止", {
          ...(timedOut ? { timedOut: true } : { aborted: true }),
        });
      }
      if (response.stopReason === "error") {
        log(
          `[manager] 内部模型 ${call.label} 调用失败：${(response.errorMessage ?? "unknown").slice(0, 200)}`,
        );
        return internalFailure("内部模型调用失败（详见服务端日志）");
      }
      const text = contentText(response.content).trim();
      if (text === "") return internalFailure("内部模型返回为空");
      return {
        ok: true,
        result: text,
        sessionId: null,
        isError: false,
        permissionDenials: 0,
        exitCode: 0,
        timedOut: false,
        aborted: false,
        stderrTail: "",
        error: null,
      };
    } catch (error) {
      log(
        `[manager] 内部模型 ${call.label} 调用异常：${
          error instanceof Error ? error.message.slice(0, 200) : "unknown"
        }`,
      );
      return internalFailure(
        timedOut ? "内部模型超时" : "内部模型调用失败（详见服务端日志）",
        { ...(timedOut ? { timedOut: true } : {}) },
      );
    } finally {
      clearTimeout(timer);
      call.signal?.removeEventListener("abort", onAbort);
    }
  });
}

function internalFailure(error: string, patch: Partial<QoderResult> = {}): QoderResult {
  return {
    ok: false,
    result: "",
    sessionId: null,
    isError: false,
    permissionDenials: 0,
    exitCode: null,
    timedOut: false,
    aborted: false,
    stderrTail: "",
    error,
    ...patch,
  };
}

function buildModels(role: Role): {
  models: Models;
  model: { provider: string; modelId: string };
} {
  const mode = (
    process.env.CHANCELLOR_LLM_PROVIDER ??
    process.env.LLM_PROVIDER ??
    ""
  )
    .trim()
    .toLowerCase();

  if (mode === "faux") {
    return role === "manager" ? buildManagerFauxModels() : buildWorkerFauxModels();
  }

  const apiKey =
    process.env.CHANCELLOR_LLM_API_KEY?.trim() || process.env.LLM_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      `LLM_API_KEY 未配置：${role === "manager" ? "分管宰相" : "原生 worker"} 需要真实模型；没有 key 时用 LLM_PROVIDER=faux 跑流程`,
    );
  }

  const modelId =
    process.env.CHANCELLOR_LLM_MODEL?.trim() ||
    process.env.LLM_MODEL?.trim() ||
    "deepseek-v4.1-flash";
  const baseUrl = (
    process.env.CHANCELLOR_LLM_BASE_URL?.trim() ||
    process.env.LLM_BASE_URL?.trim() ||
    "https://dashscope.aliyuncs.com/compatible-mode/v1"
  ).replace(/\/+$/, "");

  const model: Model<"openai-completions"> = {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: role === "manager" ? MANAGER_CONTEXT_WINDOW : 131_072,
    maxTokens: 4096,
  };

  const models = createModels();
  models.setProvider(
    createProvider({
      id: PROVIDER_ID,
      name: "百炼（OpenAI 兼容）",
      baseUrl,
      auth: {
        apiKey: envApiKeyAuth("百炼 API key", [
          "CHANCELLOR_LLM_API_KEY",
          "LLM_API_KEY",
        ]),
      },
      models: [model],
      api: openAICompletionsApi(),
    }),
  );

  return { models, model: { provider: PROVIDER_ID, modelId } };
}

/**
 * worker 的 faux 上游：没有真模型时也能把完整工具循环跑通。
 *
 * 脚本由环境变量给：
 *   CHANCELLOR_FAUX_REPORT    REPORT.md 里的 JSON（不写就是 done + 空 artifacts）
 *   CHANCELLOR_FAUX_ARTIFACT  可选，JSON {"path":"hello.txt","content":"hello"}
 *   CHANCELLOR_FAUX_ESCALATE  可选，置 1 走上报脚本：先调 escalate、再写 waiting 的
 *     REPORT、等答复插话进来后写 ready 的 REPORT 收尾（批2 端到端探针用）。
 *
 * 它先调 write 写产物（如果有），再调 write 写 REPORT.md，最后收尾。
 */
function buildWorkerFauxModels(): {
  models: Models;
  model: { provider: string; modelId: string };
} {
  const faux = fauxProvider({ models: [{ id: "faux" }], tokensPerSecond: 120 });
  const models = createModels();
  models.setProvider(faux.provider);

  // 上报脚本（批2）：第 1 请求调 escalate，第 2 请求写 waiting 的 REPORT，
  // 第 3 请求收尾等答复；答复插话进来后第 4 请求写 ready 的 REPORT，第 5 收尾。
  if (process.env.CHANCELLOR_FAUX_ESCALATE?.trim() === "1") {
    const question = process.env.CHANCELLOR_FAUX_ESCALATE_QUESTION?.trim() || "目录结构选 A 还是 B？";
    const context = process.env.CHANCELLOR_FAUX_ESCALATE_CONTEXT?.trim() || "两种都可行，需要拍板后才能继续。";
    const waitingJson = JSON.stringify({
      status: "waiting",
      summary: "已上报问题，等答复",
      artifacts: [],
    });
    const readyJson =
      process.env.CHANCELLOR_FAUX_ESCALATE_READY?.trim() ||
      JSON.stringify({
        status: "ready",
        summary: "收到答复后按 A 完成了任务",
        artifacts: [],
      });
    const factory: FauxResponseFactory = (_context, _options, state) => {
      if (state.callCount === 1) {
        return fauxAssistantMessage(
          [fauxToolCall("escalate", { question, context, urgency: "normal" })],
          { stopReason: "toolUse" },
        );
      }
      if (state.callCount === 2) {
        return fauxAssistantMessage(
          [fauxToolCall("write", { path: "REPORT.md", content: asReportMarkdown(waitingJson) })],
          { stopReason: "toolUse" },
        );
      }
      if (state.callCount === 3) {
        return fauxAssistantMessage("（faux 模型）已上报，本轮收尾等答复。");
      }
      if (state.callCount === 4) {
        return fauxAssistantMessage(
          [fauxToolCall("write", { path: "REPORT.md", content: asReportMarkdown(readyJson) })],
          { stopReason: "toolUse" },
        );
      }
      return fauxAssistantMessage("（faux 模型）任务结束。");
    };
    faux.setResponses(Array.from({ length: 200 }, () => factory));
    const model = faux.getModel();
    return { models, model: { provider: model.provider, modelId: model.id } };
  }

  const artifact = readFauxArtifact();
  const reportJson =
    process.env.CHANCELLOR_FAUX_REPORT?.trim() ||
    JSON.stringify({
      status: "done",
      summary: "faux 模型完成了任务",
      artifacts: artifact ? [artifact.path] : [],
    });

  const responses: ReturnType<typeof fauxAssistantMessage>[] = [];
  if (artifact) {
    responses.push(
      fauxAssistantMessage(
        [fauxToolCall("write", { path: artifact.path, content: artifact.content })],
        { stopReason: "toolUse" },
      ),
    );
  }
  responses.push(
    fauxAssistantMessage(
      [fauxToolCall("write", { path: "REPORT.md", content: asReportMarkdown(reportJson) })],
      { stopReason: "toolUse" },
    ),
  );
  const final = fauxAssistantMessage("（faux 模型）任务结束。");
  faux.setResponses([...responses, ...Array.from({ length: 200 }, () => final)]);

  const model = faux.getModel();
  return { models, model: { provider: model.provider, modelId: model.id } };
}

/**
 * manager 的 faux 上游：验「会话续用」和 delegate 这两条链路。
 *
 *   CHANCELLOR_FAUX_MANAGER_REPLY      直接回这句话
 *   CHANCELLOR_FAUX_MANAGER_REMEMBER   只在**历史里**找这个词；找到才答得出来
 *   CHANCELLOR_FAUX_MANAGER_DELEGATE   第一轮先调 delegate，第二轮收尾
 *
 * REMEMBER 刻意去掉当前这条用户消息再找：词如果只出现在本次提问里，
 * 说明是当前输入带来的，不算记住；只有磁盘上的旧会话才能让它答出来。
 */
function buildManagerFauxModels(): {
  models: Models;
  model: { provider: string; modelId: string };
} {
  const faux = fauxProvider({ models: [{ id: "faux" }], tokensPerSecond: 120 });
  const models = createModels();
  models.setProvider(faux.provider);

  const reply = process.env.CHANCELLOR_FAUX_MANAGER_REPLY?.trim() || null;
  const remember = process.env.CHANCELLOR_FAUX_MANAGER_REMEMBER?.trim() || null;
  const delegateRequirement =
    process.env.CHANCELLOR_FAUX_MANAGER_DELEGATE?.trim() || null;

  const factory: FauxResponseFactory = (context, _options, state) => {
    if (state.callCount === 1) {
      if (delegateRequirement) {
        return fauxAssistantMessage(
          [fauxToolCall("delegate", { requirement: delegateRequirement })],
          { stopReason: "toolUse" },
        );
      }
      if (remember) {
        const history = context.messages.slice(0, -1);
        const seen = JSON.stringify(history).includes(remember);
        return fauxAssistantMessage(
          seen ? `done：你让我记的是 ${remember}` : "blocked：我不记得你让我记过什么",
        );
      }
      return fauxAssistantMessage(reply ?? "done：faux 分管宰相收到");
    }

    if (delegateRequirement) {
      const last = context.messages[context.messages.length - 1];
      if (last?.role === "toolResult") {
        const text = last.content
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("")
          .trim();
        if (last.isError) {
          return fauxAssistantMessage(`failed：delegate 失败：${text.slice(0, 80)}`);
        }
        return fauxAssistantMessage(
          text.startsWith("✓")
            ? "done：已派活并拿到结论"
            : `blocked：delegate 没成功：${text.slice(0, 80)}`,
        );
      }
      return fauxAssistantMessage("blocked：delegate 没有返回结果");
    }
    return fauxAssistantMessage(reply ?? "done：faux 分管宰相收到");
  };

  faux.setResponses(Array.from({ length: 200 }, () => factory));

  const model = faux.getModel();
  return { models, model: { provider: model.provider, modelId: model.id } };
}

function readFauxArtifact(): { path: string; content: string } | null {
  const raw = process.env.CHANCELLOR_FAUX_ARTIFACT?.trim();
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`CHANCELLOR_FAUX_ARTIFACT 不是合法 JSON：${messageOf(error)}`);
  }
  if (
    value === null ||
    typeof value !== "object" ||
    typeof (value as Record<string, unknown>).path !== "string" ||
    typeof (value as Record<string, unknown>).content !== "string"
  ) {
    throw new Error('CHANCELLOR_FAUX_ARTIFACT 必须是 {"path":"...","content":"..."}');
  }
  const artifact = value as { path: string; content: string };
  return artifact;
}

function asReportMarkdown(input: string): string {
  if (/```json/i.test(input)) return input;
  return `# REPORT\n\n\`\`\`json\n${input.trim()}\n\`\`\`\n`;
}

function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content.trim();
  return message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
}

function lastAssistantText(messages: readonly Message[]): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || message.role !== "assistant") continue;
    const text = messageText(message);
    if (text !== "") return text;
  }
  return null;
}

/** 粗略 token 估算：中日韩字符按 1 token，其余按 4 字符/token。只用于 60% 阈值，不必精确。 */
function estimateTokens(messages: readonly Message[]): number {
  let cjk = 0;
  let other = 0;
  for (const message of messages) {
    const content = message.content;
    const parts = typeof content === "string"
      ? [content]
      : content.map((block) => (block.type === "text" ? block.text : JSON.stringify(block)));
    for (const text of parts) {
      const matches = text.match(/[\u3000-\u9fff\uff00-\uffef]/g);
      const cjkCount = matches?.length ?? 0;
      cjk += cjkCount;
      other += text.length - cjkCount;
    }
  }
  return cjk + Math.ceil(other / 4);
}

/** 换段时的交接笔记：只写这一段的关键结论与用户交代过的事，细节仍在旧上下文与工作目录里。 */
function buildHandoff(
  domain: string,
  requirement: string,
  messages: readonly Message[],
): string {
  const recent = messages
    .filter((message) => message.role === "user")
    .map((message) => messageText(message))
    .filter((text) => text !== "")
    .slice(-6);
  const conclusion = lastAssistantText(messages);
  return [
    `# 领域交接笔记 · ${domain}`,
    "",
    `更新时间：${new Date().toISOString()}`,
    "",
    "## 本段最后一轮需求",
    truncate(requirement, 400),
    "",
    "## 本段结论",
    conclusion ? truncate(conclusion, 400) : "（无）",
    "",
    "## 本段用户交代过的事（最近 6 条）",
    ...(recent.length === 0
      ? ["（无）"]
      : recent.map((text) => `- ${truncate(text.replace(/\s+/g, " "), 160)}`)),
    "",
    "> 旧上下文仍保存在本领域的 .agent.sqlite 中（换段边界之前）；接手后先读 handoff.md 与工作目录，不要重做已经完成的事。",
  ].join("\n");
}

function truncate(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…`;
}

function lastLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.length === 0 ? "" : (lines[lines.length - 1] ?? "");
}

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
