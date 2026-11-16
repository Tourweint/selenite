/**
 * native worker 工具面单测（2026-11-17 批4）：临时目录 + env 显式传路径，
 * 不碰真实 .data / 活服务。钉住：默认全开 / 取消名单往返 / 未知工具 400 / 形状 / 装配三态。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Hono } from "hono";
import {
  WORKER_TOOL_CATALOG,
  installWorkerToolsDispatch,
  mountWorkerToolsRoutes,
  workerToolsDispatchEnabled,
  workerToolsPayload,
} from "./worker-tools.ts";
import {
  setWorkerToolsSource,
  workerAllowedTools,
} from "../../../../../chancellor/src/worker-tools-source.ts";

const root = mkdtempSync(join(tmpdir(), "lifediary-worker-tools-"));
const env = { WORKER_TOOLS_PATH: join(root, "worker-tools.json") };

after(() => {
  setWorkerToolsSource(null);
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* 临时目录留系统清理 */
  }
});

test("目录：canonical 四件，server 不新增工具", () => {
  assert.deepEqual(
    WORKER_TOOL_CATALOG.map((item) => item.name),
    ["read", "write", "edit", "bash"],
  );
});

test("默认（无文件）：全部可用，granted = 全集，dispatch 开", () => {
  const payload = workerToolsPayload(env);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.disabled, []);
  assert.deepEqual(payload.granted, ["read", "write", "edit", "bash"]);
  assert.equal(payload.enabled.read, true);
  assert.equal(payload.dispatch, true);
});

test("PUT 端点：写取消名单并回读；未知工具 400 带名单；坏 body 400", async () => {
  const app = new Hono();
  // env 注入临时路径：端点必须沿同一个 env 读写，不许碰真实 .data（曾因此误写）
  mountWorkerToolsRoutes(app, env);
  const put = (body: unknown) =>
    app.request("/api/v1/agent/worker-tools", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const ok = await put({ disabled: ["edit", "bash", "edit"] });
  assert.equal(ok.status, 200);
  const okBody = (await ok.json()) as {
    ok: boolean;
    disabled: string[];
    granted: string[];
    enabled: Record<string, boolean>;
  };
  assert.deepEqual(okBody.disabled, ["edit", "bash"]);
  assert.deepEqual(okBody.granted, ["read", "write"]);
  assert.equal(okBody.enabled.edit, false);

  const unknown = await put({ disabled: ["web_search"] });
  assert.equal(unknown.status, 400);
  const unknownBody = (await unknown.json()) as { unknown?: string[] };
  assert.deepEqual(unknownBody.unknown, ["web_search"]);

  const bad = await put({ disabled: "read" });
  assert.equal(bad.status, 400);
  const badBody = (await bad.json()) as { error?: string };
  assert.equal(badBody.error, "bad_request");
});

test("写盘文件坏 JSON → 回落全开，不让配置卡派活", () => {
  const brokenEnv = { WORKER_TOOLS_PATH: join(root, "broken.json") };
  writeFileSync(brokenEnv.WORKER_TOOLS_PATH, "{oops", "utf8");
  const payload = workerToolsPayload(brokenEnv);
  assert.deepEqual(payload.disabled, []);
  assert.deepEqual(payload.granted, ["read", "write", "edit", "bash"]);
});

test("回滚开关：WORKER_TOOLS_DISPATCH=false → granted 全集 + 来源不推", () => {
  assert.equal(workerToolsDispatchEnabled({}), true);
  assert.equal(workerToolsDispatchEnabled({ WORKER_TOOLS_DISPATCH: "off" }), false);
  const payload = workerToolsPayload({ ...env, WORKER_TOOLS_DISPATCH: "false" });
  assert.deepEqual(payload.granted, ["read", "write", "edit", "bash"]);
  assert.equal(payload.dispatch, false);
});

test("installWorkerToolsDispatch：开 → chancellor 拿到补集且每单现读；关 → null", () => {
  try {
    assert.equal(installWorkerToolsDispatch(env), true);
    assert.deepEqual(workerAllowedTools(), ["read", "write"]);
    // 改文件（模拟下一单前用户在界面改了）：来源惰性，现读生效
    writeFileSync(
      env.WORKER_TOOLS_PATH,
      JSON.stringify({ disabled: ["read", "write", "edit", "bash"] }),
      "utf8",
    );
    assert.deepEqual(workerAllowedTools(), [], "全关也如实下发空集");
    assert.equal(installWorkerToolsDispatch({ ...env, WORKER_TOOLS_DISPATCH: "0" }), false);
    assert.equal(workerAllowedTools(), null, "开关关 = 来源不推，worker 全开");
  } finally {
    setWorkerToolsSource(null);
  }
});
