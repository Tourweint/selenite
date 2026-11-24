import assert from "node:assert/strict";
import { test } from "node:test";
import { taskProjectRoots } from "./scheduler.ts";
import type { ProjectRef } from "./types.ts";

/**
 * 派活按项目下发文件夹（2026-11-24）：隔离形态不把真实主文件夹交给工人，
 * 非隔离形态全部下发；回滚开关一行退回旧形态。
 */

const PROJECT: ProjectRef = {
  id: "p-1",
  name: "宿主",
  rootPath: "/repo",
  roots: [
    { label: "主仓", path: "/repo", role: "primary" },
    { label: "手机端", path: "/repo-phone", role: "extra" },
  ],
};

test("隔离形态：只下发主文件夹之外的根", () => {
  assert.deepEqual(taskProjectRoots(PROJECT, true), [
    { label: "手机端", path: "/repo-phone", role: "extra" },
  ]);
});

test("非隔离形态：全部 roots 都下发（cwd 可能只是其中一个子目录）", () => {
  assert.deepEqual(taskProjectRoots(PROJECT, false), PROJECT.roots);
});

test("单根项目 + 隔离：没有可下发的额外根", () => {
  assert.equal(
    taskProjectRoots({ ...PROJECT, roots: [PROJECT.roots![0]] }, true),
    undefined,
  );
});

test("回滚开关 DELEGATION_PROJECT_ROOTS=0：不下发（旧形态）", () => {
  const previous = process.env.DELEGATION_PROJECT_ROOTS;
  process.env.DELEGATION_PROJECT_ROOTS = "0";
  try {
    assert.equal(taskProjectRoots(PROJECT, false), undefined);
    assert.equal(taskProjectRoots(PROJECT, true), undefined);
  } finally {
    if (previous === undefined) delete process.env.DELEGATION_PROJECT_ROOTS;
    else process.env.DELEGATION_PROJECT_ROOTS = previous;
  }
});
