/**
 * 链路冒烟测试：用 App 将要用的同一套解码器跑一遍服务端。
 * 它比 curl 更有意义 —— 验证的是"两端共用契约"这件事本身有没有对齐。
 *
 *   pnpm smoke   （需先 pnpm dev 起服务）
 */
import {
  createSseDecoder,
  type ChatEvent,
  type ChatRequest,
} from "@lifediary/shared";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:39847";
/** 配了 AGENT_TOKEN 的服务端，冒烟也要带令牌 */
const authHeaders: Record<string, string> = process.env.AGENT_TOKEN?.trim()
	? { Authorization: `Bearer ${process.env.AGENT_TOKEN.trim()}` }
	: {};

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

async function chat(payload: ChatRequest): Promise<{
  events: ChatEvent[];
  text: string;
  elapsedMs: number;
  conversationId: string;
}> {
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}/api/v1/agent/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    fail(`HTTP ${response.status}: ${await response.text()}`);
  }
  if (!response.body) fail("响应没有 body");

  const frameDecoder = createSseDecoder();
  const textDecoder = new TextDecoder();
  const events: ChatEvent[] = [];
  let text = "";

  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    for (const event of frameDecoder.push(textDecoder.decode(chunk, { stream: true }))) {
      events.push(event);
      if (event.type === "delta") text += event.text;
    }
  }

  const startEvent = events.find((event) => event.type === "start");
  return {
    events,
    text,
    elapsedMs: Date.now() - startedAt,
    conversationId: startEvent?.type === "start" ? startEvent.conversationId : "",
  };
}

async function main() {
  const health = await fetch(`${baseUrl}/healthz`)
    .then((r) => r.json())
    .catch(() => fail(`连不上 ${baseUrl}，先跑 pnpm dev`));
  const llmMode = (health as { llm: string }).llm;
  const persisted = llmMode === "upstream";
  console.log(`· 服务在线，模式=${llmMode}`);

  const { events, text, elapsedMs, conversationId } = await chat({
    messages: [{ role: "user", content: "你好，测试一下链路" }],
  });

  const starts = events.filter((e) => e.type === "start");
  const deltas = events.filter((e) => e.type === "delta");
  const dones = events.filter((e) => e.type === "done");
  const errors = events.filter((e) => e.type === "error");

  if (starts.length !== 1) fail(`start 事件应有 1 个，实际 ${starts.length}`);
  if (deltas.length === 0) fail("没有收到任何 delta");
  if (errors.length > 0) {
    fail(`收到 ${errors.length} 个 error 事件：${JSON.stringify(errors[0])}`);
  }
  if (dones[0]?.type !== "done" || dones[0].finishReason !== "stop") {
    fail(`结束事件异常：${JSON.stringify(dones[0])}`);
  }
  if (!text.trim()) fail("拼出来的正文是空的");

  console.log(
    `✓ start → ${deltas.length} deltas → done(stop) · ${elapsedMs}ms · ${text.length} 字`,
  );
  console.log(`  正文: ${text.slice(0, 80)}${text.length > 80 ? "…" : ""}`);

  // 会话归属：id 只能由服务端发出去
  if (!conversationId) fail("start 事件没有返回 conversationId");
  console.log(`✓ 服务端下发会话 id：${conversationId.slice(0, 8)}…`);

  const second = await chat({
    conversationId,
    messages: [{ role: "user", content: "还记得我刚才说什么吗" }],
  });
  if (!second.text.trim()) fail("带着会话 id 续话没有返回正文");
  if (second.conversationId !== conversationId) fail("续话时会话 id 变了");
  console.log(`✓ 带着会话 id 续话成功（${second.text.length} 字）`);

  if (persisted) {
    const bogus = await fetch(`${baseUrl}/api/v1/agent/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({
        conversationId: "made-up-id",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    if (bogus.status !== 404) fail(`编造的会话 id 应返回 404，实际 ${bogus.status}`);
    console.log("✓ 编造的会话 id 被拒绝（404）");
  } else {
    console.log("· mock 模式不落盘会话，跳过 id 校验用例");
  }

  // 校验 400 分支：空 messages 必须被契约挡在门外。
  const bad = await fetch(`${baseUrl}/api/v1/agent/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ messages: [] }),
  });
  if (bad.status !== 400) fail(`空 messages 应返回 400，实际 ${bad.status}`);
  console.log("✓ 契约校验生效（空 messages → 400）");
}

await main();
