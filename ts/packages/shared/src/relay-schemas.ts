/**
 * 中继与派活帧（hello / 设备 / 调用 / 结果 / 阶段）
 *
 * 2026-11-13 从 packages/shared/src/index.ts（契约单文件）按行区间 L681–L990 整段切出；正文原文搬运，未改一行。
 * index.ts 变成纯桶，继续对外提供同样的符号；环由构建期依赖图检查保证为无环。
 */
import { z } from "zod";

export const RELAY_PROTOCOL_VERSION = 1;

export const RELAY_MAX_FRAME_BYTES = 2 * 1024 * 1024;

export const RelayErrorCodeSchema = z.enum([
	"bad_request",
	"unauthorized",
	"version_mismatch",
	"unknown_device",
	"device_offline",
	"payload_too_large",
	"timeout",
	"channel_not_allowed",
	"remote_disabled",
	"internal",
]);

export type RelayErrorCode = z.infer<typeof RelayErrorCodeSchema>;

export const RelayHelloSchema = z.object({
	kind: z.literal("hello"),
	v: z.literal(1),
	token: z.string().min(1).max(128),
	deviceName: z.string().min(1).max(40),
	platform: z.string().min(1).max(20),
	version: z.string().max(20).optional(),
	capabilities: z.array(z.string().min(1).max(40)).max(16).default([]),
});

export type RelayHello = z.infer<typeof RelayHelloSchema>;

export const RelayDeviceViewSchema = z.object({
	id: z.string().min(1),
	name: z.string(),
	platform: z.string(),
	online: z.boolean(),
	lastSeenAt: z.number().optional(),
	capabilities: z.array(z.string()).default([]),
	/**
	 * 主机位（2026-11-05 主机优先制）：中继名册里同一时刻只有一台 `isHome=true`。
	 * 只读投影；设/清走 `POST /api/relay/home-device`（owner 或设备令牌）。
	 */
	isHome: z.boolean().optional(),
	/**
	 * 设备描述（≤200 字，如"存储机"/"计算用"）。
	 * **只给人看**：名册/overview/delegate 回话里供人点名参考，
	 * 自动挑机决策器（`relay-auto.ts`）**不读这个字段**（产品口径：描述不参与挑选）。
	 */
	description: z.string().max(200).optional(),
});

export type RelayDeviceView = z.infer<typeof RelayDeviceViewSchema>;

export const RelayWelcomeSchema = z.object({
	kind: z.literal("welcome"),
	deviceId: z.string().min(1),
	devices: z.array(RelayDeviceViewSchema),
});

export type RelayWelcome = z.infer<typeof RelayWelcomeSchema>;

export const RelayDeliverSchema = z.object({
	kind: z.literal("deliver"),
	id: z.string().min(1).max(64),
	dst: z.string().min(1).max(64),
	channel: z.string().min(1).max(80),
	payload: z.unknown(),
});

export type RelayDeliver = z.infer<typeof RelayDeliverSchema>;

export const RelayRoutedSchema = z.object({
	kind: z.literal("routed"),
	id: z.string().min(1).max(64),
	src: z.string().min(1).max(64),
	channel: z.string().min(1).max(80),
	payload: z.unknown(),
});

export type RelayRouted = z.infer<typeof RelayRoutedSchema>;

export const RelayResultSchema = z.object({
	kind: z.literal("result"),
	id: z.string().min(1).max(64),
	dst: z.string().min(1).max(64),
	ok: z.boolean(),
	result: z.unknown().optional(),
	error: z
		.object({ code: RelayErrorCodeSchema, message: z.string().max(300) })
		.optional(),
});

export type RelayResult = z.infer<typeof RelayResultSchema>;

export const RelayErrorFrameSchema = z.object({
	kind: z.literal("error"),
	id: z.string().max(64).optional(),
	code: RelayErrorCodeSchema,
	message: z.string().max(300),
});

export type RelayErrorFrame = z.infer<typeof RelayErrorFrameSchema>;

export const RelayPingSchema = z.object({ kind: z.literal("ping"), at: z.number() });

export const RelayPongSchema = z.object({ kind: z.literal("pong"), at: z.number() });

export const RelayInvokePayloadSchema = z
	.object({
		/** 大写 HTTP 方法（GET/POST/…），中继按原样投递 */
		method: z.string().min(1).max(16),
		/** 完整服务端路径（含 `/api/v1` 前缀），不含查询串 */
		path: z.string().min(1).max(2048),
		/** 含前导 `?` 的查询串；没有查询串为空串 */
		query: z.string().max(2048),
		/** 只带手机原始请求的 authorization（中继不替换，也不存 harness 令牌） */
		headers: z.record(z.string()),
		/** 请求正文原文；没有正文 = null */
		body: z.string().nullable(),
	})
	.strict();

export type RelayInvokePayload = z.infer<typeof RelayInvokePayloadSchema>;

export const RelayInvokeFrameSchema = z
	.object({
		kind: z.literal("invoke"),
		id: z.string().min(1).max(64),
		payload: RelayInvokePayloadSchema,
	})
	.strict();

export type RelayInvokeFrame = z.infer<typeof RelayInvokeFrameSchema>;

export const RelayInvokeResultFrameSchema = z
	.object({
		kind: z.literal("invoke_result"),
		id: z.string().min(1).max(64),
		payload: z
			.object({
				status: z.number().int().min(100).max(599),
				body: z.string(),
			})
			.strict(),
	})
	.strict();

export type RelayInvokeResultFrame = z.infer<typeof RelayInvokeResultFrameSchema>;

export const RelayPresenceFrameSchema = z
	.object({
		kind: z.literal("presence"),
		devices: z.array(RelayDeviceViewSchema),
	})
	.strict();

export type RelayPresenceFrame = z.infer<typeof RelayPresenceFrameSchema>;

export const RelayJoinRequestSchema = z.object({
	joinCode: z.string().min(1).max(128),
	deviceName: z.string().min(1).max(40),
	platform: z.string().max(20).optional(),
});

export type RelayJoinRequest = z.infer<typeof RelayJoinRequestSchema>;

export const RelayJoinResponseSchema = z.object({
	deviceId: z.string().min(1),
	deviceToken: z.string().min(1),
	protocolVersion: z.number().int(),
});

export type RelayJoinResponse = z.infer<typeof RelayJoinResponseSchema>;

export const RELAY_PUSH_CHANNEL_PREFIX = "push/";

export const DelegationPhaseSchema = z.enum([
	"accepted",
	"planning",
	"running",
	"reviewing",
	"done",
	"needs_you",
	"failed",
	"aborted",
]);

export type DelegationPhase = z.infer<typeof DelegationPhaseSchema>;

export const RemoteDelegationAcceptSchema = z.object({
	requestId: z.string().min(8).max(64),
	prompt: z.string().min(1).max(20_000),
	project: z.string().max(120).optional(),
	domain: z.string().max(60).optional(),
	originDeviceId: z.string().min(1).max(64),
	createdAt: z.number(),
});

export type RemoteDelegationAccept = z.infer<typeof RemoteDelegationAcceptSchema>;

export const RemoteDelegationStatusSchema = z.object({
	requestId: z.string(),
	ticketId: z.string(),
	phase: DelegationPhaseSchema,
	report: z.string().max(4000).optional(),
	updatedAt: z.number(),
});

export type RemoteDelegationStatus = z.infer<typeof RemoteDelegationStatusSchema>;

export const RelayMetaActionSchema = z.enum([
	"actors",
	"actor-home",
	"actor-claim",
	"actor-release",
	"devices",
	"set-home",
	"set-description",
]);

export type RelayMetaAction = z.infer<typeof RelayMetaActionSchema>;

export const RelayMetaRequestSchema = z.object({
	kind: z.literal("meta"),
	id: z.string().min(1).max(64),
	action: RelayMetaActionSchema,
	payload: z.unknown(),
});

export type RelayMetaRequest = z.infer<typeof RelayMetaRequestSchema>;

export interface RelayActorMeta {
	actorId: string;
	name: string;
	homeDeviceId: string | null;
	updatedAt: number;
}

export const RelayActorClaimResultSchema = z.discriminatedUnion("ok", [
	z.object({
		ok: z.literal(true),
		actorId: z.string(),
		name: z.string(),
		homeDeviceId: z.string(),
	}),
	z.object({
		ok: z.literal(false),
		code: z.literal("home_conflict"),
		actorId: z.string(),
		/** 当前实际主机（调用方据此重读重判，绝不盲抢） */
		homeDeviceId: z.string().nullable(),
	}),
]);

export type RelayActorClaimResult = z.infer<typeof RelayActorClaimResultSchema>;

export const PARTNER_AVATAR_MAX_CHARS = 180_000;

export const PARTNER_AVATAR_MAX_BYTES = 128 * 1024;

export const PARTNER_AVATAR_MAX_DIMENSION = 256;

export const PARTNER_AVATAR_PREFIX = "data:image/png;base64,";

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export { B64_ALPHABET };
