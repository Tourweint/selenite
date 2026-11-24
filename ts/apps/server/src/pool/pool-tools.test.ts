import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { ToolTask, type ToolHookCall } from "@earendil-works/pi-durable";
import { buildPoolRegistry, POOL_ALLOWED_TOOLS, pathBlockReason, poolBoundaryDirs, poolToolCatalog, type PoolToolDeps } from "./pool-tools.ts";
import { POOL_TOOL_NAMES } from "./task-profile.ts";

/**
 * 池工具面的单测：白名单常量 + 路径边界纯函数 + 一条经真实 registry 取出的 beforeTool 用例。
 *
 * 不起 Harness、不连模型、不起真进程：registry 是纯内存结构，`beforeTool` 是纯函数
 * （读 `currentDirs`、看 call），所以"换票后边界跟着换"可以在单测里直接执行钩子验证；
 * 完整工具循环（模型 → 工具 → 回写）仍属探针（接上 pool-main 后真跑一轮）。
 *
 * 路径一律用 path.join / path.resolve 构造，不写死分隔符——Windows 与 POSIX 都要绿。
 * 全程不落盘：那些路径只是字符串，没有 mkdir / writeFile，也不 import 任何会碰 `.data/` 的模块。
 */

const TASK_DIR = path.resolve("pool-test-root", "qoder-tasks", "p2-pool-skeleton");
const WORK_DIR = path.resolve("pool-test-root", "repo");
const DIRS = [TASK_DIR, WORK_DIR] as const;

test("POOL_ALLOWED_TOOLS 恰好五件，且与 profile 那份同源", () => {
	assert.deepEqual([...POOL_ALLOWED_TOOLS].sort(), ["bash", "edit", "escalate", "read", "write"]);
	assert.equal(POOL_ALLOWED_TOOLS.size, 5);
	// 定义层与执行层不许是两张表
	assert.deepEqual([...POOL_ALLOWED_TOOLS].sort(), [...POOL_TOOL_NAMES].sort());
	// 池里没有的东西：派活、跨会话、reminder 类工具一律不该在白名单上
	for (const name of ["delegate", "task", "todo", "tool_search", "remember", "recall", "set_reminder", "grep"]) {
		assert.ok(!POOL_ALLOWED_TOOLS.has(name), `${name} 不该在池白名单里`);
	}
});

test("read 落在任务目录内：放行", () => {
	assert.equal(pathBlockReason("read", { path: "REPORT.md" }, DIRS), undefined);
	assert.equal(pathBlockReason("read", { path: path.join(TASK_DIR, "TASK.md") }, DIRS), undefined);
	// 中途绕出去再绕回来，解析后仍在界内 → 放行（判的是解析结果，不是字符串形状）
	assert.equal(
		pathBlockReason("read", { path: path.join(TASK_DIR, "sub", "..", "notes.md") }, DIRS),
		undefined,
	);
});

test("write 用 ../ 逃出两个目录：拦，且消息带上原路径", () => {
	// 相对路径按"每个候选目录"解析（isInside 的 resolve(parent, child)），
	// 往上跳出两个目录之外就是越界——这一条与进程 cwd 无关，判据不依赖 cwd。
	const escape = path.join("..", "..", "..", "outside.env");
	const reason = pathBlockReason("write", { path: escape }, DIRS);
	assert.ok(reason, "../ 逃逸必须被拦下");
	assert.ok(reason.startsWith("路径不在任务目录或工作目录内："), `消息口径不对：${reason}`);
	// 消息里带模型原样写出的路径，方便它自己改对（这条只回给模型，不进日志）
	assert.ok(reason.includes(escape));
});

test("read 指向两目录之外的绝对路径：拦（读也算越界）", () => {
	const outside = path.resolve("pool-test-root", "other-user", "secret.txt");
	assert.ok(!DIRS.some((dir) => outside.startsWith(dir)), "夹具本身要真的在界外");
	for (const tool of ["read", "write", "edit"]) {
		assert.ok(pathBlockReason(tool, { path: outside }, DIRS), `${tool} 读界外绝对路径必须被拦`);
	}
});

test("bash 与 escalate 不参与路径判定", () => {
	// bash 的越界在命令文本里，没有 path 参数可判；这一层不假装能拦住
	assert.equal(pathBlockReason("bash", { command: "cat ../../../etc/passwd" }, DIRS), undefined);
	assert.equal(pathBlockReason("bash", { path: path.resolve("..", "x") }, DIRS), undefined);
	assert.equal(pathBlockReason("escalate", { question: "选 A 还是 B" }, DIRS), undefined);
});

test("项目其他文件夹进边界（2026-11-24）：额外根可读写，界外仍拦", () => {
	const extra = path.resolve("pool-test-root", "repo-phone");
	const dirs = poolBoundaryDirs(TASK_DIR, WORK_DIR, [{ path: extra }]);
	assert.deepEqual(dirs, [TASK_DIR, WORK_DIR, extra]);
	assert.equal(pathBlockReason("write", { path: path.join(extra, "app.kt") }, dirs), undefined);
	assert.equal(pathBlockReason("edit", { path: path.join(extra, "build.gradle") }, dirs), undefined);
	const outside = path.resolve("pool-test-root", "other-user", "secret.txt");
	assert.ok(pathBlockReason("write", { path: outside }, dirs), "额外根之外仍必须拦");
});

test("边界目录去重：roots 与 workDir 重合不重复", () => {
	const dirs = poolBoundaryDirs(TASK_DIR, WORK_DIR, [{ path: WORK_DIR }, { path: WORK_DIR }]);
	assert.deepEqual(dirs, [TASK_DIR, WORK_DIR]);
});

test("没有 path 参数 / path 不是字符串：放行，交给内核 schema 校验", () => {
	for (const args of [{}, { file: "REPORT.md" }, { path: 42 }, { path: null }, undefined, null]) {
		assert.equal(pathBlockReason("read", args, DIRS), undefined, `args=${JSON.stringify(args)} 不该在这里被拦`);
	}
});

test("两目录都算边界：工作目录内的写入放行", () => {
	assert.equal(
		pathBlockReason("write", { path: path.join(WORK_DIR, "ts", "apps", "server", "src", "pool", "pool-main.ts") }, DIRS),
		undefined,
	);
	assert.equal(pathBlockReason("edit", { path: "src/index.ts" }, [WORK_DIR]), undefined);
});

test("path 正好等于目录本身：拦（不能把目录当文件读写）", () => {
	assert.ok(pathBlockReason("read", { path: TASK_DIR }, DIRS));
	assert.ok(pathBlockReason("write", { path: WORK_DIR }, DIRS));
});

test("空目录列表：一律拦（没有允许的落点就没有界内）", () => {
	assert.ok(pathBlockReason("read", { path: path.join(TASK_DIR, "REPORT.md") }, []));
	assert.ok(pathBlockReason("read", { path: "REPORT.md" }, []));
});

test("同名前缀的兄弟目录不算界内（防有人改成 startsWith 字符串比较）", () => {
	// 判据必须是 path.relative 的**分段**比较。若哪天有人"优化"成
	// `candidate.startsWith(dir)`，`p2-pool-skeleton-sibling\` 会以 `p2-pool-skeleton`
	// 为前缀被误判成界内——那才是真越界。这条钉住它不是那样的。
	const sibling = `${TASK_DIR}-sibling${path.sep}secret.env`;
	const reason = pathBlockReason("read", { path: sibling }, [TASK_DIR]);
	assert.ok(reason, "兄弟目录不能被算进任务目录内");
	assert.ok(reason.includes(sibling));
});

test("任务目录往上跳但落回工作目录：放行（两个目录都是边界）", () => {
	const insideWorkViaTask = path.join(TASK_DIR, "..", "..", "repo", "ts", "x.ts");
	assert.equal(path.resolve(insideWorkViaTask), path.join(WORK_DIR, "ts", "x.ts"));
	assert.equal(pathBlockReason("write", { path: insideWorkViaTask }, DIRS), undefined);
});

test("currentDirs 每票现取：换票后旧票目录立刻不再放行（走真实 beforeTool）", () => {
	// registry 是进程级单例、池跨票串行复用：边界若被闭包成快照，第二票会继续用第一票的
	// 目录（能写上一票的 worktree）。因此不只断言 getter 语义，而是从 registry 快照里取出
	// 真的 beforeTool 调——否则"buildPoolRegistry 里提前调一次 currentDirs()"这种回退照样能过。
	// 这不需要 Harness / 模型：registry 是纯内存结构，钩子是纯函数（读 getter、看 call）。
	let dirs: readonly string[] = [TASK_DIR, WORK_DIR];
	const deps: PoolToolDeps = {
		currentDirs: () => dirs,
		bashTimeoutSeconds: 0,
		submitEscalation: () => ({ ok: true }),
	};
	const beforeTool = beforeToolOf(deps);
	const read = (target: string): ToolHookCall => ({
		type: "toolCall",
		id: "call-1",
		name: "read",
		arguments: { path: target },
	});

	// 第一票：本票 taskDir 内放行
	assert.equal(beforeTool(read(path.join(TASK_DIR, "a.md"))), undefined);

	// 换第二票：边界换成另一个目录（workDir 不变，第一个目录换掉）
	const OTHER = path.resolve("pool-test-root", "other-ticket");
	dirs = [OTHER, WORK_DIR];
	const blocked = beforeTool(read(path.join(TASK_DIR, "a.md")));
	assert.ok(blocked?.block?.startsWith("路径不在任务目录或工作目录内："), "换票后旧票 taskDir 必须被拦");
	assert.equal(beforeTool(read(path.join(OTHER, "a.md"))), undefined, "第二票自己的目录应放行");

	// 空闲（没有当前票）：getter 返回空数组 → 一律拦，正好是"空闲时不该有工具调用"
	dirs = [];
	assert.ok(beforeTool(read("REPORT.md"))?.block, "空闲时路径工具必须全拦");
});

/** 从真实 registry 快照里取出 `beforeTool`（`pool-tools.ts` 里 `hook(ToolTask, …)` 注册的那条）。 */
function beforeToolOf(deps: PoolToolDeps): (call: ToolHookCall) => { block?: string } | undefined {
	const extension = buildPoolRegistry(deps).snapshot().extension("lifediary-worker-pool");
	assert.ok(extension, "registry 里缺 lifediary-worker-pool 扩展");
	const registration = extension.hooks?.find((entry) => entry.task === ToolTask.definition.name);
	assert.ok(registration, "pi.tool 上缺钩子注册");
	const handlers = registration.handlers as {
		beforeTool?: (call: ToolHookCall) => { block?: string } | undefined;
	};
	assert.ok(handlers.beforeTool, "钩子上缺 beforeTool");
	return handlers.beforeTool;
}

test("poolToolCatalog：五件与 POOL_TOOL_NAMES 同序，escalate 描述可读", () => {
	const catalog = poolToolCatalog();
	assert.deepEqual(
		catalog.map((tool) => tool.name),
		[...POOL_TOOL_NAMES],
	);
	const escalate = catalog.find((tool) => tool.name === "escalate");
	assert.ok(escalate, "目录缺 escalate");
	assert.match(escalate?.description ?? "", /上报/);
});
