/**
 * 本机 worker 工具面单测（2026-11-17 批4）：canonical 边界 / 交集收敛 / 注入三态。
 * worker-main 不能 import（模块顶层就跑 parseArgs + main），纯逻辑全收在 worker-tools-source.ts。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WORKER_TOOL_NAMES,
  effectiveWorkerTools,
  setWorkerToolsSource,
  workerAllowedTools,
} from "./worker-tools-source.ts";

test("canonical 四件：read / write / edit / bash", () => {
  assert.deepEqual([...WORKER_TOOL_NAMES], ["read", "write", "edit", "bash"]);
});

test("effectiveWorkerTools：只认 canonical、去重、保序；乱值筛空就是真零", () => {
  assert.deepEqual(effectiveWorkerTools(["write", "read"]), ["read", "write"]);
  assert.deepEqual(effectiveWorkerTools(["bash", "bash", "edit"]), ["edit", "bash"]);
  assert.deepEqual(effectiveWorkerTools(["web_search", "delegate"]), [], "外来工具一律筛掉");
  assert.deepEqual(effectiveWorkerTools([]), [], "空数组 = 真零工具，不回退全开");
  assert.deepEqual(effectiveWorkerTools(null), []);
  assert.deepEqual(effectiveWorkerTools(undefined), []);
  assert.deepEqual(
    effectiveWorkerTools("read,write" as unknown as readonly string[]),
    [],
    "非数组一律零（类型坏了不给工具）",
  );
});

test("未注入来源 → null（全开，旧行为）", () => {
  setWorkerToolsSource(null);
  assert.equal(workerAllowedTools(), null);
});

test("注入取消名单补集：原样交回；空集 = 真零工具；来源抛错按未注入", () => {
  try {
    setWorkerToolsSource(() => ["read", "write"]);
    assert.deepEqual(workerAllowedTools(), ["read", "write"]);
    // 显式全关：宿主真的勾成零工具 → 空数组（池据此下发零工具，不静默回退）
    setWorkerToolsSource(() => []);
    assert.deepEqual(workerAllowedTools(), []);
    // 来源抛错 = 当没装配，全开
    setWorkerToolsSource(() => {
      throw new Error("宿主配置炸了");
    });
    assert.equal(workerAllowedTools(), null);
  } finally {
    setWorkerToolsSource(null);
  }
});
