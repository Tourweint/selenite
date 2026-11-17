/**
 * native worker 工具面配置（2026-11-17 通用 worker 配置统一 批4）。
 *
 * 用户在「普通助手」页勾选本机工人能用哪几件工具；落点 `.data/worker-tools.json`
 * （`{disabled: string[]}` 取消名单，路径可用 WORKER_TOOLS_PATH 覆盖）。
 * 目录 = chancellor `worker-tools-source.ts` 的 canonical 四件（read/write/edit/bash），
 * 目录在 chancellor、labels 在这边——server 不 guess 工具集，只给人话名字。
 * 语义照抄执事工具勾选：存**取消名单**，未来给 worker 加新工具默认可见。
 *
 * 装配（`installWorkerToolsDispatch`，index.ts 启动调一次）：把「取消名单的补集」
 * 推给 chancellor 注入口，每张单现读文件，改完**下一单**生效。
 * 回滚：`WORKER_TOOLS_DISPATCH=false/0/off` → 不推来源 = 全开（旧行为）。
 *
 * 刻意不管：外部 CLI（它们用自己的内置工具，宿主不下发——2026-11-17 用户拍板）；
 * worker 会话（chatKind=worker）的工具面（全量 harness，另一条链路）。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Hono } from "hono";
import { flagEnabled } from "./flags.ts";
import {
  WORKER_TOOL_NAMES,
  effectiveWorkerTools,
  setWorkerToolsSource,
} from "../../../packages/chancellor/src/worker-tools-source.ts";

/** 给人看的目录（canonical 的中文名与边界；工具集本身以 chancellor 为准，server 不新增）。 */
export const WORKER_TOOL_CATALOG: ReadonlyArray<{
  name: string;
  label: string;
  note: string;
}> = [
  {
    name: "read",
    label: "读文件",
    note: "看任务材料与项目文件；关了工人基本干不了活",
  },
  {
    name: "write",
    label: "写文件",
    note: "REPORT.md 与产物落盘靠它；关了交付契约走 bash 也能凑合",
  },
  {
    name: "edit",
    label: "改文件",
    note: "精准修改项目里已有的文件；纯新建产物的活用不上",
  },
  {
    name: "bash",
    label: "跑命令",
    note: "构建 / 测试 / 查询都靠它",
  },
];

export function workerToolsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.WORKER_TOOLS_PATH?.trim() || ".data/worker-tools.json";
}

/** 缺省 = 开；false / 0 / off（大小写不敏感）→ 关（不推来源 = 全开）。 */
export function workerToolsDispatchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagEnabled("WORKER_TOOLS_DISPATCH", env);
}

function readDisabledList(path: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { disabled?: unknown };
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.disabled)) return [];
    const known = new Set<string>(WORKER_TOOL_NAMES);
    return [
      ...new Set(
        parsed.disabled.filter(
          (item): item is string => typeof item === "string" && known.has(item),
        ),
      ),
    ];
  } catch {
    return []; // 文件不存在 / 坏 JSON = 全开，不让配置问题卡派活
  }
}

function writeDisabledList(path: string, disabled: string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ disabled }, null, "\t")}\n`);
  renameSync(tmp, path);
}

export interface WorkerToolsPayload {
  ok: true;
  catalog: ReadonlyArray<{ name: string; label: string; note: string }>;
  disabled: string[];
  /** 每件工具当前是否可用（canonical 全集 × 取消名单）。 */
  enabled: Record<string, boolean>;
  /** 实际会下发给 native worker 的补集（canonical 序；空数组 = 真零工具）。 */
  granted: string[];
  dispatch: boolean;
}

export function workerToolsPayload(env: NodeJS.ProcessEnv = process.env): WorkerToolsPayload {
  const disabled = readDisabledList(workerToolsPath(env));
  const granted = effectiveWorkerTools(
    workerToolsDispatchEnabled(env)
      ? WORKER_TOOL_NAMES.filter((name) => !disabled.includes(name))
      : WORKER_TOOL_NAMES,
  );
  return {
    ok: true,
    catalog: WORKER_TOOL_CATALOG,
    disabled,
    enabled: Object.fromEntries(
      WORKER_TOOL_CATALOG.map((item) => [item.name, !disabled.includes(item.name)]),
    ),
    granted: [...granted],
    dispatch: workerToolsDispatchEnabled(env),
  };
}

/**
 * 进程启动装配一次（index.ts 紧随 installWorkerPersonaDispatch）：
 * 把取消名单补集推给 chancellor；每张单现读文件（惰性来源），改完下一单生效。
 */
export function installWorkerToolsDispatch(env: NodeJS.ProcessEnv = process.env): boolean {
  const enabled = workerToolsDispatchEnabled(env);
  setWorkerToolsSource(
    enabled
      ? () =>
          WORKER_TOOL_NAMES.filter((name) => !readDisabledList(workerToolsPath(env)).includes(name))
      : null,
  );
  return enabled;
}

/** GET / PUT 挂载（worker-persona 同款）；鉴权沿用主 app 的 /api/v1/* 中间件。
 *  env 可注入（单测换临时路径），缺省 process.env。 */
export function mountWorkerToolsRoutes(app: Hono, env: NodeJS.ProcessEnv = process.env): void {
  app.get("/api/v1/agent/worker-tools", (c) => {
    c.header("cache-control", "no-store");
    return c.json(workerToolsPayload(env));
  });
  app.put("/api/v1/agent/worker-tools", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { disabled?: unknown } | null;
    if (!body || !Array.isArray(body.disabled) || body.disabled.some((item) => typeof item !== "string")) {
      return c.json(
        { error: "bad_request", message: "disabled 必须是字符串数组" },
        400,
      );
    }
    const known = new Set<string>(WORKER_TOOL_NAMES);
    const unknown = [...new Set(body.disabled.filter((item) => !known.has(item)))];
    if (unknown.length > 0) {
      return c.json(
        {
          error: "bad_request",
          message: `未知工具：${unknown.join("、")}（本机工人只有 read / write / edit / bash）`,
          unknown,
        },
        400,
      );
    }
    writeDisabledList(workerToolsPath(env), [...new Set(body.disabled)]);
    c.header("cache-control", "no-store");
    return c.json(workerToolsPayload(env));
  });
}
