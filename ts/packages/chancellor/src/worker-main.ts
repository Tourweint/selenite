import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
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
import type { ProjectRef } from "./types.ts";

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

/** v0.3 的工人流程：一次性会话，干完就退。 */
async function runWorkerMain(
  taskDir: string,
  workDir: string,
  dbPath: string,
  toolsArg?: string,
): Promise<void> {
  const taskText = fs.readFileSync(path.join(taskDir, "TASK.md"), "utf8");
  const systemPrompt = `${WORKER_RULES}\n\n---\n\n${taskText}`;
  const registry = buildWorkerRegistry(systemPrompt, [taskDir, workDir]);
  const registeredTools = registry.snapshot().tools();
  const toolNames = registeredTools.map((entry) => entry.tool.name);
  // 显式列出工具：就算别处误装了 delegate，它也进不了这个会话。
  // --tools（2026-11-17 批4）：宿主勾选的面，交集钉死在 canonical 四件；
  // 不传 = 全开；传了（哪怕空串 / 全乱值）= 按交集跑，筛空就是真零工具
  // （worker 只凭 TASK.md 回话，REPORT 缺失由验收如实报，不静默回退全开）。
  const requestedTools =
    toolsArg === undefined
      ? WORKER_ALLOWED_TOOLS
      : toolsArg
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean);
  const effectiveTools = effectiveWorkerTools(requestedTools);
  const allowedSet = new Set<string>(effectiveTools);
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

    const submission = await conversation.submit(
      { type: "input", content: "开始" },
      CTX,
    );
    const record = await submission.wait(CTX);
    if (record.status !== "done") {
      log(`[worker] 本轮没有正常收尾：${record.status}`);
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

function buildWorkerRegistry(prompt: string, dirs: string[]) {
  const registry = createRegistry();
  // 底座自带的读写改跑。只有这四个，没有 delegate。
  registry.install(CodingTools);
  registry.install(
    defineExtension({
      name: "chancellor-worker",
      sections: [{ key: "task", render: () => prompt }],
      hooks: [
        hook(ToolTask, {
          beforeTool: (call: ToolHookCall) => {
            if (!WORKER_ALLOWED.has(call.name)) {
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
