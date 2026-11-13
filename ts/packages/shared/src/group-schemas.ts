/**
 * 群组与伙伴状态（成员 / 轮次 / 群元信息 / 群请求）
 *
 * 2026-11-13 从 packages/shared/src/index.ts（契约单文件）按行区间 L331–L435 整段切出；正文原文搬运，未改一行。
 * index.ts 变成纯桶，继续对外提供同样的符号；环由构建期依赖图检查保证为无环。
 */
import { z } from "zod";

export interface GroupSender {
	kind: "partner" | "user";
	/** kind=partner 时是执事 uuid */
	id?: string;
	/** 展示名（快照）；user 固定「主人」 */
	name?: string;
}

export const GroupResponderKindSchema = z.enum(["member", "everyone", "mentions"]);

export type GroupResponderKind = z.infer<typeof GroupResponderKindSchema>;

export const GROUP_MEMBER_MIN = 2;

export const GROUP_MEMBER_MAX = 6;

export const GROUP_MESSAGE_LIMIT = 8000;

export const PartnerStatusSchema = z.enum(["active", "paused", "archived"]);

export type PartnerStatus = z.infer<typeof PartnerStatusSchema>;

export const GroupMemberSchema = z.object({
	partnerId: z.string(),
	/** 成员表只存展示名快照，不复制人格（lobehub 教训）；人格 = 各自 SOUL */
	name: z.string(),
	position: z.number().int().min(0),
	/** 档案实时状态；2026-11-08 前服务端已透出，2026-11-10 从裸 string 收紧为本文件同一枚举 */
	status: PartnerStatusSchema.optional(),
	/**
	 * 复合头像（2026-11-08 批三）：档案 avatar 槽的 data URL，或 null（前端用名字首字）。
	 * 群列表行 / 会话头用 2×2 网格拼，≤4 人直出，多人右下角 +N。
	 */
	avatar: z.string().nullable().optional(),
	/** 执事域（2026-11-08 批三）：`@名字·domain` 唯一长标签消歧用；无 domain = null */
	domain: z.string().nullable().optional(),
});

export type GroupMember = z.infer<typeof GroupMemberSchema>;

export const GroupRoundSchema = z.object({
	running: z.boolean(),
	speaker: z
		.object({ partnerId: z.string(), name: z.string() })
		.nullable(),
});

export type GroupRound = z.infer<typeof GroupRoundSchema>;

export const GroupMetaSchema = z.object({
	id: z.string(),
	name: z.string(),
	/** 群公告（≤500 字），随每轮输入注入成员会话 */
	notice: z.string(),
	responderKind: GroupResponderKindSchema,
	/** kind=member 时的值日执事；必须是群成员 */
	responderPartnerId: z.string().nullable(),
	members: z.array(GroupMemberSchema),
	/** 轮次状态（2026-11-08 批三，纯增量） */
	round: GroupRoundSchema.optional(),
	createdAt: z.string(),
	updatedAt: z.string(),
});

export type GroupMeta = z.infer<typeof GroupMetaSchema>;

export const GroupMessageSchema = z.object({
	id: z.string(),
	groupId: z.string(),
	/** 群内单调序号（从 1 起），回读分页用 beforeSeq */
	seq: z.number().int().min(1),
	kind: z.enum(["message", "system"]),
	authorKind: z.enum(["user", "partner", "system"]),
	authorId: z.string().nullable(),
	/** 作者名快照：不 join 成员表，改名/离群后历史不变 */
	authorName: z.string(),
	content: z.string(),
	at: z.string(),
	/** 同一回合同名（用于将来合并/追溯），v1 落 uuid */
	roundId: z.string(),
});

export type GroupMessage = z.infer<typeof GroupMessageSchema>;

export const GroupChatRequestSchema = z.object({
	text: z.string().min(1).max(GROUP_MESSAGE_LIMIT),
});

export type GroupChatRequest = z.infer<typeof GroupChatRequestSchema>;

export const FinishReasonSchema = z.enum(["stop", "length", "aborted", "error"]);

export type FinishReason = z.infer<typeof FinishReasonSchema>;

export interface TurnUsage {
	input: number;
	output: number;
	/** 缓存命中（只读，不另收"写缓存"的账） */
	cacheRead: number;
}


