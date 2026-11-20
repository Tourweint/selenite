/**
 * partner-runtime-run-partner-turn
 *
 * 2026-11-14 从 partner-runtime.ts 的 L36–L416 整段切出；正文原文搬运，未改一行实现。
 * 内含：CTX / partnerCanonicalExternalId / renderPartnerIdentity / partnerSkillsIndex …
 */

import type { ResolvedChat } from "./agent.ts";
import { chatStream, openOrCreateChat } from "./agent.ts";
import { sayInConversation } from "./agent/lifecycle.ts";
import { sessionCwd } from "./agent/shared.ts";
import { markAutonomyTurn, unmarkAutonomyTurn } from "./autonomy-state.ts";
import { nextChainCandidate } from "./model-chain.ts";
import type { PartnerRow, PartnersStore } from "./partners.ts";
import { COMPANIONS_ENABLED, partnersStore } from "./partners.ts";
import { sideSessionsEnabled } from "./partner-session-role.ts";
import { flagEnabled } from "./flags.ts";
import { projectsStore } from "./projects.ts";
import { personaRefreshNeeded, personaSignature, renderPersonaFieldBlocks } from "./partner-persona.ts";
import { ROUTINE_QUIET_INSTRUCTION, assessRoutineOutputGuarded, routineQuietEnabled } from "./routine-quiet.ts";
import { SCHEDULED_RUN_HEADER } from "./scheduled-run-context.ts";
import { clearTurnToolErrors, clearUnattendedSkips, markRoutineTurn, takeTurnToolErrors, takeUnattendedSkips, unmarkRoutineTurn } from "./unattended.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SettledSubmissionRecord } from "@earendil-works/pi-durable";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const CTX = BACKGROUND_CONTEXT;

export function partnerCanonicalExternalId(partnerId: string): string {
	return `partner-${partnerId}`;
}

/** 副会话对外 id（2026-11-17 一人多会话）：token 由调用方给（8 位小写 hex）。 */
export function partnerSideExternalId(partnerId: string, token: string): string {
	return `partner-${partnerId}-side-${token}`;
}

export interface PartnerIdentityPart {
	key:
		| "partner_soul"
		| "partner_voice"
		| "partner_values"
		| "partner_scenario"
		| "partner_skill_index"
		| "partner_boundary";
	title: string;
	text: string;
}

/**
 * 身份的可展示字段（2026-11-16 追加）：默认上下文页不再把 SOUL、说话方式、
 * 里子、处境、技能索引、运行边界合成一个 `partner_identity` 大块。
 * 这里同时产出空字段（text=""），页面才能逐个显示 0 字槽位。
 *
 * 2026-11-19「关于我」：`partner_owner_profile`（memories/USER.md）不再进身份——
 * 主人档案改为全局一份的 `user_profile` system 段；文件保留不删，只是不再注入。
 *
 * 真实 instructions 仍走 renderPartnerIdentity：只拼非空段，顺序不变。
 */
export function renderPartnerIdentityParts(
	partner: PartnerRow,
	soulSource: string,
): PartnerIdentityPart[] {
	const store = partnersStore();
	const parts: PartnerIdentityPart[] = [
		{ key: "partner_soul", title: "执事身份 · SOUL", text: soulSource.trim() },
	];
	for (const block of renderPersonaFieldBlocks(store, partner)) {
		parts.push({
			key: block.id,
			title: block.title,
			text: block.text,
		});
	}

	// 2026-11-19：主人画像退役（全局「关于我」接管）。`memories/USER.md` 文件与
	// `readUserMd()` 保留兼容，但不再进身份 instructions——同一个概念不能有两处真相。

	const skills = partnerSkillsIndex(partner.id);
	parts.push({
		key: "partner_skill_index",
		title: "执事身份 · 技能索引",
		text: skills ?? "",
	});

	parts.push({
		key: "partner_boundary",
		title: "执事身份 · 运行边界",
		text: [
			"# 运行边界",
			"- 你的记忆与技能独立于主人的助手；写文件默认落在你的 workspace/。",
			"- 需要长期记住的事用 remember（会自动记到你的键空间）；把流程沉淀成技能用 partner_skill_write。",
		].join("\n"),
	});
	return parts;
}

export function renderPartnerIdentity(partner: PartnerRow, soulSource: string): string {
	return renderPartnerIdentityParts(partner, soulSource)
		.map((part) => part.text.trim())
		.filter(Boolean)
		.join("\n\n");
}

function partnerSkillsIndex(partnerId: string): string | undefined {
	const dir = partnersStore().skillsDirOf(partnerId);
	if (!existsSync(dir)) return undefined;
	const names = readdirSync(dir)
		.filter((f) => f.endsWith(".md"))
		.sort();
	if (names.length === 0) return undefined;
	const lines = names.map((file) => {
		const raw = partnersStore().readHomeFile(partnerId, join("skills", file)) ?? "";
		const summary = raw.split("\n", 1)[0]?.trim() || file.replace(/\.md$/, "");
		return `- ${file.replace(/\.md$/, "")}：${summary.slice(0, 72)}`;
	});
	// 2026-11-15 修正：执事会话的 cwd 是当前项目 / 工作区，不是他的家目录，
	// 原来写「直接读 skills/<名>.md」会让模型在工作区里找错地方（同名还会读到内置手册）。
	// 索引里给家目录的绝对路径；read 不设路径边界，能直接取。
	const base = dir.replace(/\\/g, "/").replace(/\/$/, "");
	return [
		`# 技能索引（你自带的技能手册。完整正文直接读这个目录下的文件：${base}/<名>.md）`,
		...lines,
	].join("\n");
}

const sessionOpenings = new Map<string, Promise<ResolvedChat | null>>();

/**
 * 执事会话的默认目录（2026-11-17）：钉在主工作区，不跟随界面里的「当前项目」。
 *
 * 注意语义：这只是**相对路径的默认基准**，不是文件边界。path-guard 的根集合一直是
 * 「主工作区 + 所有非归档项目根」，勾选项目（`projectIds`）只决定记忆能不能召回，
 * 不限制能去哪些目录——两件事故意分开（用户 2026-11-17 拍板）。
 *
 * 缘由：`currentProject` 是全局单值，点一下项目选择就换；执事的例行轮每轮现读它，
 * 一次手滑的「选中项目」就能把 08:30 的问安跑到别的仓库里去（2026-11-17 实测：
 * 注入 student-milk-order → `read("workspace")` 拼成 ...\student-milk-order\workspace）。
 * 会话自己的 `pi.agent.cwd` 优先于全局回落，所以这里配一次就固定住了。
 *
 * 回滚：`PARTNER_CWD_WORKSPACE=false` → 不钉，回到「跟随当前项目 / 主工作区」的旧形态。
 */
function partnerCwdPinEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env.PARTNER_CWD_WORKSPACE ?? "").trim().toLowerCase();
	if (!raw) return true;
	return raw !== "false" && raw !== "0" && raw !== "off";
}

async function pinPartnerWorkspace(chat: ResolvedChat): Promise<void> {
	if (!partnerCwdPinEnabled()) return;
	try {
		const root = projectsStore().getWorkspace()?.rootPath?.trim();
		if (!root) return;
		const agent = await chat.conversation.agent(CTX);
		// 已对齐就不写库：旧会话被项目污染（或从没配过）才配置一次
		if (agent.cwd === root) return;
		await chat.conversation.configure({ cwd: root }, CTX);
	} catch (error) {
		// 配不上不该让这一轮跑不起来：退回旧的 cwd 回落（只记 warn）
		console.warn(
			`[partner] 工作目录钉不住，按回落处理: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * 例行轮兜底消息（2026-11-17）：工具报错 + 产出为空时，服务端自己补一句
 * 「这轮没跑成、我在哪个目录」。
 *
 * 现场：08:30 那轮 `read` 失败，模型回 `[[no-update]]`；安静契约被压成「非安静」，
 * 但正文是空串——主人那边一片空白，既没招呼也没错误。宁可多说一句，
 * 也不把「读失败」藏起来。
 *
 * 回滚：`ROUTINE_ERROR_NOTE=false`。
 */
function routineErrorNoteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env.ROUTINE_ERROR_NOTE ?? "").trim().toLowerCase();
	if (!raw) return true;
	return raw !== "false" && raw !== "0" && raw !== "off";
}

function routineErrorNote(tools: string[], conversationId: number): string {
	const cwd = sessionCwd(conversationId);
	let workspace = "";
	try {
		workspace = projectsStore().getWorkspace()?.rootPath?.trim() || "";
	} catch {
		workspace = "";
	}
	const where =
		workspace && workspace !== cwd
			? `我现在的工作目录是 ${cwd}，主工作区是 ${workspace}。`
			: `我现在的工作目录是 ${cwd}。`;
	return `这一轮没跑成：${tools.join("、")} 报错了。${where}如果是目录不对，你换回来我就重新试。`;
}

export function ensurePartnerSession(partnerId: string): Promise<ResolvedChat | null> {	const inflight = sessionOpenings.get(partnerId);
	if (inflight) return inflight;
	const opening = openPartnerSession(partnerId).finally(() => {
		sessionOpenings.delete(partnerId);
	});
	sessionOpenings.set(partnerId, opening);
	return opening;
}

/**
 * 身份对齐（2026-11-17 批1 从 openPartnerSession 原样抽出，行为不变）：
 * applied 计数 ≠ 当前计数才 configure（改 SOUL 下一轮生效的记账位）。
 * 人格模块不版本化，另用内容签名判断——改了口吻 / 里子 / 处境（或开关）也要在下一轮
 * 重配 instructions。快照退役后计数只是记账位，SOUL 正文一律读磁盘当前值。
 * canonical 与 side 会话共用同一段逻辑，副会话才会跟着 SOUL / 口吻更新。
 */
async function alignPartnerSession(
	chat: ResolvedChat,
	partner: PartnerRow,
	store: PartnersStore,
): Promise<void> {
	const epoch = partner.currentVersion;
	const applied = store.appliedVersionOf(partner.id, chat.internalId);
	const personaChanged = personaRefreshNeeded(
		chat.internalId,
		personaSignature(store, partner),
	);
	if (epoch != null && (epoch !== applied || personaChanged)) {
		await chat.conversation.configure(
			{ instructions: renderPartnerIdentity(partner, store.readSoulFromHome(partner.id) ?? "") },
			CTX,
		);
		store.setAppliedVersion(partner.id, chat.internalId, epoch);
	}
}

async function openPartnerSession(partnerId: string): Promise<ResolvedChat | null> {
	if (!COMPANIONS_ENABLED) return null;
	const store = partnersStore();
	const partner = store.get(partnerId);
	if (!partner || partner.status !== "active") return null;

	const chat = await openOrCreateChat(partnerCanonicalExternalId(partnerId));
	// 主会话链接：一次登记，之后 scopeOf / partnerOfConversation 靠它识别这条会话归谁
	if (!store.findSessionLink(partnerId, "canonical", "canonical")) {
		store.linkSession({
			partnerId,
			role: "canonical",
			routeKey: "canonical",
			sessionId: chat.internalId,
		});
	}

	// canonical 的身份对齐抽成 alignPartnerSession，副会话复用同一段逻辑（行为不变）。
	await alignPartnerSession(chat, partner, store);
	await pinPartnerWorkspace(chat);
	return chat;
}

/**
 * 新建一条副会话（2026-11-17 批1）：不写消息、不发问候。
 * 开关关 / 执事不存在 / 非 active → null。极端 id 碰撞只换一次 token，不写复杂重试。
 */
export async function createPartnerSideSession(partnerId: string): Promise<ResolvedChat | null> {
	if (!COMPANIONS_ENABLED || !sideSessionsEnabled()) return null;
	const store = partnersStore();
	const partner = store.get(partnerId);
	if (!partner || partner.status !== "active") return null;

	const token = randomUUID().slice(0, 8);
	let externalId = partnerSideExternalId(partnerId, token);
	let chat = await openOrCreateChat(externalId);
	if (store.findSessionLink(partnerId, "side", externalId)) {
		// 极小概率撞到已用过的 id：换一个 token 重来一次（INSERT OR IGNORE 兜住并发）
		const retryToken = randomUUID().slice(0, 8);
		externalId = partnerSideExternalId(partnerId, retryToken);
		chat = await openOrCreateChat(externalId);
	}
	store.linkSession({
		partnerId,
		role: "side",
		routeKey: externalId,
		sessionId: chat.internalId,
	});
	await alignPartnerSession(chat, partner, store);
	await pinPartnerWorkspace(chat);
	return chat;
}

/** /agent/chat 续副会话时调用：重新对齐身份 + 钉工作目录；执事失效 → false。 */
export async function alignPartnerSideSession(chat: ResolvedChat, partnerId: string): Promise<boolean> {
	const store = partnersStore();
	const partner = store.get(partnerId);
	if (!partner || partner.status !== "active") return false;
	await alignPartnerSession(chat, partner, store);
	await pinPartnerWorkspace(chat);
	return true;
}

export interface PartnerTurnOptions {
	/**
	 * 自主身份（cindy teammate-authority 同款口径）：autonomous = 例行任务/事件唤醒的自主轮，
	 * entrusted = 主人显式设的规则。文本头注入是透明性，进程内标记才是 C2 判定的事实源。
	 */
	authority?: "autonomous" | "entrusted";
	/** persistent = 复用主会话（默认）；fresh = 每次全新专线会话（跑完留着，task- 前缀不进列表） */
	sessionMode?: "persistent" | "fresh";
	/**
	 * 安静契约是否适用于这一轮（2026-11-10 批 29）。
	 *
	 * 缺省 = 沿用"只有 autonomous 轮才判安静"的旧口径；显式 `false` = 这轮不适用安静契约
	 * （派活唤醒轮必有内容：接住汇报就是产出）。
	 */
	quiet?: boolean;
}

export interface PartnerTurnResult {
	ok: boolean;
	/** 模型这一轮说的话（聚合 delta；quiet 时已剔除 [[no-update]] 标记） */
	text: string;
	/** 例行轮"没有值得报告的内容"（2026-11-09 T2 安静契约）；调用方据此不写摘要 */
	quiet?: boolean;
	/**
	 * 本轮报过错的工具名（枚举，不含参数与报错正文；2026-11-10 批 21 §三）。
	 * 有它在手时安静判定已被压制（读失败不当"无新"）；空/缺省 = 本轮没有工具报错。
	 */
	toolErrors?: string[];
	/**
	 * 无人值守下被跳过的工具名（枚举，不含参数；2026-11-10 批 13 §二.2）。
	 * 空数组 = 没有跳过任何步骤。
	 */
	skipped?: string[];
	/** 失败原因（执事不存在 / 未启用 / 模型未配置等），大白话给调用方 */
	error?: string;
}

export async function runPartnerTurn(
	partnerId: string,
	text: string,
	opts: PartnerTurnOptions = {},
): Promise<PartnerTurnResult> {
	if (!COMPANIONS_ENABLED) {
		return { ok: false, text: "", error: "执事能力未启用（COMPANIONS_ENABLED=false）" };
	}
	if (!text.trim()) return { ok: false, text: "", error: "跑一轮需要正文" };
	const partner = partnersStore().get(partnerId);
	if (!partner) return { ok: false, text: "", error: "执事不存在" };
	if (partner.status !== "active") {
		return { ok: false, text: "", error: `执事当前是「${partner.status}」，先恢复再跑` };
	}

	const chat =
		opts.sessionMode === "fresh"
			? await ensureFreshPartnerSession(partnerId)
			: await ensurePartnerSession(partnerId);
	if (!chat) return { ok: false, text: "", error: "执事会话取不到（未启用或未配置模型）" };

	const authority = opts.authority ?? "entrusted";
	// 安静契约只对例行轮生效（手动试跑 = 用户主动要，必须给产出）；
	// 唤醒轮显式传 quiet=false（接住汇报就是内容，不闭嘴）。
	const quietEligible = (opts.quiet ?? (authority === "autonomous")) && routineQuietEnabled();
	// 文本头（透明性）：模型知道这一轮是谁发起的；判定事实源在 autonomy-state.ts。
	// 例行轮尾部多一行"没内容就回标记"的出口（固定字节，见 routine-quiet.ts）。
	// 2026-11-17：头常量抽到 scheduled-run-context.ts，回读展示/搜索侧要剥掉同一串字节。
	const body = authority === "autonomous"
		? `${SCHEDULED_RUN_HEADER}

${text}${quietEligible ? `\n\n${ROUTINE_QUIET_INSTRUCTION}` : ""}`
		: text;

	const pieces: string[] = [];
	/** 本轮是否真的产出了模型正文（unanswered 的说明不算，别把错误当"安静"） */
	let sawDelta = false;
	// 无人值守标记（2026-11-10 批 13 §一）：例行轮不必依赖 AUTONOMY_ENABLED——
	// 那个总闸默认关，但例行任务照常跑，判定必须独立成立。
	if (authority === "autonomous") markRoutineTurn(chat.internalId);
		// 每轮开头清一次跳过账与工具报错账：只统计本轮，不把上一轮的残留带进 run 记录。
		clearUnattendedSkips(chat.internalId);
		clearTurnToolErrors(chat.internalId);
	if (authority === "autonomous") markAutonomyTurn(chat.internalId);
	try {
		// 结算记录拿来看 unanswered 的 reason（候选链要不要切就看它）
		const settled: { record: SettledSubmissionRecord | null } = { record: null };
		const runOnce = async (): Promise<void> => {
			for await (const event of chatStream({
				conversation: chat.conversation,
				text: body,
				requestId: randomUUID(),
				onSettled: (record) => {
					settled.record = record;
				},
			})) {
				if (event.type === "delta") {
					pieces.push(event.text);
					sawDelta = true;
				} else if (event.type === "unanswered") pieces.push(event.message);
			}
		};
		await runOnce();

		// 候选链重试（批次B B4）：上一轮 unanswered 且原因可切 → 按链换路由重跑。
		// 每个候选最多跑一次；fallback 只改本轮，不暗改档案（下一轮仍从链头试）。
		// 2026-11-19：会话级模型切换后，configure 的模型默认会留下来；这里记下本会话原模型，
		// 重试结束后恢复——否则一次兜底失败会把执事的主模型永久改成链里的候选。
		const originalModel = await chat.conversation
			.agent(CTX)
			.then((agent) => agent.model ?? null)
			.catch(() => null);
		try {
			let chain = partnersStore().getModelChain(partnerId);
			while (
				chain.length > 0 &&
				settled.record?.status === "unanswered" &&
				pieces.join("").length === 0
			) {
				const verdict = await stepChain(chat, chain, settled.record.reason ?? "");
				if (!verdict) break;
				// stepChain 已 configure 成新路由：剔除用过的候选，重跑一轮
				chain = chain.filter((item) => item !== verdict);
				pieces.length = 0;
				await runOnce();
			}
		} finally {
			if (originalModel) {
				const current = await chat.conversation
					.agent(CTX)
					.then((agent) => agent.model ?? null)
					.catch(() => null);
				if (
					current?.provider !== originalModel.provider ||
					current?.modelId !== originalModel.modelId
				) {
					await chat.conversation
						.configure({ model: originalModel }, CTX)
						.catch((error: unknown) => {
							console.warn(
								`[model-chain] 恢复本会话原模型失败: ${
									error instanceof Error ? error.message : String(error)
								}`,
							);
						});
				}
			}
		}

		// 安静契约（2026-11-09 T2）：判定是确定性的，不调模型；标记从产出里剔除。
		// 判为 quiet 时调用方不写摘要、不额外汇报（run 记录 summary="quiet"）。
		// 边界：模型这一轮的 assistant 条目由 durable 内核落盘，服务端没有撤回 API；
		// 这里保证的是"服务端不再写第二遍"，不是"transcript 里绝对没有痕迹"。
		const joined = pieces.join("");
		// 工具报错账（批 21 §三）：本轮有任何工具报错，"看起来没内容"不当安静吞掉。
		const toolErrors = takeTurnToolErrors(chat.internalId);
		// 只在"真跑完了"的轮次上判安静：unanswered 的说明/错误不能当"没内容"吞掉。
		const canJudge = quietEligible && (sawDelta || settled.record?.status === "done");
		const verdict = canJudge
			? assessRoutineOutputGuarded(joined, toolErrors.length)
			: { quiet: false, text: joined };
		const skipped = takeUnattendedSkips(chat.internalId);
		// 兜底（2026-11-17）：工具报错 + 正文为空 = 这一轮什么都没跑成。
		// 安静契约已被压成「非安静」，但产出是空串；服务端补一句，别让主人只看到空白。
		if (toolErrors.length > 0 && !verdict.text.trim() && routineErrorNoteEnabled()) {
			const note = routineErrorNote(toolErrors, chat.internalId);
			try {
				await sayInConversation(chat.internalId, note);
			} catch (error) {
				console.warn(
					`[routine] 兜底消息没写进去: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			return { ok: true, text: note, skipped, toolErrors };
		}
		return verdict.quiet
			? { ok: true, text: verdict.text, quiet: true, skipped }
			: {
					ok: true,
					text: verdict.text,
					skipped,
					...(toolErrors.length > 0 ? { toolErrors } : {}),
				};
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			text: pieces.join(""),
			error: `这一轮没跑完：${detail}`,
			skipped: takeUnattendedSkips(chat.internalId),
		};
	} finally {
		if (authority === "autonomous") {
			unmarkAutonomyTurn(chat.internalId);
			unmarkRoutineTurn(chat.internalId);
		}
	}
}

async function stepChain(
	chat: ResolvedChat,
	chain: Parameters<typeof nextChainCandidate>[0],
	reason: string,
): Promise<(Parameters<typeof nextChainCandidate>[0])[number] | null> {
	const current = await chat.conversation
		.agent(CTX)
		.then((agent) => agent.model ?? null)
		.catch(() => null);
	const verdict = nextChainCandidate(chain, current, reason);
	if (verdict.action !== "retry" || !verdict.target) {
		console.warn(`[model-chain] 不再重试：${verdict.reason}`);
		return null;
	}
	const target = verdict.target;
	if (!process.env[target.keyEnv]?.trim()) {
		console.warn(
			`[model-chain] 候选 ${target.providerId}/${target.modelId} 的 ${target.keyEnv} 没有 env 值，跳过`,
		);
		return null;
	}
	try {
		// v1 限制：候选按裸模型 id 配（不带思考后缀变体）；thinkingLevel 字段先落库，接线后置
		await chat.conversation.configure(
			{ model: { provider: target.providerId, modelId: target.modelId } },
			CTX,
		);
	} catch (error) {
		console.warn(
			`[model-chain] 切到 ${target.providerId}/${target.modelId} 失败: ${error instanceof Error ? error.message : String(error)}`,
		);
		return null;
	}
	console.warn(
		`[model-chain] 本轮 unanswered（${reason.slice(0, 80)}）→ 换 ${target.providerId}/${target.modelId} 重跑（${verdict.reason}）`,
	);
	return target;
}

async function ensureFreshPartnerSession(partnerId: string): Promise<ResolvedChat | null> {
	const store = partnersStore();
	const partner = store.get(partnerId);
	if (!partner || partner.status !== "active") return null;
	const externalId = `task-routine-${partnerId.slice(0, 8)}-${Date.now()}`;
	const chat = await openOrCreateChat(externalId);
	store.linkSession({
		partnerId,
		role: "routine",
		routeKey: `routine:fresh:${externalId}`,
		sessionId: chat.internalId,
	});
	// 2026-11-15 快照退役：SOUL 读磁盘当前值（计数存在才配，与老口径一致）。
	const epoch = partner.currentVersion;
	if (epoch != null) {
		await chat.conversation.configure(
			{ instructions: renderPartnerIdentity(partner, store.readSoulFromHome(partnerId) ?? "") },
			CTX,
		);
	}
	await pinPartnerWorkspace(chat);
	return chat;
}

const GREETING_REQUIREMENTS = [
	"# 这次要做什么",
	"这是你第一次和主人说话。请主动说一句开场问候。",
	"要求：2–3 句，最多问一个问题；用你自己的身份和说话方式，不要客套模板。",
	"你就是这个执事本人，不是某个大模型的客服：不报模型名、不提供应商或公司（实测模型会自称「商汤日日新」这类名字，主人不想看到）。",
	"不编造经历，不宣称任何外部服务已经接通，不要调用任何工具。",
].join("\n");

const GREETING_REQUEST = "请按上面的要求，现在写下这句开场问候。";

export function partnerGreetingEnabled(): boolean {
	return flagEnabled("PARTNER_GREETING_ENABLED");
}

export type PartnerGreetingOutcome = "sent" | "existing" | "skipped" | "disabled";

export type OpenPartnerConversationResult =
	| { ok: true; chat: ResolvedChat; greeting: PartnerGreetingOutcome }
	| { ok: false; reason: "not_found" | "chief" | "inactive" | "unavailable" | "failed" };

export { CTX, GREETING_REQUEST, GREETING_REQUIREMENTS, ensureFreshPartnerSession, openPartnerSession, partnerSkillsIndex, sessionOpenings, stepChain };
