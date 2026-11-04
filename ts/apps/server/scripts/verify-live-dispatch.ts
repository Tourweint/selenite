// 真机端到端探针：起 harness（8199），用 delegate 派一单给**真手机 worker**。
// 跟 `pnpm --filter @lifediary/server phone` 的区别：那个用假手机客户端验协议，
// 这个要一台真机在跑 lifediary worker，验的是整条链。
// 用法：DASHSCOPE_API_KEY=... pnpm --filter @lifediary/server exec tsx scripts/verify-live-dispatch.ts "<requirement>"
import { join } from "node:path";

const PORT = 8199;
const TOKEN = "verify-token";
const DIR = join(import.meta.dirname, "..");

const apiKey = (process.env.DASHSCOPE_API_KEY ?? process.env.LLM_API_KEY ?? "").trim();
if (!apiKey) {
  console.error("缺少 DASHSCOPE_API_KEY / LLM_API_KEY");
  process.exit(1);
}

process.chdir(DIR);
process.env.PORT = String(PORT);
process.env.AGENT_TOKEN = TOKEN;
process.env.LLM_PROVIDER = "";
process.env.LLM_API_KEY = apiKey;
process.env.LLM_MODEL = process.env.LLM_MODEL?.trim() || "deepseek-v4.1-flash";
process.env.LLM_BASE_URL =
  process.env.LLM_BASE_URL?.trim() || "https://dashscope.aliyuncs.com/compatible-mode/v1";
process.env.AGENT_DB_PATH = join(DIR, ".data/verify-live-agent.sqlite");
process.env.MEMORY_DB_PATH = join(DIR, ".data/verify-live-memory.db");
process.env.CHANCELLOR_ENABLED = "true";
process.env.CHANCELLOR_EMPLOYEE = "phone";
process.env.CHANCELLOR_PHONE_TASK_BUDGET_MS = "180000";
// 手机操作没有磁盘落点，这个探针也不铺工作区；项目前置由 src/projects.test.ts 覆盖。
process.env.DELEGATION_PROJECT_REQUIRED = "false";

await import("../src/index.ts");
const { createTools } = await import("../src/tools.ts");

const requirement =
  process.argv[2]?.trim() ||
  "打开 Edge 浏览器（包名 com.microsoft.emmx），在页面上的搜索框（提示文字为「搜索或键入 URL」）里用 set_text 写入 lifediary，不要按回车、不要提交搜索；然后 read_screen 确认输入框里是 lifediary。完成标准：读屏结果里能读到 lifediary。不要打开其他 App，不要修改任何设置。";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
for (let i = 0; i < 80; i += 1) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/healthz`);
    if (r.ok) break;
  } catch {
    /* not up */
  }
  await sleep(250);
}
console.log(`harness up on ${PORT}, dispatching...`);

const delegate = createTools({
  memory: null,
  scopeOf: (id) => ({ type: "session", id: String(id) }) as never,
}).find((tool) => tool.name === "delegate");
if (!delegate) throw new Error("delegate not found");

const started = Date.now();
const result = await delegate.execute(
  { requirement } as never,
  { conversationId: 9001 } as never,
  {} as never,
);
const text = (result.output ?? [])
  .map((item) => (item.type === "text" ? item.text : ""))
  .join("");
console.log(`\n=== delegate finished in ${Date.now() - started}ms ===`);
console.log(text);
