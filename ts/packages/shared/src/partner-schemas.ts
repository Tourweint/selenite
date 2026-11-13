/**
 * 伙伴与例行任务（人设 / 触发 / 运行记录 / 文件树）
 *
 * 2026-11-13 从 packages/shared/src/index.ts（契约单文件）按行区间 L1192–L1335 整段切出；正文原文搬运，未改一行。
 * index.ts 变成纯桶，继续对外提供同样的符号；环由构建期依赖图检查保证为无环。
 */
import { z } from "zod";
import { PartnerStatusSchema } from "./group-schemas.ts";
import { PartnerAvatarSchema } from "./avatar-png.ts";

export const ModelChainItemSchema = z.object({
	providerId: z.string(),
	modelId: z.string(),
	keyEnv: z.string(),
	thinkingLevel: z.enum(["off", "low", "medium", "high"]).optional(),
});

export type ModelChainItem = z.infer<typeof ModelChainItemSchema>;

export const PartnerProfileSchema = z.object({
	id: z.string().uuid(),
	name: z.string(),
	status: PartnerStatusSchema,
	/** 当前生效的身份快照版本号；改 SOUL 下一轮生效（版本化在服务端） */
	soulVersion: z.number().nullable(),
	createdAt: z.string(),
	updatedAt: z.string(),
	/**
	 * 手下伙伴的唯一领域名（批次D D2，纯增量可选字段）：小写 ASCII，
	 * 正则同 chancellor `DOMAIN_PATTERN`。普通伙伴 / 老客户端不带这个字段。
	 * App 零改动：认不出的客户端按「忽略未知字段」处理即可。
	 */
	domain: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
	/**
	 * 头像（2026-11-06 侧栏调整 B1，纯增量）：`null` = 未设置（前端回落名字首字）。
	 * 只在 `GET /api/v1/partners/:id` 的投影里出现；旧客户端忽略未知字段即可。
	 */
	avatar: PartnerAvatarSchema.nullable(),
	/**
	 * 口头禅（2026-11-12 手机对话身份方案 §四，纯增量可选）：≤40 字（按 Unicode code point，
	 * trim 后判）。`null` = 未设置（前端回落默认句）。列表与详情投影都带；不版本化，现取现用。
	 * 旧客户端忽略未知字段即可。
	 */
	tagline: z.string().nullable().optional(),
	/**
	 * 日记执事（2026-11-12 日记 v2，纯增量可选）：true = 这个执事负责「和小记聊天」那条日记线。
	 * 全局至多一个；PATCH 置 true 时服务端把其他执事的 diary 清掉。列表与详情投影都带。
	 * 旧客户端忽略未知字段即可。
	 */
	diary: z.boolean().optional(),
	/**
	 * 派发权（2026-11-06 执事派发权开关，纯增量可选）：带 domain 的执事是否作为
	 * 分管负责人接单。默认关；投影只对带 domain 的执事给，普通执事不带。
	 * 旧客户端按「忽略未知字段」处理即可。
	 */
	dispatchAuthority: z.boolean().optional(),
});

export type PartnerProfile = z.infer<typeof PartnerProfileSchema>;

export const RoutineTriggerSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("cron"), expr: z.string() }),
	z.object({ type: z.literal("interval"), seconds: z.number() }),
	z.object({ type: z.literal("once"), at: z.string() }),
	z.object({
		type: z.literal("event"),
		kind: z.enum(["delegation", "tool", "phase"]),
		match: z.record(z.string()).optional(),
	}),
]);

export type RoutineTrigger = z.infer<typeof RoutineTriggerSchema>;

export const RoutineDefSchema = z.object({
	id: z.string().uuid(),
	partnerId: z.string().uuid(),
	name: z.string(),
	prompt: z.string(),
	triggers: z.array(RoutineTriggerSchema).min(1),
	/** persistent=复用主会话（保上下文）；fresh=每次全新专线（防污染） */
	sessionMode: z.enum(["persistent", "fresh"]),
	enabled: z.boolean(),
	/** 每次修改 +1：在飞的 durable 任务醒来对不上号就作废 */
	revision: z.number(),
	createdAt: z.string(),
	updatedAt: z.string(),
});

export type RoutineDef = z.infer<typeof RoutineDefSchema>;

export const RoutineRunStatusSchema = z.enum([
	"running",
	"success",
	"failed",
	"interrupted",
	"skipped",
]);

export type RoutineRunStatus = z.infer<typeof RoutineRunStatusSchema>;

export const RoutineRunRecordSchema = z.object({
	id: z.string(),
	routineId: z.string(),
	partnerId: z.string(),
	status: RoutineRunStatusSchema,
	trigger: z.string(),
	startedAt: z.string(),
	endedAt: z.string().optional(),
	summary: z.string().optional(),
	error: z.string().optional(),
});

export type RoutineRunRecord = z.infer<typeof RoutineRunRecordSchema>;

export const OpenExplorerRequestSchema = z.object({
	projectId: z.string().min(1).optional(),
});

export type OpenExplorerRequest = z.infer<typeof OpenExplorerRequestSchema>;

export const FileEntrySchema = z.object({
	name: z.string(),
	type: z.enum(["file", "dir"]),
	/** 字节数；目录恒为 0 */
	size: z.number(),
	/** ISO 时间 */
	updatedAt: z.string(),
});

export type FileEntry = z.infer<typeof FileEntrySchema>;

export const FileListResponseSchema = z.object({
	ok: z.literal(true),
	/** 归一后的相对路径（"" = 工作区根） */
	path: z.string(),
	entries: z.array(FileEntrySchema),
});

export type FileListResponse = z.infer<typeof FileListResponseSchema>;

export const FileContentResponseSchema = z.object({
	ok: z.literal(true),
	path: z.string(),
	size: z.number(),
	truncated: z.boolean(),
	content: z.string().nullable(),
});

export type FileContentResponse = z.infer<typeof FileContentResponseSchema>;


