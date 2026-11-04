// 只读闸门探针：确认 `delegate` 在 read-only 模式下会被拦住。
//
// 为什么要单独测：`delegate` 本身不写文件，但它会起 worker 去写。漏了它，
// `AGENT_TOOL_POLICY=read-only` 就是个谎——用户以为只读，实际在后台改文件。
//
// 为什么断言函数而不是起服务：faux 给的工具参数是空对象（`provider.ts` 里只有
// `recall` 特判了参数），`delegate` 需要必填的 `requirement`，参数校验就过不去，
// 工具根本走不到闸门那一步。所以直接测 `readOnlyBlockReason()`。
//
// 用法：`tsx scripts/delegate-gate-probe.ts <read-only|full>`
export {}; // 让这个文件是模块，顶层 await 才合法

const mode = (process.argv[2] ?? "").trim();
if (mode !== "read-only" && mode !== "full") {
	console.error("用法：tsx scripts/delegate-gate-probe.ts <read-only|full>");
	process.exit(2);
}

process.env.AGENT_TOOL_POLICY = mode;
process.env.LLM_PROVIDER = "faux";
process.env.LLM_API_KEY = process.env.LLM_API_KEY ?? "";
process.env.AGENT_DB_PATH = process.env.AGENT_DB_PATH ?? ".data/gate-probe-agent.sqlite";
process.env.MEMORY_DB_PATH = process.env.MEMORY_DB_PATH ?? ".data/gate-probe-memory.db";

const { readOnlyBlockReason } = await import("../src/agent.ts");

/** 必须被拦：会写文件，或会起 worker 去写 */
const MUST_BLOCK = ["write", "edit", "bash", "powershell", "delegate", "propose_project"];
/** 不该被拦：只读，或只写记忆 */
const MUST_PASS = ["read", "remember", "recall", "set_reminder", "skill"];

let failed = 0;

if (mode === "read-only") {
	for (const name of MUST_BLOCK) {
		const reason = readOnlyBlockReason(name);
		if (reason) {
			console.log(`  ✓ ${name} 被拦 — ${reason}`);
		} else {
			console.log(`  ✗ ${name} 没被拦（read-only 下这是安全洞）`);
			failed += 1;
		}
	}
	for (const name of MUST_PASS) {
		if (readOnlyBlockReason(name) === undefined) {
			console.log(`  ✓ ${name} 放行`);
		} else {
			console.log(`  ✗ ${name} 被误拦`);
			failed += 1;
		}
	}
} else {
	for (const name of [...MUST_BLOCK, ...MUST_PASS]) {
		if (readOnlyBlockReason(name) === undefined) {
			console.log(`  ✓ ${name} 放行`);
		} else {
			console.log(`  ✗ ${name} 在 full 模式下被拦了（闸门写错）`);
			failed += 1;
		}
	}
}

console.log(failed === 0 ? `\n✓ ${mode} 闸门正确` : `\n✗ ${mode} 有 ${failed} 项不对`);
process.exit(failed === 0 ? 0 : 1);
