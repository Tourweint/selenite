import assert from "node:assert/strict";
import { test } from "node:test";
import { branchErrorText, formatBranchOrigin } from "../web/branch.js";

/**
 * 从回答分支的展示文案（2026-11-17 批3b）：来源行与失败提示都是纯函数，守住字面口径。
 */

test("有 sourceTitle + 有效时间：文案含标题与时间", () => {
  const at = Date.now() - 1000; // 今天，formatMessageClock 走 HH:mm 分支
  const result = formatBranchOrigin({ source: "conv-1", sourceTitle: "装修那摊事", at });
  assert.equal(result.source, "conv-1");
  assert.match(result.text, /^副本 · 来自 装修那摊事 · /);
  assert.match(result.text, /\d{2}:\d{2}/);
});

test("无 sourceTitle：用「一条会话」兜底", () => {
  const result = formatBranchOrigin({ source: "conv-1", at: Date.now() });
  assert.match(result.text, /^副本 · 来自 一条会话 · /);
});

test("at=0 / 非数字：不出现时间", () => {
  assert.equal(formatBranchOrigin({ source: "conv-1", at: 0 }).text, "副本 · 来自 一条会话");
  assert.equal(formatBranchOrigin({ source: "conv-1", at: "x" }).text, "副本 · 来自 一条会话");
});

test("origin 为空 / 缺 source：返回 null", () => {
  assert.equal(formatBranchOrigin(null), null);
  assert.equal(formatBranchOrigin({}), null);
  assert.equal(formatBranchOrigin({ sourceTitle: "有标题没来源" }), null);
});

test("已知错误码映射到预期中文；未知码给通用句", () => {
  assert.match(branchErrorText("conversation_busy"), /还在跑/);
  assert.match(branchErrorText("branch_point_empty"), /没有正文/);
  assert.match(branchErrorText("branch_too_large"), /先压缩再复制/);
  assert.match(branchErrorText("side_sessions_disabled"), /副会话插件已关闭/);
  assert.match(branchErrorText("branch_not_supported"), /不能分支/);
  assert.equal(branchErrorText("some_unknown_code"), "分支失败，稍后再试");
  assert.equal(branchErrorText(""), "分支失败，稍后再试");
});
