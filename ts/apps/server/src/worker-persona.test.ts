/**
 * Worker 人设存储单测（2026-11-16）：临时目录 + env 显式传路径，不碰真实 .data / .env / 活服务。
 * 钉住：默认回落 / 写读往返 / 空串删文件回默认 / 8KB 护栏 / 编辑开关 / 响应形状。
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  WORKER_PERSONA_CHAT_TOOLS,
  WORKER_PERSONA_LIMIT,
  installWorkerPersonaDispatch,
  workerPersonaDefault,
  workerPersonaDispatchEnabled,
  workerPersonaEditEnabled,
  workerPersonaPath,
  workerPersonaPayload,
  readWorkerPersona,
  writeWorkerPersona,
} from "./worker-persona.ts";
import {
  setWorkerPersonaSource,
  workerPersonaText,
} from "../../../../../chancellor/src/worker-persona-source.ts";

const root = mkdtempSync(join(tmpdir(), "lifediary-worker-persona-"));
const FILE = join(root, "worker-persona.md");
const env = { WORKER_PERSONA_PATH: FILE };

after(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* 临时目录留系统清理 */
  }
});

test("路径：env 覆盖 / 缺省落点", () => {
  assert.equal(workerPersonaPath(env), FILE);
  assert.equal(workerPersonaPath({}), ".data/worker-persona.md");
});

test("文件不存在 → 默认正文；isDefault 成立", () => {
  assert.equal(existsSync(FILE), false, "前置：临时文件不存在");
  const text = readWorkerPersona(env);
  assert.equal(text, workerPersonaDefault());
  const payload = workerPersonaPayload(env);
  assert.equal(payload.ok, true);
  assert.equal(payload.isDefault, true);
  assert.equal(payload.editable, true);
  assert.equal(payload.limit, WORKER_PERSONA_LIMIT);
  assert.equal(payload.chars, text.length);
});

test("写入后读回一致；isDefault 变 false；原子写不留临时文件", () => {
  const text = "你是一个替人跑腿的助手。先动手，再汇报。";
  writeWorkerPersona(text, env);
  assert.equal(readWorkerPersona(env), text);
  assert.equal(workerPersonaPayload(env).isDefault, false);
  assert.equal(existsSync(`${FILE}.${process.pid}.tmp`), false, "临时文件已 rename 掉");
});

test("空串写入 → 删文件 → 读回默认，isDefault 恢复 true", () => {
  writeWorkerPersona("先写一份", env);
  assert.equal(existsSync(FILE), true);
  writeWorkerPersona("   \n  ", env);
  assert.equal(existsSync(FILE), false, "trim 后空 = 删文件");
  assert.equal(readWorkerPersona(env), workerPersonaDefault());
  assert.equal(workerPersonaPayload(env).isDefault, true);
});

test("超 8192 字节 → 写入抛错，不落文件", () => {
  const big = "字".repeat(WORKER_PERSONA_LIMIT); // 3 字节/字，必超
  assert.throws(() => writeWorkerPersona(big, env), /8192 字节上限/);
  assert.equal(existsSync(FILE), false, "超限不改变原文件状态");
});

test("写默认值本身 → isDefault 仍为 true（内容与默认一致）", () => {
  writeWorkerPersona(workerPersonaDefault(), env);
  assert.equal(workerPersonaPayload(env).isDefault, true);
  writeWorkerPersona("", env); // 收尾：删文件，避免影响同进程其它 case
});

test("编辑开关：缺省开；false / 0 / off（含大小写与空白）关", () => {
  assert.equal(workerPersonaEditEnabled({}), true);
  assert.equal(workerPersonaEditEnabled({ WORKER_PERSONA_EDIT: "true" }), true);
  assert.equal(workerPersonaEditEnabled({ WORKER_PERSONA_EDIT: " FALSE " }), false);
  assert.equal(workerPersonaEditEnabled({ WORKER_PERSONA_EDIT: "0" }), false);
  assert.equal(workerPersonaEditEnabled({ WORKER_PERSONA_EDIT: "off" }), false);
  assert.equal(workerPersonaPayload({ WORKER_PERSONA_EDIT: "false" }).editable, false);
});

// ── 批2：人设拆层 + 派活注入（2026-11-16 通用 worker 配置统一） ──

test("默认正文不含工具提示（工具行只在会话侧拼接）", () => {
  const text = workerPersonaDefault();
  assert.ok(!text.includes("remember"), "共享正文里不许出现会话工具提示");
  assert.ok(!text.includes("set_reminder"), "共享正文里不许出现会话工具提示");
  assert.ok(WORKER_PERSONA_CHAT_TOOLS.includes("remember"));
  assert.ok(WORKER_PERSONA_CHAT_TOOLS.includes("recall"));
  assert.ok(WORKER_PERSONA_CHAT_TOOLS.includes("set_reminder"));
});

test("派活注入开关：缺省开；false / 0 / off 关", () => {
  assert.equal(workerPersonaDispatchEnabled({}), true);
  assert.equal(workerPersonaDispatchEnabled({ WORKER_PERSONA_DISPATCH: "FALSE" }), false);
  assert.equal(workerPersonaDispatchEnabled({ WORKER_PERSONA_DISPATCH: "0" }), false);
  assert.equal(workerPersonaDispatchEnabled({ WORKER_PERSONA_DISPATCH: "off" }), false);
});

test("installWorkerPersonaDispatch：开 → chancellor 拿到文件正文；关 → 空串", () => {
  // 收尾恢复：这条测试结束时把来源摘掉，免得污染同进程其它用例
  try {
    writeWorkerPersona("派活工人的人设正文。", env);
    assert.equal(installWorkerPersonaDispatch({ ...env }), true);
    assert.equal(workerPersonaText(), "派活工人的人设正文。");
    assert.equal(installWorkerPersonaDispatch({ ...env, WORKER_PERSONA_DISPATCH: "off" }), false);
    assert.equal(workerPersonaText(), "", "开关关 = chancellor 拿到空串，TASK.md 不出段");
    // 来源抛错也吞掉返回空串，绝不阻塞派活
    setWorkerPersonaSource(() => {
      throw new Error("boom");
    });
    assert.equal(workerPersonaText(), "");
  } finally {
    setWorkerPersonaSource(null);
    writeWorkerPersona("", env); // 收尾删文件
  }
});

test("未装配来源时 chancellor 拿空串（chancellor 单独跑的形态）", () => {
  setWorkerPersonaSource(null);
  assert.equal(workerPersonaText(), "");
});
