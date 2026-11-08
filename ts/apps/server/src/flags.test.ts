import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Hono } from "hono";
import {
	FLAG_DEFS,
	flagsPath,
	loadFlagOverrides,
	mountFlags,
	setFlag,
} from "./flags.ts";

/**
 * 高级开关（2026-11-09）：文件覆盖 env / setFlag 落盘且热生效 / API 校验与回滚开关。
 * 全部用临时目录，不碰真实 .data；env 改动逐项复原。
 */
const root = mkdtempSync(join(tmpdir(), "lifediary-flags-"));
process.env.AGENT_FLAGS_PATH = join(root, "agent-flags.json");

function cleanupEnv(keys: string[]): void {
	for (const key of keys) delete process.env[key];
}

test("loadFlagOverrides：文件里的合法值覆盖 env，非法键跳过", () => {
	const path = flagsPath();
	writeFileSync(path, JSON.stringify({ AUTONOMY_ENABLED: "true", NOT_A_FLAG: "x", MEMORY_EXTRACT: "bogus" }), "utf8");
	cleanupEnv(["AUTONOMY_ENABLED", "MEMORY_EXTRACT"]);
	const applied = loadFlagOverrides();
	assert.equal(applied, 1);
	assert.equal(process.env.AUTONOMY_ENABLED, "true");
	assert.equal(process.env.MEMORY_EXTRACT, undefined);
	cleanupEnv(["AUTONOMY_ENABLED"]);
});

test("setFlag：落盘 + 同步写 env（懒读的消费代码当场生效）+ 非法值 400", () => {
	cleanupEnv(["AGENT_ATTACHMENTS"]);
	const ok = setFlag("AGENT_ATTACHMENTS", "false");
	assert.equal(ok.ok, true);
	assert.equal(process.env.AGENT_ATTACHMENTS, "false");
	const onDisk = JSON.parse(readFileSync(flagsPath(), "utf8"));
	assert.equal(onDisk.AGENT_ATTACHMENTS, "false");

	const badKey = setFlag("NOT_A_FLAG", "true");
	assert.equal(badKey.ok, false);
	const badValue = setFlag("AGENT_ATTACHMENTS", "maybe");
	assert.equal(badValue.ok, false);
	cleanupEnv(["AGENT_ATTACHMENTS"]);
});

test("API：GET 列表带 hot/defaultValue，PUT 校验取值，AGENT_FLAGS_UI=false 整组不挂", async () => {
	const app = new Hono();
	mountFlags(app);
	const list = await app.request("/api/v1/agent/flags");
	assert.equal(list.status, 200);
	const data = (await list.json()) as { flags: { key: string; hot: boolean }[] };
	assert.ok(data.flags.length >= FLAG_DEFS.length);
	const autonomy = data.flags.find((flag) => flag.key === "AUTONOMY_ENABLED");
	assert.equal(autonomy?.hot, true);
	const companions = data.flags.find((flag) => flag.key === "COMPANIONS_ENABLED");
	assert.equal(companions?.hot, false, "执事总闸是挂载期冻结，标 hot=false");

	const put = await app.request("/api/v1/agent/flags/CHANCELLOR_ENABLED", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ value: "false" }),
	});
	assert.equal(put.status, 200);
	assert.equal(process.env.CHANCELLOR_ENABLED, "false");
	const bad = await app.request("/api/v1/agent/flags/CHANCELLOR_ENABLED", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ value: "maybe" }),
	});
	assert.equal(bad.status, 400);
	const unknown = await app.request("/api/v1/agent/flags/NOPE", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ value: "true" }),
	});
	assert.equal(unknown.status, 404);
	cleanupEnv(["CHANCELLOR_ENABLED"]);

	const closed = new Hono();
	mountFlags(closed, { enabled: false });
	assert.equal((await closed.request("/api/v1/agent/flags")).status, 404);
});
