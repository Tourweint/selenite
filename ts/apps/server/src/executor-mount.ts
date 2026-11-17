/**
 * 执行器设置端点（2026-11-16 多 CLI 打手适配）。
 *
 * GET  /api/v1/agent/executor        当前执行器 + 各 CLI 的模型/权限 + 控件元数据
 * PUT  /api/v1/agent/executor        写 `.data/executor.json`（原子替换）；`EXECUTOR_CONFIG=false` 时 400
 * POST /api/v1/agent/executor/probe  模型清单 / 一次极小真调（显式人工点击，可能耗少量额度）
 *
 * 权限：挂在 `/api/v1/*` 鉴权后面，与其它设置同权（不做更细的分级）。
 * 校验：执行器白名单、权限三值、模型串长度；非法值 400 带说明，不静默改。
 */

import { Hono } from "hono";
import {
  executorConfigEnabled,
  executorView,
  isSelectableExecutorKind,
  parseExecutorInput,
  readExecutorConfig,
  writeExecutorConfig,
} from "./executor-config.ts";
import { probeExecutor, probeNeedsThrottle } from "./executor-probe.ts";
import { flagEnabled } from "./flags.ts";

/** 检测按钮的简单节流：同一个进程 3 秒内只跑一次，避免连点起一堆 CLI。 */
let lastProbeAt = 0;

/** 回滚开关：`EXECUTOR_PROBE=false/0/off` 时检测端点返回 400，不 spawn 任何 CLI。 */
function probeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagEnabled("EXECUTOR_PROBE", env);
}

export function mountExecutorApi(app: Hono): void {
  app.get("/api/v1/agent/executor", (c) => c.json(executorView()));

  app.put("/api/v1/agent/executor", async (c) => {
    if (!executorConfigEnabled()) {
      return c.json(
        { message: "派活设置已关闭（EXECUTOR_CONFIG=false），当前值由 .env 决定" },
        400,
      );
    }
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = parseExecutorInput(body, readExecutorConfig());
    if (!parsed.ok) return c.json({ message: parsed.message }, 400);
    try {
      writeExecutorConfig(parsed.value);
    } catch (error) {
      return c.json(
        {
          message:
            error instanceof Error ? error.message : "执行器配置没存成",
        },
        400,
      );
    }
    return c.json(executorView());
  });

  app.post("/api/v1/agent/executor/probe", async (c) => {
    if (!probeEnabled()) {
      return c.json({ message: "执行器检测已关闭（EXECUTOR_PROBE=false）" }, 400);
    }
    const body: unknown = await c.req.json().catch(() => null);
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ message: "请求体必须是对象" }, 400);
    }
    const input = body as Record<string, unknown>;
    const employee = input.employee;
    if (typeof employee !== "string" || !isSelectableExecutorKind(employee)) {
      return c.json(
        { message: "employee 必须是本地可选的执行器之一" },
        400,
      );
    }
    const model =
      typeof input.model === "string" ? input.model.trim() : "";
    if (model.length > 200) {
      return c.json({ message: "模型名太长（≤200 字符）" }, 400);
    }
    if (probeNeedsThrottle(employee, model) && Date.now() - lastProbeAt < 3000) {
      return c.json({ message: "检测太频繁，3 秒后再试" }, 429);
    }
    try {
      const result = await probeExecutor(employee, model);
      // 缓存命中（没 spawn CLI）不占节流：清单页随便点；真拉 / 真调才计时。
      if (!result.cached) lastProbeAt = Date.now();
      return c.json(result);
    } catch (error) {
      // 原始错误只进服务端日志（可能带上游地址）。
      console.warn(
        `[executor] probe ${employee} 异常：${
          error instanceof Error ? error.message.slice(0, 200) : "unknown"
        }`,
      );
      return c.json({ message: "检测失败（详见服务端日志）" }, 500);
    }
  });
}
