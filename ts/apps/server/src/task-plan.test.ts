import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveRequestTasks } from "../../../packages/chancellor/src/plan.ts";

/**
 * 拆单归属（2026-11-23 调度简化批 7）：resolveRequestTasks 的确定性校验与单任务兜底。
 * 这些路径不调任何模型，纯输入 → 输出，直接单测即可。
 */

test("合法 tasks 直用，source=dispatcher", () => {
	const result = resolveRequestTasks({
		raw: [
			{
				title: "写a",
				slug: "write-a",
				instruction: "创建 a.txt",
				done_when: "a.txt 存在",
				dependsOn: [],
				writes: ["a.txt"],
			},
			{
				title: "写b",
				slug: "write-b",
				instruction: "创建 b.txt",
				done_when: "b.txt 存在",
				dependsOn: [1],
				writes: ["b.txt"],
			},
		],
		maxTasks: 5,
		requirement: "写两个文件",
	});
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.source, "dispatcher");
	assert.equal(result.tasks.length, 2);
	assert.deepEqual(result.tasks[1].dependsOn, [1]);
});

test("非法 tasks 拒绝并写清字段", () => {
	const missingWrites = resolveRequestTasks({
		raw: [
			{
				title: "写a",
				slug: "write-a",
				instruction: "创建 a.txt",
				done_when: "a.txt 存在",
				dependsOn: [],
			},
		],
		maxTasks: 5,
		requirement: "写一个文件",
	});
	assert.equal(missingWrites.ok, false);
	if (missingWrites.ok) return;
	assert.match(missingWrites.error, /writes/);

	const upperSlug = resolveRequestTasks({
		raw: [
			{
				title: "写a",
				slug: "Write-A",
				instruction: "创建 a.txt",
				done_when: "a.txt 存在",
				dependsOn: [],
				writes: ["a.txt"],
			},
		],
		maxTasks: 5,
		requirement: "写一个文件",
	});
	assert.equal(upperSlug.ok, false);
	if (upperSlug.ok) return;
	assert.match(upperSlug.error, /slug/);

	const tooMany = resolveRequestTasks({
		raw: Array.from({ length: 6 }, (_, index) => ({
			title: `写${index + 1}`,
			slug: `write-${index + 1}`,
			instruction: `创建 ${index + 1}.txt`,
			done_when: `${index + 1}.txt 存在`,
			dependsOn: [],
			writes: [`${index + 1}.txt`],
		})),
		maxTasks: 5,
		requirement: "写六个文件",
	});
	assert.equal(tooMany.ok, false);
	if (tooMany.ok) return;
	assert.match(tooMany.error, /1-5/);

	const badWrite = resolveRequestTasks({
		raw: [
			{
				title: "写a",
				slug: "write-a",
				instruction: "创建 a.txt",
				done_when: "a.txt 存在",
				dependsOn: [],
				writes: ["../escape.txt"],
			},
		],
		maxTasks: 5,
		requirement: "写一个文件",
	});
	assert.equal(badWrite.ok, false);
	if (badWrite.ok) return;
	assert.match(badWrite.error, /writes/);
});

test("没给 tasks 兜底成单任务，整项目写集", () => {
	const result = resolveRequestTasks({
		raw: undefined,
		maxTasks: 5,
		requirement: "写 hello",
		steps: ["读 a", "写 b"],
	});
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.source, "single");
	assert.equal(result.tasks.length, 1);
	assert.equal(result.tasks[0].slug, "task");
	assert.deepEqual(result.tasks[0].writes, ["**"]);
	assert.match(result.tasks[0].instruction, /## 步骤/);
});

test("phone 雇员清空写集", () => {
	const result = resolveRequestTasks({
		raw: undefined,
		maxTasks: 5,
		requirement: "写 hello",
		steps: ["读 a", "写 b"],
		employee: "phone",
	});
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.deepEqual(result.tasks[0].writes, []);
});