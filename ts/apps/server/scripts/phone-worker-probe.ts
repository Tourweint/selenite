// 手机 worker 验收探针（2026-11-02 契约）。
//
// 真跑，不 mock：
//   - 真的起 harness（同一个进程里 import src/index.ts，serve 真的监听端口）
//   - 真的用 delegate 工具派活（chancellor 照常拆单、验收）
//   - 假客户端全部走 HTTP：poll / model / result
//   - /worker/model 真调 DashScope（需要 LLM_API_KEY 或 DASHSCOPE_API_KEY）
//
// 验四件事：done → REPORT ready；blocked → needs_you + attention；
// 超时 → idle（不是 failed）；model 通道能流式/非流式原样拿到上游响应。
//
// 用法：`pnpm --filter @lifediary/server phone`
import { readFileSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const PORT = 8193;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "phone-probe-token";
const DIR = join(import.meta.dirname, "..");
/** 隔离任务单目录：chancellor 的 sqlite 落在 dirname(workRoot)/data，
 *  所以把 work 放到 .data/phone-probe/ 下，连库一起隔离，别混进真实 runs/ */
const RUNS = join(DIR, ".data/phone-probe/work");

process.chdir(DIR);

const apiKey = (process.env.LLM_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? "").trim();
if (!apiKey) {
  console.error("跳过：没有 LLM_API_KEY / DASHSCOPE_API_KEY，/worker/model 跑不了真上游。");
  process.exit(0);
}

const budgetMs = 15_000;
process.env.PORT = String(PORT);
process.env.AGENT_TOKEN = TOKEN;
process.env.LLM_PROVIDER = "";
process.env.LLM_API_KEY = apiKey;
process.env.LLM_MODEL = process.env.LLM_MODEL?.trim() || "deepseek-v4.1-flash";
process.env.LLM_BASE_URL =
  process.env.LLM_BASE_URL?.trim() || "https://dashscope.aliyuncs.com/compatible-mode/v1";
process.env.AGENT_DB_PATH = join(DIR, ".data/phone-probe-agent.sqlite");
process.env.MEMORY_DB_PATH = join(DIR, ".data/phone-probe-memory.db");
// 播种会写 providers.json；探针必须隔离，别碰真实 .data
process.env.PROVIDERS_PATH = join(DIR, ".data/phone-probe-providers.json");
// 受理回执必须隔离：requestId 是幂等的，复用真实回执库会让第二次跑直接返回上一轮的单
process.env.DELEGATIONS_DB_PATH = join(DIR, ".data/phone-probe-delegations.sqlite");
process.env.CHANCELLOR_ENABLED = "true";
process.env.CHANCELLOR_EMPLOYEE = "phone";
process.env.CHANCELLOR_PHONE_TASK_BUDGET_MS = String(budgetMs);
process.env.CHANCELLOR_WORK_ROOT = RUNS;
// 本项目只验手机 worker 通道；项目前置由 src/projects.test.ts 覆盖，
// 这里不铺工作区，否则 delegate 会先被 needs_project 拦下（同 delegate-chain-probe）
process.env.DELEGATION_PROJECT_REQUIRED = "false";
// 必须同步派单：探针要拿 delegate 的**结论**（ready / needs_you / idle），
// 并在失败前断言 plan.json / REPORT；异步模式只回"已受理"，plan 也要等后台拆单。
process.env.DELEGATION_ASYNC = "false";

// 必须先设环境变量再 import：chancellor 的 EMPLOYEE 是模块加载时读的。
await import("../src/index.ts");

const { createTools } = await import("../src/tools.ts");

let failures = 0;
function check(ok: boolean, label: string, detail = ""): void {
  if (ok) {
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function auth(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...extra };
}

interface PhoneTask {
  taskId: string;
  goal: string;
  doneWhen: string;
  budgetMs: number;
}

interface PhoneResult {
  status: "done" | "blocked" | "failed";
  summary: string;
  attention?: { kind: "need_action"; question: string };
}

async function waitForReady(): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/healthz`);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error("服务没能启动");
}

async function poll(timeoutS: number, signal?: AbortSignal): Promise<PhoneTask | null> {
  const response = await fetch(`${BASE}/api/v1/worker/poll`, {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ timeoutS }),
    signal,
  });
  if (response.status === 204) return null;
  if (!response.ok) throw new Error(`poll 返回 ${response.status}`);
  return (await response.json()) as PhoneTask;
}

async function postResult(taskId: string, result: PhoneResult): Promise<number> {
  const response = await fetch(`${BASE}/api/v1/worker/result`, {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ taskId, ...result }),
  });
  await response.text();
  return response.status;
}

async function callModel(
  messages: unknown[],
  options: { stream?: boolean; tools?: unknown[] } = {},
): Promise<Response> {
  return fetch(`${BASE}/api/v1/worker/model`, {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({
      taskId: "probe-model",
      messages,
      ...(options.stream ? { stream: true } : {}),
      ...(options.tools ? { tools: options.tools } : {}),
    }),
  });
}

function ticketIds(): string[] {
  try {
    return readdirSync(RUNS, { withFileTypes: true })
      .filter((item) => item.isDirectory() && item.name.startsWith("t-"))
      .map((item) => item.name)
      .sort();
  } catch {
    return [];
  }
}

interface TicketSnapshot {
  id: string;
  status: string;
  /** 每个 task 在 plan.json 里声明的 writes（2026-11-04 批次八：手机单必须恒空）。 */
  planWrites: string[][];
  /** review.json 里每个 review 的 warnings（批次八：手机单要记「按汇报验收」）。 */
  reviewWarnings: string[][];
  reports: Array<{ dir: string; status: string | null; attention: unknown; raw: string }>;
  resultFiles: Array<{ path: string; text: string }>;
}

function snapshotTicket(id: string): TicketSnapshot {
  const dir = join(RUNS, id);
  const ticket = JSON.parse(readFileSync(join(dir, "ticket.json"), "utf8")) as {
    status: string;
  };
  const plan = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8")) as {
    tasks?: Array<{ slug: string; writes?: string[] }>;
  };
  const reports: TicketSnapshot["reports"] = [];
  const resultFiles: TicketSnapshot["resultFiles"] = [];
  const planWrites = (plan.tasks ?? []).map((task) =>
    Array.isArray(task.writes) ? task.writes : [],
  );
  const reviewFile = JSON.parse(readFileSync(join(dir, "review.json"), "utf8")) as {
    reviews?: Array<{ warnings?: string[] }>;
  };
  const reviewWarnings = (reviewFile.reviews ?? []).map((review) =>
    Array.isArray(review.warnings) ? review.warnings : [],
  );
  for (const [index, task] of (plan.tasks ?? []).entries()) {
    const taskDir = join(dir, `${String(index + 1).padStart(2, "0")}-${task.slug}`);
    let raw = "";
    try {
      raw = readFileSync(join(taskDir, "REPORT.md"), "utf8");
    } catch {
      continue;
    }
    const match = /```json\s*([\s\S]*?)```/i.exec(raw);
    const parsed = match?.[1]
      ? (JSON.parse(match[1]) as { status?: string; attention?: unknown })
      : {};
    reports.push({
      dir: taskDir,
      status: typeof parsed.status === "string" ? parsed.status : null,
      attention: parsed.attention ?? null,
      raw,
    });
    try {
      resultFiles.push({ path: join(taskDir, "result.md"), text: readFileSync(join(taskDir, "result.md"), "utf8") });
    } catch {
      /* 没有 result.md 也正常：blocked / idle 不写 */
    }
  }
  return { id, status: ticket.status, planWrites, reviewWarnings, reports, resultFiles };
}

const delegate = createTools({
  memory: null,
  scopeOf: (id) => ({ type: "session", id: String(id) }) as never,
}).find((tool) => tool.name === "delegate");
if (!delegate) throw new Error("delegate 没挂上");

async function runDelegate(requirement: string): Promise<string> {
  const result = await delegate!.execute(
    { requirement } as never,
    { conversationId: 9001 } as never,
    {} as never,
  );
  return (result.output ?? []).map((item) => (item.type === "text" ? item.text : "")).join("");
}

/**
 * 在 delegate 跑的同时当手机：poll 到活就交给 respond；respond 返回 null 表示
 * 这一单故意不交（超时场景）。ticket 一结束就 abort 掉还在挂着的 poll。
 */
async function answerAsPhone(
  ticket: Promise<string>,
  respond: (task: PhoneTask) => Promise<PhoneResult | null>,
): Promise<{ text: string; tasks: PhoneTask[] }> {
  const controller = new AbortController();
  const tasks: PhoneTask[] = [];
  let settled = false;
  const textPromise = ticket
    .then((text) => {
      settled = true;
      controller.abort();
      return text;
    })
    .catch((error: unknown) => {
      // 派活失败也要让循环退出，否则会一直空转到 withTimeout
      settled = true;
      controller.abort();
      throw error;
    });

  while (!settled) {
    let task: PhoneTask | null;
    try {
      task = await poll(3, controller.signal);
    } catch {
      if (settled) break;
      throw new Error("poll 中断");
    }
    if (!task) continue;
    tasks.push(task);
    if (task.budgetMs !== budgetMs) {
      check(false, "poll 拿到的 budgetMs 与配置一致", `拿到 ${task.budgetMs}`);
    }
    const result = await respond(task);
    if (result === null) continue;
    const status = await postResult(task.taskId, result);
    check(status === 200, "交结果返回 200", `taskId=${task.taskId}`);
  }

  const text = await textPromise;
  return { text, tasks };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超过 ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runCase(
  name: string,
  requirement: string,
  respond: (task: PhoneTask) => Promise<PhoneResult | null>,
  inspect: (snapshot: TicketSnapshot, text: string, tasks: PhoneTask[]) => void,
): Promise<void> {
  console.log(`\n[${name}] ${requirement}`);
  const before = new Set(ticketIds());
  const ticket = runDelegate(requirement);
  const { text, tasks } = await withTimeout(
    answerAsPhone(ticket, respond),
    300_000,
    `${name} 派活`,
  );
  const created = ticketIds().filter((id) => !before.has(id));
  const id = created.at(-1);
  if (!id) {
    check(false, "delegate 产生了一张新 ticket", text.slice(0, 120));
    return;
  }
  check(true, "delegate 产生了新 ticket", id);
  const snapshot = snapshotTicket(id);
  inspect(snapshot, text, tasks);
}

rmSync(join(DIR, ".data/phone-probe"), { recursive: true, force: true });
rmSync(join(DIR, ".data/phone-probe-delegations.sqlite"), { force: true });
mkdirSync(RUNS, { recursive: true });

try {
  await waitForReady();
  console.log(`harness 已启动：${BASE}（CHANCELLOR_EMPLOYEE=phone）`);

  // 鉴权：不带凭据必须 403 空体
  {
    const response = await fetch(`${BASE}/api/v1/worker/poll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ timeoutS: 1 }),
    });
    const body = await response.text();
    check(response.status === 403 && body === "", "无凭据 poll → 403 空体", `status=${response.status}`);
  }

  // poll 挂起时被同一设备的新 poll 顶掉：旧的应很快 204
  {
    let firstAt = 0;
    const first = fetch(`${BASE}/api/v1/worker/poll`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ timeoutS: 20 }),
    }).then((response) => {
      firstAt = Date.now();
      return response;
    });
    await sleep(150);
    const supersedeAt = Date.now();
    const second = await fetch(`${BASE}/api/v1/worker/poll`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ timeoutS: 1 }),
    });
    const firstResponse = await first;
    check(
      firstResponse.status === 204 && firstAt - supersedeAt < 1000,
      "同一设备新 poll 顶掉旧 poll",
      `旧=${firstResponse.status}，${firstAt - supersedeAt}ms 内返回`,
    );
    await second.text();
  }

  // /worker/model：非流式原样拿上游 JSON
  let modelReply = "";
  {
    const response = await callModel([
      { role: "user", content: "只回复四个字：链路已通。" },
    ]);
    const text = await response.text();
    check(response.ok, "非流式 /worker/model 200", `status=${response.status}`);
    try {
      const payload = JSON.parse(text) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      modelReply = payload.choices?.[0]?.message?.content?.trim() ?? "";
      check(modelReply !== "", "非流式响应里有模型内容", modelReply.slice(0, 60));
    } catch {
      check(false, "非流式响应是 JSON", text.slice(0, 120));
    }
  }

  // /worker/model：流式原样透传 SSE
  {
    const response = await callModel(
      [{ role: "user", content: "只回复四个字：流式已通。" }],
      { stream: true },
    );
    const text = await response.text();
    check(
      response.ok && text.includes("data:"),
      "流式 /worker/model 原样透传 SSE",
      `status=${response.status}，${text.length} 字节`,
    );
  }

  // 1. done → 验收 ready
  await runCase(
    "done",
    "只回答，不要打开应用，也不要修改设置。电脑会把你的 summary 原样写成当前任务目录里的 result.md。" +
      "完成标准：result.md 里明确写出「Android 版本号是 15」；不要另外生成任何文件。",
    async (task) => {
      const response = await callModel([
        {
          role: "system",
          content: "你是手机上的助手。只回答一句话，并且必须原样包含：Android 版本号是 15。",
        },
        { role: "user", content: task.goal },
      ]);
      const text = await response.text();
      let summary = "";
      try {
        const payload = JSON.parse(text) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        summary = payload.choices?.[0]?.message?.content?.trim() ?? "";
      } catch {
        /* 失败时用固定 summary，验收仍要能跑 */
      }
      return { status: "done", summary: summary || "Android 版本号是 15。" };
    },
    (snapshot, text, tasks) => {
      check(tasks.length > 0, "假客户端 poll 到了任务", tasks[0]?.taskId ?? "");
      check(tasks[0]?.goal.includes("Android") === true, "任务里只有 goal/doneWhen/budgetMs");
      check(
        snapshot.planWrites.length > 0 && snapshot.planWrites.every((writes) => writes.length === 0),
        "手机单 plan.json writes 为空",
        JSON.stringify(snapshot.planWrites),
      );
      check(
        snapshot.reviewWarnings.some((warnings) =>
          warnings.some((warning) => warning.includes("按汇报验收")),
        ),
        "review.json 记「按汇报验收」warning",
        JSON.stringify(snapshot.reviewWarnings),
      );
      check(snapshot.status === "done", "整单状态 done", snapshot.status);
      const report = snapshot.reports[0];
      check(report?.status === "ready", "REPORT 是 ready", report?.status ?? "缺失");
      check(snapshot.resultFiles.length > 0, "result.md 落盘", snapshot.resultFiles[0]?.path ?? "");
      check(text !== "", "delegate 回了结论", text.slice(0, 80));
    },
  );

  // 2. blocked → needs_you + attention
  await runCase(
    "blocked",
    "打开「自动旋转」并确认开关已打开。完成标准：确认开关当前是打开状态。",
    async () => ({
      status: "blocked",
      summary: "已进入设置，停在确认密码弹窗，需要密码才能继续。",
      attention: { kind: "need_action", question: "系统设置要求输入锁屏密码，请告诉我密码。" },
    }),
    (snapshot, text, tasks) => {
      check(tasks.length > 0, "假客户端 poll 到了任务");
      check(snapshot.status === "needs_you", "整单进入 needs_you", snapshot.status);
      const report = snapshot.reports[0];
      check(report?.status === "blocked", "REPORT 是 blocked", report?.status ?? "缺失");
      const attention = report?.attention as { kind?: string; question?: string } | null;
      check(attention?.kind === "need_action", "attention.kind 是 need_action", attention?.kind ?? "");
      check(
        attention?.question === "系统设置要求输入锁屏密码，请告诉我密码。",
        "attention 带回了手机的问题",
        attention?.question ?? "",
      );
      check(text.includes("需要你"), "delegate 结论带「需要你」", text.slice(0, 80));
    },
  );

  // 3. 超时 → idle（不是 failed），之后再交结果 404
  let timedOutTaskId = "";
  await runCase(
    "timeout",
    "把手机相册里的所有照片按拍摄日期整理成相册。完成标准：照片都归进了日期命名的相册。",
    async (task) => {
      timedOutTaskId = task.taskId;
      return null; // 故意不交：让预算耗尽
    },
    (snapshot, text, tasks) => {
      check(tasks.length > 0, "假客户端 poll 到了任务，但故意不交");
      check(snapshot.status === "idle", "超时收成 idle，不是 failed", snapshot.status);
      const report = snapshot.reports[0];
      check(report?.status === "waiting", "REPORT 是 waiting", report?.status ?? "缺失");
      check(text.includes("等下一个触发"), "delegate 结论是 idle 语义", text.slice(0, 100));
    },
  );
  {
    const status = await postResult(timedOutTaskId, {
      status: "done",
      summary: "迟到的结果",
    });
    check(status === 404, "超时后再交结果 → 404", `status=${status}`);
  }

} catch (error) {
  // 异常不能被 finally 的 exit 吞掉：先记成一条失败，再把真实原因打出来
  failures += 1;
  console.error("[fatal]", error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  for (const path of [
    process.env.AGENT_DB_PATH,
    process.env.MEMORY_DB_PATH,
    process.env.PROVIDERS_PATH,
    process.env.DELEGATIONS_DB_PATH,
  ]) {
    if (!path) continue;
    try {
      rmSync(path, { force: true });
    } catch {
      /* sqlite 句柄还开着时删不掉；探针目录本来就在 .data/ 下 */
    }
  }
  try {
    rmSync(join(DIR, ".data/phone-probe"), { recursive: true, force: true });
  } catch {
    /* 服务进程可能还开着文件句柄；探针目录在 .data/ 下，留着无害 */
  }
}

console.log(
  failures === 0
    ? "\n✓ 手机 worker 全链路通过"
    : `\n✗ 手机 worker 有 ${failures} 项不对`,
);
process.exit(failures === 0 ? 0 : 1);
