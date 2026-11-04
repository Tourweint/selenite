import { RELAY_PROTOCOL_VERSION } from "@lifediary/shared";
import { createRelayServer } from "./server.ts";
import { STORE_PATH } from "./store.ts";

/**
 * 中继节点入口（2026-11-05 多端同步方案块0）。
 *
 * 环境变量（详见 接口文档.md 中继章节）：
 * - RELAY_PORT          监听端口（默认 8084）
 * - RELAY_STORE_PATH    名册落点（默认 .data/relay-state.json）
 * - RELAY_OWNER_TOKEN   管理员令牌（空 = 仅 loopback 可签发加入码/撤销设备）
 * - RELAY_CODE_TTL_SECONDS / RELAY_MAX_DEVICES  配对码与设备上限
 *
 * 日志纪律：只记设备 id / 平台 / 通道名 / 计数，channel payload 不进日志。
 */

const port = Number(process.env.RELAY_PORT ?? 8084);
const relay = createRelayServer();

relay.server.listen(port, () => {
	console.log(`[relay] listening on :${port} protocol=v${RELAY_PROTOCOL_VERSION}`);
	console.log(`[relay] store=${STORE_PATH} ownerToken=${relay.store.ownerToken ? "configured" : "loopback-only"}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		relay.hub.stop();
		relay.server.close();
		process.exit(0);
	});
}
