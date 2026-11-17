#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { EMPLOYEE, MAX_TASKS_DEFAULT, MCP_TOKEN, MCP_URL } from "./config.ts";
import {
  EXTERNAL_CLI_ORDER,
  preflightExternalCli,
  selectExternalCli,
} from "./employee/external.ts";
import {
  capabilitiesOf,
  listMcpTools,
  openMcpSession,
  resolveMikaTools,
  selectMcpTool,
} from "./employee/index.ts";
import { recoverDelegations, runChancellor } from "./index.ts";
import { listManagers, managersRoot } from "./manager/registry.ts";
import { sanitizeLine } from "./report.ts";
import { listFiles, readJson, Store } from "./store.ts";
import type {
  ChancellorEvent,
  ChancellorRequest,
  ManagerRunRecord,
  PlannedTask,
  Review,
  Ticket,
} from "./types.ts";

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

interface RunArgs {
  requirement?: string;
  dry: boolean;
  verbose: boolean;
  maxTasks: number;
  domain?: string;
  idempotencyKey?: string;
  resumeTicketId?: string;
  answer?: string;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return command ? EXIT_OK : EXIT_USAGE;
  }
  switch (command) {
    case "run":
      return cmdRun(rest);
    case "status":
      return cmdStatus(rest);
    case "show":
      return cmdShow(rest);
    case "managers":
      return cmdManagers(rest);
    case "doctor":
      return cmdDoctor(rest);
    default:
      process.stderr.write(`未知子命令：${command}\n`);
      printUsage();
      return EXIT_USAGE;
  }
}

async function cmdRun(rest: string[]): Promise<number> {
  const parsed = parseRunArgs(rest);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    process.stderr.write(
      '用法：node src/main.ts run "<需求>" [--dry] [--verbose] [--max-tasks N] [--key <幂等key>]\n' +
        '      node src/main.ts run --resume <ticket> --answer "<回答>"\n',
    );
    return EXIT_USAGE;
  }
  const args = parsed.value;
  const workRoot = cliWorkRoot();
  const onEvent = args.verbose
    ? (event: ChancellorEvent): void => {
        process.stderr.write(`${formatEvent(event)}\n`);
      }
    : undefined;

  const request: ChancellorRequest = {
    maxTasks: args.maxTasks,
    dry: args.dry,
    workRoot,
    ...(args.requirement ? { requirement: args.requirement } : {}),
    ...(args.domain ? { domain: args.domain } : {}),
    ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}),
    ...(args.resumeTicketId ? { resumeTicketId: args.resumeTicketId } : {}),
    ...(args.answer ? { answer: args.answer } : {}),
  };

  // 进程启动先结算上一进程留下的进行中单；dry 不派活，不需要恢复。
  if (!args.dry) {
    const recovery = await recoverDelegations(workRoot, {
      log: (line) => process.stderr.write(`${line}\n`),
    });
    if (recovery.scanned > 0) {
      process.stderr.write(
        `[恢复] 扫描 ${recovery.scanned}：仍在跑 ${recovery.stillRunning}，已终态 ${recovery.finished}，自动续跑 ${recovery.resumed}，转待你处理 ${recovery.needsYou}，未知 ${recovery.unknown}\n`,
      );
    }
  }

  let result;
  try {
    result = await runChancellor(request, { onEvent });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`✗ 中枢故障：${sanitizeLine(message, 160)}。\n`);
    return EXIT_FAIL;
  }

  if (args.dry) {
    if (!result.plannedTasks) {
      process.stdout.write(`${result.line}\n`);
      return EXIT_FAIL;
    }
    const payload = { ticket: result.ticketId, plannedTasks: result.plannedTasks };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return EXIT_OK;
  }

  process.stdout.write(`${result.line}\n`);
  return result.status === "done" ? EXIT_OK : EXIT_FAIL;
}

async function cmdDoctor(rest: string[]): Promise<number> {
  if (rest.length > 0) {
    process.stderr.write("用法：node src/main.ts doctor\n");
    return EXIT_USAGE;
  }
  process.stdout.write(`雇员：${EMPLOYEE}\n`);
  const capabilities = capabilitiesOf(EMPLOYEE);
  process.stdout.write(
    `能力：artifacts=${capabilities.artifacts} canWriteFiles=${capabilities.canWriteFiles}\n`,
  );
  if (capabilities.note) process.stdout.write(`提示：${capabilities.note}\n`);

  // 外部执行档位的健康检查：顺序是定稿，不可用档位不参与选择。
  const externalStatuses = await Promise.all(
    EXTERNAL_CLI_ORDER.map(async (name) => ({
      name,
      status: await preflightExternalCli(name),
    })),
  );
  process.stdout.write(
    `外部执行：${externalStatuses
      .map(({ name, status }) => `${name}${status.ok ? " ✓ " : " ✗ "}${status.detail}`)
      .join("；")}\n`,
  );
  const chosen = await selectExternalCli();
  process.stdout.write(
    `选择顺序：${EXTERNAL_CLI_ORDER.join(" → ")}；当前首选：${chosen ?? "（无可用）"}\n`,
  );

  if (MCP_URL === "" || MCP_TOKEN === "") {
    if (EMPLOYEE === "mcp") {
      process.stderr.write(
        "✗ CHANCELLOR_EMPLOYEE=mcp 缺少 CHANCELLOR_MCP_URL/CHANCELLOR_MCP_TOKEN；不会静默退回原生雇员\n",
      );
      return EXIT_FAIL;
    }
    process.stdout.write(
      "MCP：未配置（不影响 native / mercenary / qoder-intl / qoder-cn / codebuddy / " +
        "claude-code / codex / opencode；后三档需各自登录，doctor 不主动探测）\n",
    );
    return EXIT_OK;
  }

  process.stdout.write(`MCP：${MCP_URL}\n`);
  let session;
  try {
    session = await openMcpSession();
    const tools = await listMcpTools(session);
    process.stdout.write(
      `工具（${tools.length}）：${tools.map((tool) => tool.name).join("、") || "（无）"}\n`,
    );
    const runTool = selectMcpTool(tools);
    process.stdout.write(`本次会选：${runTool}\n`);
    const lifecycle = resolveMikaTools(tools, runTool);
    process.stdout.write(
      `生命周期：run=${lifecycle.run} wait=${lifecycle.wait} answer=${lifecycle.answer} status=${
        lifecycle.status ?? "（无）"
      }\n`,
    );
    return EXIT_OK;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`✗ ${message}\n`);
    return EXIT_FAIL;
  } finally {
    await session?.close();
  }
}

function cmdStatus(rest: string[]): number {
  if (rest.length > 0) {
    process.stderr.write("用法：node src/main.ts status\n");
    return EXIT_USAGE;
  }
  const store = new Store(cliWorkRoot());
  store.ensureIndex();
  const rows = store.listTickets(20);
  if (rows.length === 0) {
    process.stdout.write("（暂无记录）\n");
    return EXIT_OK;
  }
  for (const row of rows) {
    process.stdout.write(
      `${formatWhen(row.created_at)}  ${normalizeStatus(row.status).padEnd(10)}  ${
        row.passed
      }/${row.total}  ${formatEmployee(row.employee).padEnd(9)}  ${row.id}  ${collapse(
        row.prompt,
        40,
      )}\n`,
    );
  }
  return EXIT_OK;
}

function cmdShow(rest: string[]): number {
  const ticketId = rest[0];
  if (!ticketId || !/^t-[A-Za-z0-9-]+$/.test(ticketId)) {
    process.stderr.write("用法：node src/main.ts show <ticket>\n");
    return EXIT_USAGE;
  }
  const store = new Store(cliWorkRoot());
  const dir = store.ticketDir(ticketId);
  const ticket = readJson<Ticket>(path.join(dir, "ticket.json"));
  if (!ticket) {
    process.stderr.write(`找不到这单：${ticketId}\n`);
    return EXIT_FAIL;
  }
  store.ensureIndex();
  const taskRows = store.tasksOf(ticketId);

  process.stdout.write(`# ${ticket.id}\n`);
  process.stdout.write(`状态：${normalizeStatus(ticket.status)}\n`);
  if (ticket.stage) process.stdout.write(`阶段：${ticket.stage}\n`);
  process.stdout.write(`雇员：${formatEmployee(ticket.employee)}\n`);
  process.stdout.write(`原话：${ticket.prompt}\n`);
  process.stdout.write(`创建：${formatWhen(ticket.created_at)}\n`);
  process.stdout.write(`目录：${dir}\n`);
  if (ticket.error) process.stdout.write(`原因：${ticket.error}\n`);
  process.stdout.write("\n");

  const plan = readJson<{
    ok?: boolean;
    tasks?: PlannedTask[];
    error?: string | null;
    employee?: string;
    domain?: string;
    manager?: ManagerRunRecord;
  }>(path.join(dir, "plan.json"));
  if (!plan) {
    process.stdout.write("（没有 plan.json）\n");
    return EXIT_OK;
  }
  if (plan.ok === false) {
    process.stdout.write(`拆单失败：${plan.error ?? "未知"}\n`);
    return EXIT_OK;
  }

  if (plan.domain) {
    process.stdout.write(`## 分管领域\n${plan.domain}\n`);
    process.stdout.write(
      `领域目录：${path.join(managersRoot(cliWorkRoot()), plan.domain)}\n\n`,
    );
  }
  if (plan.manager) {
    const manager = plan.manager;
    process.stdout.write("## 分管宰相\n");
    process.stdout.write(`结论：${manager.line ?? "（无）"}\n`);
    const exitCode = manager.exit_code === null ? "null" : String(manager.exit_code);
    const marks = [
      manager.timed_out ? "超时" : "",
      manager.aborted ? "已停止" : "",
    ]
      .filter((item) => item !== "")
      .join("、");
    process.stdout.write(`进程：退出码=${exitCode}${marks ? `，${marks}` : ""}\n`);
    const conversationId =
      manager.conversation_id === null ? "（无）" : String(manager.conversation_id);
    const reuse =
      manager.reused === null
        ? ""
        : manager.reused
          ? `，续用${manager.history === null ? "" : `，历史 ${manager.history} 条`}`
          : "，新建";
    process.stdout.write(`会话：${conversationId}${reuse}\n`);
    if (manager.error) process.stdout.write(`错误：${manager.error}\n`);
    return EXIT_OK;
  }

  const reviewFile = readJson<{ reviews?: Review[]; aborted?: boolean }>(
    path.join(dir, "review.json"),
  );
  const tasks = plan.tasks ?? [];
  process.stdout.write(`## 任务（${tasks.length}）\n`);
  tasks.forEach((task, index) => {
    const seq = index + 1;
    const dirName = `${String(seq).padStart(2, "0")}-${task.slug}`;
    const review = reviewFile?.reviews?.find((item) => item.seq === seq);
    const row = taskRows.find((item) => item.seq === seq);
    const employee = row?.employee ?? ticket.employee ?? null;
    process.stdout.write(
      `${dirName}  ${formatEmployee(employee).padEnd(9)}  ${
        review ? review.verdict : "未验收"
      }  ${task.title}\n`,
    );
    if (Array.isArray(task.dependsOn) && task.dependsOn.length > 0) {
      process.stdout.write(`  依赖：${task.dependsOn.join("、")}\n`);
    }
    if (review) process.stdout.write(`  理由：${review.reason}\n`);
    const files = listFiles(path.join(dir, dirName));
    process.stdout.write(`  文件：${files.map((file) => file.path).join("、") || "（空）"}\n`);
  });
  const goal = readJson<{
    satisfied?: boolean;
    inconclusive?: boolean;
    reason?: string;
    aborted?: boolean;
  }>(path.join(dir, "goal.json"));
  if (goal) {
    const verdict = goal.aborted
      ? "已停止"
      : goal.inconclusive
        ? "inconclusive（核对器输出异常，没给出结论）"
        : goal.satisfied
          ? "satisfied"
          : "not satisfied";
    process.stdout.write(`\n## 整体目标核对\n${verdict}\n理由：${goal.reason ?? "（无）"}\n`);
  }
  if (reviewFile?.aborted) {
    process.stdout.write("\n（这单被中止过）\n");
  }
  return EXIT_OK;
}

function cmdManagers(rest: string[]): number {
  if (rest.length > 0) {
    process.stderr.write("用法：node src/main.ts managers\n");
    return EXIT_USAGE;
  }
  const workRoot = cliWorkRoot();
  const entries = listManagers(workRoot);
  if (entries.length === 0) {
    process.stdout.write(`（暂无分管领域；目录：${managersRoot(workRoot)}）\n`);
    return EXIT_OK;
  }
  for (const entry of entries) {
    const meta = entry.meta;
    const last = meta?.updated_at ? formatWhen(meta.updated_at) : "（无 meta）";
    const conversation =
      meta?.conversation_id === null || meta?.conversation_id === undefined
        ? "-"
        : String(meta.conversation_id);
    const db = entry.db_exists ? formatBytes(entry.db_bytes) : "缺失";
    const idle = idleDays(meta?.updated_at);
    const flags = [
      entry.error,
      idle !== null && idle > 30 ? `⚠ ${idle} 天未用` : null,
    ]
      .filter((item): item is string => Boolean(item))
      .join("；");
    process.stdout.write(
      `${entry.domain.padEnd(14)} 最后使用 ${last}  会话 ${conversation}  db ${db}${
        flags ? `  ${flags}` : ""
      }\n`,
    );
  }
  return EXIT_OK;
}

function idleDays(iso: string | undefined): number | null {
  if (!iso) return null;
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return null;
  return Math.floor((Date.now() - time) / 86_400_000);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function parseRunArgs(
  args: string[],
): { ok: true; value: RunArgs } | { ok: false; error: string } {
  let dry = false;
  let verbose = false;
  let maxTasks = MAX_TASKS_DEFAULT;
  let domain: string | undefined;
  let idempotencyKey: string | undefined;
  let resumeTicketId: string | undefined;
  let answer: string | undefined;
  const words: string[] = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--dry") {
      dry = true;
    } else if (arg === "--verbose" || arg === "-v") {
      verbose = true;
    } else if (arg === "--max-tasks") {
      const next = args[index + 1];
      if (next === undefined) return { ok: false, error: "--max-tasks 需要一个数字" };
      const parsed = parseMaxTasks(next);
      if (parsed === null) return { ok: false, error: "--max-tasks 必须是 1-5 的整数" };
      maxTasks = parsed;
      index += 1;
    } else if (arg.startsWith("--max-tasks=")) {
      const parsed = parseMaxTasks(arg.slice("--max-tasks=".length));
      if (parsed === null) return { ok: false, error: "--max-tasks 必须是 1-5 的整数" };
      maxTasks = parsed;
    } else if (arg === "--domain") {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) {
        return { ok: false, error: "--domain 需要一个领域名" };
      }
      domain = next.trim();
      index += 1;
    } else if (arg.startsWith("--domain=")) {
      domain = arg.slice("--domain=".length).trim();
    } else if (arg === "--key" || arg === "--idempotency-key") {
      const next = args[index + 1];
      if (next === undefined || next.trim() === "" || next.startsWith("--")) {
        return { ok: false, error: `${arg} 需要一个非空 key` };
      }
      idempotencyKey = next.trim();
      index += 1;
    } else if (arg.startsWith("--key=")) {
      const value = arg.slice("--key=".length).trim();
      if (value === "") return { ok: false, error: "--key 需要一个非空 key" };
      idempotencyKey = value;
    } else if (arg.startsWith("--idempotency-key=")) {
      const value = arg.slice("--idempotency-key=".length).trim();
      if (value === "") return { ok: false, error: "--idempotency-key 需要一个非空 key" };
      idempotencyKey = value;
    } else if (arg === "--resume") {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) {
        return { ok: false, error: "--resume 需要一个 ticket id" };
      }
      resumeTicketId = next.trim();
      index += 1;
    } else if (arg.startsWith("--resume=")) {
      const value = arg.slice("--resume=".length).trim();
      if (value === "") return { ok: false, error: "--resume 需要一个 ticket id" };
      resumeTicketId = value;
    } else if (arg === "--answer") {
      const next = args[index + 1];
      if (next === undefined || next.trim() === "") {
        return { ok: false, error: "--answer 需要一个非空回答" };
      }
      answer = next;
      index += 1;
    } else if (arg.startsWith("--answer=")) {
      const value = arg.slice("--answer=".length).trim();
      if (value === "") return { ok: false, error: "--answer 需要一个非空回答" };
      answer = value;
    } else if (arg.startsWith("--")) {
      return { ok: false, error: `未知参数：${arg}` };
    } else {
      words.push(arg);
    }
  }

  const requirement = words.join(" ").trim();
  if (domain === "") return { ok: false, error: "--domain 不能为空" };
  if (resumeTicketId) {
    if (requirement !== "") {
      return { ok: false, error: "resume 不接需求原话；续跑只认 --resume + --answer" };
    }
    if (dry) return { ok: false, error: "resume 不支持 --dry" };
    if (!answer) return { ok: false, error: "resume 需要 --answer <回答>" };
    return {
      ok: true,
      value: {
        dry,
        verbose,
        maxTasks,
        resumeTicketId,
        answer,
        ...(domain ? { domain } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      },
    };
  }
  if (answer !== undefined) return { ok: false, error: "--answer 只能和 --resume 一起用" };
  if (!requirement) return { ok: false, error: "缺少需求原话" };
  return {
    ok: true,
    value: {
      requirement,
      dry,
      verbose,
      maxTasks,
      ...(domain ? { domain } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    },
  };
}

function parseMaxTasks(raw: string): number | null {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 5) return null;
  return value;
}

function cliWorkRoot(): string {
  const override = process.env.CHANCELLOR_RUNS_DIR?.trim();
  return path.resolve(override && override !== "" ? override : path.join(process.cwd(), "runs"));
}

function formatEvent(event: ChancellorEvent): string {
  const seq = event.seq === undefined ? "" : ` ${String(event.seq).padStart(2, "0")}`;
  const slug = event.slug ? `-${event.slug}` : "";
  const message = event.message ? ` ${event.message}` : "";
  return `[${event.type}]${seq}${slug}${message}`;
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("sv-SE");
}

/** v1.0 之前只有 blocked，没有 needs_you；老数据按新口径显示。 */
function normalizeStatus(raw: string): string {
  return raw === "blocked" ? "needs_you" : raw;
}

/** 老数据没有 employee；同一单混用多种雇员时显示 native+mercenary。 */
function formatEmployee(raw: string | null | undefined): string {
  if (!raw) return "-";
  const names = raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  return names.length === 0 ? "-" : Array.from(new Set(names)).sort().join("+");
}

function collapse(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

function printUsage(): void {
  process.stdout.write(`chancellor · 一句话需求 → 一群 worker → 一行汇报

用法：
  node src/main.ts run "<需求>" [--dry] [--verbose] [--max-tasks N] [--domain <领域>] [--key <幂等key>]
  node src/main.ts run --resume <ticket> --answer "<回答>"
  node src/main.ts status
  node src/main.ts show <ticket>
  node src/main.ts managers
  node src/main.ts doctor

  带 --domain 时交给该领域的分管宰相（managers/<领域>/，会话续用）；
  不带时跟 v0.3 一样，总管直接拆单派 worker。
  带 --key（或 --idempotency-key）时，同一个 key 只产生一张单，重复派活直接返回旧单。
  --resume 接着一张 needs_you 的旧单往下跑，不重新拆单、不新建 ticket。
  doctor 报当前雇员的能力、MCP 连通性、工具清单和本次会选哪个工具。

环境变量：
  CHANCELLOR_QODER_BIN       qodercli（国际版）可执行文件路径
  CHANCELLOR_QODER_CN_BIN    qoderclicn（国内版）可执行文件路径
  CHANCELLOR_MODEL           传给 qodercli 的模型（默认 DeepSeek-Flash）
  CHANCELLOR_QODER_CN_MODEL  Qoder CN 的模型（默认同上）
  CHANCELLOR_CODEBUDDY_BIN   CodeBuddy 可执行文件路径（默认取自 PATH）
  CHANCELLOR_CODEBUDDY_MODEL 传给 CodeBuddy 的模型（默认 deepseek-v4.1-flash）
  CHANCELLOR_RUNS_DIR        runs 目录（默认 ./runs）
  CHANCELLOR_EMPLOYEE        native / mercenary / qoder-intl / qoder-cn / codebuddy / mcp
  CHANCELLOR_MCP_URL         MCP 服务器地址（如 http://127.0.0.1:8765/mcp）
  CHANCELLOR_MCP_TOKEN       MCP Bearer 令牌
  CHANCELLOR_MCP_TOOL        指定任务提交工具（Mika 为 mika_run_task）；不给时只有单工具才自动挑
  CHANCELLOR_MCP_TASK_BUDGET_MS  一个 Mika 任务最多等多久（默认 10 分钟）
  CHANCELLOR_PLAN_TIMEOUT_MS / CHANCELLOR_WORKER_TIMEOUT_MS / CHANCELLOR_REVIEW_TIMEOUT_MS
  MANAGER_CONTEXT_WINDOW         负责人上下文窗口（默认 131072）
  MANAGER_CONTEXT_ROTATE_RATIO   到窗口这个比例自动换段/压缩（默认 0.60）
  DELEGATION_RESUME_POLICY       崩溃恢复：auto-before-merge（默认）/ always-ask / never
`);
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`[chancellor] 未捕获错误：${message}\n`);
    process.exitCode = EXIT_FAIL;
  });
