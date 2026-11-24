/**
 * Worker（普通任务助手）人设：全局一份、可编辑（2026-11-16）。
 *
 * 落点 `.data/worker-persona.md`（纯文本，原子写，≤8KB；路径可用 WORKER_PERSONA_PATH 覆盖）。
 * 文件不存在 / 空 / 读失败 → 回落代码默认 `workerPersonaDefault()`；
 * 空串写入 = 删文件（回默认）。`WORKER_PERSONA_EDIT=false/0/off` = 关编辑（PUT 400）。
 *
 * 注入侧每轮现读 `readWorkerPersona()`，所以改完下一轮生效；不按会话存、不按人分。
 * 默认正文固定字节（改它 = 打掉一次上游缓存），顺序不要动，也不要改写成多段。
 *
 * 2026-11-16 通用 worker 配置统一 批2：人设拆成两层——
 * - **人设正文**（`workerPersonaDefault()`，文件里存的就是它）：身份与作风，
 *   worker 会话与派活的本机池 / 外部 CLI **同吃**（派活侧经 chancellor 注入口
 *   进 TASK.md「你是谁」段，`WORKER_PERSONA_DISPATCH=false` 回滚）；
 * - **会话工具提示**（`WORKER_PERSONA_CHAT_TOOLS`）：remember / recall / set_reminder
 *   只有 worker 会话有这些工具，派活工人没有，所以不进文件、只在会话注入时拼接。
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Hono } from "hono";
import { flagEnabled } from "./flags.ts";
import { setWorkerPersonaSource } from "../../../packages/chancellor/src/worker-persona-source.ts";

/** 默认正文（共享层）：只有身份与作风，工具提示不在这里。 */
const WORKER_PERSONA_DEFAULT_TEXT = [
  "你是一个普通任务助手，负责把交到你手上的具体事情办完。",
  "交代的事一定办到底：不推、不挑、不抱怨；办不成要说清卡在哪一步、缺什么。",
  "说话直接、克制、就事论事，给结论也给依据；不冒充总管，也不代表任何执事。",
  "涉及真实文件、真实数据、真实日程或当前时间的事，必须先用工具去看，不许凭印象回答或编造；看不到就说明缺什么。",
  "做不到、做不完或做偏了就如实说，不硬凑结果，更不谎报完成。",
  "没有预设的私人档案，也不主动建立执事身份。",
].join("");

/** 会话工具提示（仅 chatKind=worker 注入；派活工人没有这三件工具，不进 TASK.md）。 */
export const WORKER_PERSONA_CHAT_TOOLS =
  "需要长期记住的事用 remember；想不起对方说过什么用 recall；要定时提醒用 set_reminder。";

/** 人设正文字节上限（UTF-8 计）。 */
export const WORKER_PERSONA_LIMIT = 8192;

export function workerPersonaDefault(): string {
  return WORKER_PERSONA_DEFAULT_TEXT;
}

export function workerPersonaPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.WORKER_PERSONA_PATH?.trim() || ".data/worker-persona.md";
}

/** 文件优先；不存在 / 空 / 读失败 → 默认。读到的正文统一 trim，空串当默认。 */
export function readWorkerPersona(env: NodeJS.ProcessEnv = process.env): string {
  try {
    const text = readFileSync(workerPersonaPath(env), "utf8").trim();
    return text || workerPersonaDefault();
  } catch {
    return workerPersonaDefault();
  }
}

/** trim 后空 = 删文件（回默认）；否则原子写（临时文件 + rename），超限抛错。 */
export function writeWorkerPersona(text: string, env: NodeJS.ProcessEnv = process.env): void {
  const path = workerPersonaPath(env);
  const content = String(text ?? "").trim();
  if (!content) {
    rmSync(path, { force: true });
    return;
  }
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > WORKER_PERSONA_LIMIT) {
    throw new Error(`Worker 人设超过 ${WORKER_PERSONA_LIMIT} 字节上限（当前 ${bytes}）`);
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, "utf8");
  try {
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/** 缺省 = 开；false / 0 / off（大小写不敏感）→ 关。 */
export function workerPersonaEditEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagEnabled("WORKER_PERSONA_EDIT", env);
}

/**
 * 派活是否注入 worker 人设（2026-11-16 批2）。缺省开；
 * `WORKER_PERSONA_DISPATCH=false/0/off` 回滚到"TASK.md 不出人设段"的旧形态。
 */
export function workerPersonaDispatchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagEnabled("WORKER_PERSONA_DISPATCH", env);
}

/**
 * 进程启动装配一次（index.ts 在 installInternalAsk 旁调）：把共享人设推给 chancellor。
 * 开关关着就注 null——chancellor 侧 `workerPersonaText()` 返回空串，TASK.md 不出段。
 * 来源是惰性的：每张 TASK.md 现读文件，设置里改完**下一单**生效（与会话侧口径一致）。
 */
export function installWorkerPersonaDispatch(env: NodeJS.ProcessEnv = process.env): boolean {
  const enabled = workerPersonaDispatchEnabled(env);
  setWorkerPersonaSource(enabled ? () => readWorkerPersona(env) : null);
  return enabled;
}

export interface WorkerPersonaPayload {
  ok: true;
  persona: string;
  isDefault: boolean;
  editable: boolean;
  limit: number;
  chars: number;
}

/** GET / PUT 共用的响应形状；isDefault = 文件不存在或内容与默认一致。 */
export function workerPersonaPayload(env: NodeJS.ProcessEnv = process.env): WorkerPersonaPayload {
  const persona = readWorkerPersona(env);
  return {
    ok: true,
    persona,
    isDefault: persona === workerPersonaDefault(),
    editable: workerPersonaEditEnabled(env),
    limit: WORKER_PERSONA_LIMIT,
    chars: persona.length,
  };
}

/**
 * 端点定义收在本模块（与 mountCompanions / mountSkills 同款），由 index.ts 在
 * `/api/v1/agent/context-defaults` 附近挂载——鉴权沿用主 app 的 `/api/v1/*` 中间件，这里不另写。
 * 拆出挂载函数只是为了让 HTTP 断言能真起 Hono 路由，不 import index.ts（它会 serve 活端口）。
 */
export function mountWorkerPersonaRoutes(app: Hono): void {
  app.get("/api/v1/agent/worker-persona", (c) => {
    c.header("cache-control", "no-store");
    return c.json(workerPersonaPayload());
  });
  app.put("/api/v1/agent/worker-persona", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { persona?: unknown } | null;
    if (!body || typeof body.persona !== "string") {
      return c.json({ error: "bad_request", message: "persona 必须是字符串" }, 400);
    }
    const text = body.persona.trim();
    if (Buffer.byteLength(text, "utf8") > WORKER_PERSONA_LIMIT) {
      return c.json(
        { error: "bad_request", message: `persona 超过 ${WORKER_PERSONA_LIMIT} 字节上限` },
        400,
      );
    }
    if (!workerPersonaEditEnabled()) {
      return c.json(
        { error: "bad_request", message: "Worker 人设编辑未启用（WORKER_PERSONA_EDIT=false）" },
        400,
      );
    }
    writeWorkerPersona(text);
    c.header("cache-control", "no-store");
    return c.json(workerPersonaPayload());
  });
}
