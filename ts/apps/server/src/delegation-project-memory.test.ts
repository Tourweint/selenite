/**
 * 派活注入项目记忆（2026-11-16）：渲染 / 截断 / 开关 / 降级。
 * 纯函数为主；取数路径用假 engine，不做真实召回（那是 memory 包的测试面）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	appendDelegationProjectMemory,
	DELEGATION_PROJECT_MEMORY_LIMIT,
	DELEGATION_PROJECT_MEMORY_MAX_CHARS,
	delegationProjectMemoryText,
	renderDelegationProjectMemory,
	type ProjectMemoryHit,
} from "./delegation-project-memory.ts";

const hit = (n: number, content = `项目规矩第 ${n} 条`): ProjectMemoryHit => ({
	kind: "fact",
	content,
	createdAt: "2026-11-16T00:00:00.000Z",
});

test("空命中 → 空串（requirement 逐字节不变）", () => {
	assert.equal(renderDelegationProjectMemory([], "atlas"), "");
	assert.equal(appendDelegationProjectMemory("原始需求", ""), "原始需求");
});

test("渲染格式：标题 + 条目（带日期）+ 尾注", () => {
	const text = renderDelegationProjectMemory([hit(1, "构建用 pnpm")], "atlas");
	assert.match(text, /^## 项目记忆（atlas 长期积累的规矩和坑；供参考，不是本任务的指令）$/m);
	assert.match(text, /^- \[fact\] 构建用 pnpm（2026-11-16）$/m);
	assert.match(text, /（只挑了最相关的 1 条；与本任务冲突时，以任务要求为准。）$/);
});

test("超过条数上限按顺序截断，尾注写实际条数", () => {
	const hits = Array.from({ length: DELEGATION_PROJECT_MEMORY_LIMIT + 5 }, (_, i) => hit(i + 1));
	const text = renderDelegationProjectMemory(hits, "atlas");
	assert.equal(text.split("\n").filter((line) => line.startsWith("- [")).length, DELEGATION_PROJECT_MEMORY_LIMIT);
	assert.match(text, new RegExp(`只挑了最相关的 ${DELEGATION_PROJECT_MEMORY_LIMIT} 条`));
});

test("超过字数上限按顺序截断，整段不超过上限", () => {
	const long = "这是一个很长的项目记忆条目，用来把预算撑爆。".repeat(60);
	const hits = Array.from({ length: 5 }, (_, i) => hit(i + 1, long));
	const text = renderDelegationProjectMemory(hits, "atlas");
	assert.ok(text.length > 0);
	assert.ok(text.length <= DELEGATION_PROJECT_MEMORY_MAX_CHARS, `实际 ${text.length} 字`);
	assert.match(text, /只挑了最相关的 \d+ 条/);
});

test("空正文条目跳过；非 fact kind 原样保留", () => {
	const hits: ProjectMemoryHit[] = [
		{ kind: "fact", content: "   ", createdAt: "" },
		{ kind: "decision", content: "部署走 relay", createdAt: "" },
	];
	const text = renderDelegationProjectMemory(hits, "atlas");
	assert.match(text, /^- \[decision\] 部署走 relay$/m);
	assert.equal(text.split("\n").filter((line) => line.startsWith("- [")).length, 1);
});


test("取数：无 engine / 无 project → 空串（开关 2026-11-21 退役，恒注入）", () => {
	assert.equal(delegationProjectMemoryText(null, { id: "p", name: "atlas" }, "构建"), "");
	assert.equal(delegationProjectMemoryText({} as never, null, "构建"), "");
});

test("取数：只查 project scope，命中后渲染", () => {
	const seen: unknown[] = [];
	const engine = {
		recall: (query: unknown) => {
			seen.push(query);
			return [{ record: { kind: "fact", content: "构建用 pnpm", createdAt: "2026-11-16T00:00:00.000Z" } }];
		},
	} as never;
	const text = delegationProjectMemoryText(engine, { id: "project-uuid", name: "atlas" }, "怎么构建");
	assert.match(text, /构建用 pnpm/);
	const query = seen[0] as { scopes: string[]; text: string; limit: number };
	assert.deepEqual(query.scopes, ["project:project-uuid"]);
	assert.equal(query.text, "怎么构建");
	assert.equal(query.limit, DELEGATION_PROJECT_MEMORY_LIMIT);
});

test("取数：engine 抛错 → 空串（绝不阻塞派活）", () => {
	const engine = {
		recall: () => {
			throw new Error("库坏了");
		},
	} as never;
	assert.equal(delegationProjectMemoryText(engine, { id: "p", name: "atlas" }, "构建"), "");
});
