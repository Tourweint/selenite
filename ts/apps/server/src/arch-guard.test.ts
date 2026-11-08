import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { MemoryScope } from "@lifediary/memory";
import { WRITE_TOOLS } from "./approval-policy.ts";
import type { SkillStore } from "./skills.ts";
import { createTools, type ToolDeps } from "./tools.ts";

/**
 * 架构守卫：把 AGENTS.md 的硬约束从「人肉审查」变成测试断言。
 *
 * 2026-11-04 核对：提醒工具的注册名是 `set_reminder`（tools.ts 里变量叫 remind、
 * 但 name 字段是 set_reminder）。任务书写的 `remind` 是变量名不是工具名 —— 以代码为准。
 * `readOnlyBlockReason` 实际定义在 agent.ts，不在 approval-policy.ts，下面按真实位置加载。
 */

// ── 路径 ────────────────────────────────────────────────
const HERE = dirname(fileURLToPath(import.meta.url)); // ts/apps/server/src
const TS_ROOT = resolve(HERE, "../../../"); // ts/
const SHARED_INDEX = join(TS_ROOT, "packages/shared/src/index.ts");
const MEMORY_ROOT = join(TS_ROOT, "packages/memory");
const MEMORY_SRC = join(MEMORY_ROOT, "src");

// ── 闸门清单 ────────────────────────────────────────────
/** 读 / 记忆类：注册了但不需要进闸门（不写文件、不起进程、不派活）。 */
const READ_TOOLS = new Set([
	"remember",
	"recall",
	"set_reminder",
	"skill",
	"read",
	// 2026-11-08 扫尾批 8d：执事间递话只往对方会话提交一条输入，不写盘、不起进程；
	// 它的边界不在只读闸门，而在 lifecycle 的通道闸（执事会话 / 非自主轮 / hop=1）。
	"send_to_agent",
]);
/** 内核五件：pi-durable 的 CodingTools（read/write/edit/bash/powershell）。 */
const KERNEL_TOOLS = new Set(["read", "write", "edit", "bash", "powershell"]);
/** 已知写类：WRITE_TOOLS 至少得有这六个，防误删。 */
const KNOWN_WRITE_TOOLS = [
	"write",
	"edit",
	"bash",
	"powershell",
	"delegate",
	"propose_project",
];

// ── createTools 的最小合法 deps ─────────────────────────
const GLOBAL_SCOPE: MemoryScope = { type: "global" };
const MOCK_SKILLS: SkillStore = {
	names: () => [],
	manual: () => undefined,
	indexFor: () => undefined,
};
function makeDeps(over: Partial<ToolDeps> = {}): ToolDeps {
	// scopeOf 只在工具「执行」时才被调到，构造期用不到；给个合法值只为过类型检查。
	return { memory: null, scopeOf: () => GLOBAL_SCOPE, ...over };
}

// ── 文件扫描 / import 抽取 ──────────────────────────────
function specifiersOf(source: string): string[] {
	const found = new Set<string>();
	const patterns = [
		/\bfrom\s+["']([^"']+)["']/g,
		/\bimport\s+["']([^"']+)["']/g,
		/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
	];
	for (const re of patterns) {
		let m: RegExpExecArray | null;
		while ((m = re.exec(source)) !== null) found.add(m[1]);
	}
	return [...found];
}

function tsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...tsFiles(full));
		else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
	}
	return out;
}

/** target 是否逃出了 root（用于识别 ../../apps/... 这类反向依赖）。 */
function escapes(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

// ── readOnlyBlockReason 的加载 ──────────────────────────
// 它实际在 agent.ts，模块加载即读 policy、建 memoryEngine。先把 env 设好再动态 import：
//  - MEMORY_ENABLED=false：不建记忆库，避免单测写盘（红线：不碰 .data/）
//  - AGENT_TOOL_POLICY=read-only：走 env 初值策略，不写 policy.json（delegate-gate-probe.ts 同款）
//  - AGENT_BLOCKED_TOOLS：放一个哨兵名，用来断言 blocked 分支的优先级
//  - AGENT_POLICY_PATH 指向不存在的文件：loadPolicy 回落 env，不受残留 policy.json 影响
process.env.MEMORY_ENABLED = "false";
process.env.AGENT_TOOL_POLICY = "read-only";
process.env.AGENT_POLICY_PATH = fileURLToPath(
	new URL("./.arch-guard-no-policy.json", import.meta.url),
);
process.env.AGENT_BLOCKED_TOOLS = "ghost_blocked";
process.env.LLM_PROVIDER = "faux";
const agentModule = import("./agent.ts");

// ===== 1.1 闸门完整性 =====

test("闸门完整性：基础三件是纯读，都不在 WRITE_TOOLS 里", () => {
	const base = createTools(makeDeps({ delegate: false }));
	const names = base.map((t) => t.name);
	for (const name of ["remember", "recall", "set_reminder"]) {
		assert.ok(names.includes(name), `createTools 少了基础工具 ${name}`);
		assert.ok(!WRITE_TOOLS.has(name), `${name} 不该在 WRITE_TOOLS 里`);
	}
});

test("闸门完整性：实际注册全集 = WRITE_TOOLS ∪ READ_TOOLS", () => {
	const full = createTools(
		makeDeps({
			delegate: true,
			skills: MOCK_SKILLS,
			partners: true,
			// 执事间递话（2026-11-08 扫尾批 8d）：装配层显式传 relay 才注册；
			// 这里给个不落盘的桩，只为让"注册全集"把 send_to_agent 也覆盖进来。
			relay: { deliver: async () => ({ ok: false, error: "stub" }) },
		}),
	);
	const registered = new Set(full.map((t) => t.name));
	for (const name of KERNEL_TOOLS) registered.add(name);
	const covered = new Set<string>([...WRITE_TOOLS, ...READ_TOOLS]);

	// 注册了却没被闸门/白名单覆盖 —— 这就是「加了新工具没进闸门」，直接红。
	const uncovered = [...registered].filter((n) => !covered.has(n)).sort();
	// 闸门/白名单里有却没实际注册 —— 误删工具或加了多余条目，也红。
	const extra = [...covered].filter((n) => !registered.has(n)).sort();
	assert.deepEqual(
		uncovered,
		[],
		`这些工具注册了却没被闸门/白名单覆盖（新工具要进闸门）：${uncovered.join(", ")}`,
	);
	assert.deepEqual(
		extra,
		[],
		`WRITE_TOOLS/READ_TOOLS 里有没实际注册的名字：${extra.join(", ")}`,
	);
});

test("闸门完整性：WRITE_TOOLS 至少含六个已知写类工具", () => {
	for (const name of KNOWN_WRITE_TOOLS) {
		assert.ok(WRITE_TOOLS.has(name), `WRITE_TOOLS 少了 ${name}`);
	}
});

// ===== 1.2 依赖方向 =====

test("依赖方向：shared 契约单文件不许有相对 / @lifediary 导入", () => {
	const specs = specifiersOf(readFileSync(SHARED_INDEX, "utf8"));
	assert.ok(specs.length > 0, "没抽到 import，正则可能失效");
	for (const spec of specs) {
		assert.ok(
			!spec.startsWith(".") && !spec.startsWith("/"),
			`shared 不许有相对导入：${spec}`,
		);
		assert.ok(
			!spec.startsWith("@lifediary/"),
			`shared 不许依赖 @lifediary/*：${spec}`,
		);
	}
	assert.deepEqual(
		[...new Set(specs)].sort(),
		["zod"],
		"shared 当前只应依赖 zod（新增外部依赖需过 review）",
	);
});

test("依赖方向：memory 包不许反向依赖 server / 逃出包", () => {
	const files = tsFiles(MEMORY_SRC);
	assert.ok(files.length > 0, "没扫到 memory/src 的 .ts 文件");
	const bad: string[] = [];
	for (const file of files) {
		for (const spec of specifiersOf(readFileSync(file, "utf8"))) {
			const where = relative(TS_ROOT, file);
			if (spec.includes("@lifediary/server") || spec.includes("apps/server")) {
				bad.push(`${where} -> ${spec}`);
			} else if (spec.startsWith(".") && escapes(MEMORY_ROOT, resolve(dirname(file), spec))) {
				bad.push(`${where} -> ${spec}（逃出包）`);
			}
		}
	}
	assert.deepEqual(bad, [], `发现反向 / 逃包导入：\n${bad.join("\n")}`);
});

// ===== 1.3 只读闸门行为回归 =====

test("只读闸门：WRITE_TOOLS 六件在只读档都被拦，READ_TOOLS 五件放行", async () => {
	const { readOnlyBlockReason } = await agentModule;
	for (const name of WRITE_TOOLS) {
		assert.notEqual(readOnlyBlockReason(name), undefined, `${name} 在只读档应被拦`);
	}
	for (const name of READ_TOOLS) {
		assert.equal(readOnlyBlockReason(name), undefined, `${name} 在只读档应放行`);
	}
});

test("只读闸门：policy.blocked 命中的名字优先返回禁用理由", async () => {
	const { readOnlyBlockReason } = await agentModule;
	// ghost_blocked 是哨兵：既非读类也非写类，只因在 blocked 名单里就被禁，
	// 证明 blocked 分支优先于 read-only / 放行判断。
	assert.match(readOnlyBlockReason("ghost_blocked") ?? "", /已被禁用/);
});
