/**
 * export-bundle-collect-conversations
 *
 * 2026-11-14 从 export-bundle.ts 的 L477–L861 整段切出；正文原文搬运，未改一行实现。
 * 内含：collectConversations / chatDirName / uniqueDir / collectMemory …
 */

import type { ChatIndexEntry } from "./agent.ts";
import { listChatsForExport, memoryEngine, openChat, readTranscript, usageSummary } from "./agent.ts";
import { diaryStore } from "./diary.ts";
import { listFlags } from "./flags.ts";
import { COMPANIONS_ENABLED, partnersStore } from "./partners.ts";
import { projectsStore } from "./projects.ts";
import { modelCatalog, readLlmConfig } from "./provider.ts";
import { topicsStore } from "./topics.ts";
import { MemoryRecord } from "@lifediary/memory";
import { createHash } from "node:crypto";
import { EXPORT_MESSAGE_LIMIT, EXPORT_PART_LABELS, MEMORY_SCOPE_LIMIT, chatTitleOf, decodeBase64, emptyPart, imageExtension, isoOrNull, jsonFile, jsonlFile, localStamp, projectOf, renderMessagesJson, renderTranscriptMarkdown, shortError, slugifyTitle } from "./export-bundle-compose-bundle.ts";
import type { BundleFile, BundlePart, ExportMessage, ExportMessageImage, ExportPartId } from "./export-bundle-compose-bundle.ts";

async function collectConversations(withImages: boolean): Promise<BundlePart> {
	const chats = await listChatsForExport();
	if (!readLlmConfig()) {
		return emptyPart("conversations", "模型没配置，durable 会话读不出来（配好模型后再导）");
	}
	const files: BundleFile[] = [];
	const index: Record<string, unknown>[] = [];
	const counts = { conversations: 0, messages: 0, images: 0, archived: 0, truncatedChats: 0, failedChats: 0 };
	const notes: string[] = [];
	const usedDirs = new Set<string>();

	for (const entry of chats) {
		try {
			const resolved = await openChat(entry.conversationId);
			if (!resolved) throw new Error("会话打不开");
			const raw = await readTranscript(resolved, EXPORT_MESSAGE_LIMIT + 1);
			const truncated = raw.length > EXPORT_MESSAGE_LIMIT;
			const messages = truncated ? raw.slice(-EXPORT_MESSAGE_LIMIT) : raw;

			const dir = uniqueDir(chatDirName(entry), usedDirs);
			/** 包内路径（zip 里的相对路径），index 与 messages.json 用同一份 */
			const dirPath = `conversations/${dir}`;
			const chatFiles: BundleFile[] = [];
			const exported: ExportMessage[] = [];
			let imageSeq = 0;

			for (const message of messages) {
				const images: ExportMessageImage[] = [];
				for (const image of message.images ?? []) {
					const bytes = decodeBase64(image.data);
					const sha256 = createHash("sha256").update(bytes).digest("hex");
					imageSeq += 1;
					const base = `${String(imageSeq).padStart(4, "0")}-${sha256.slice(0, 8)}.${imageExtension(image.mimeType)}`;
					if (withImages) {
						chatFiles.push({ path: `${dirPath}/images/${base}`, bytes, compress: false });
						images.push({ mimeType: image.mimeType, path: `images/${base}`, bytes: bytes.length, sha256 });
						counts.images += 1;
					} else {
						images.push({ mimeType: image.mimeType, bytes: bytes.length, sha256 });
					}
				}
				exported.push({
					role: message.role,
					at: isoOrNull(message.at || null),
					text: message.text,
					...(message.id ? { id: message.id } : {}),
					...(images.length > 0 ? { images } : {}),
					...(message.files && message.files.length > 0 ? { files: message.files } : {}),
					...(message.steps ? { steps: message.steps } : {}),
					...(message.workMs !== undefined ? { workMs: message.workMs } : {}),
				});
			}

			chatFiles.push({ path: `${dirPath}/messages.json`, text: renderMessagesJson(entry, dirPath, exported, truncated) });
			chatFiles.push({ path: `${dirPath}/transcript.md`, text: renderTranscriptMarkdown(entry, exported, truncated) });
			files.push(...chatFiles);

			counts.conversations += 1;
			counts.messages += exported.length;
			if (entry.archived) counts.archived += 1;
			if (truncated) counts.truncatedChats += 1;
			index.push({
				id: entry.conversationId,
				title: chatTitleOf(entry),
				chatKind: entry.chatKind,
				createdAt: isoOrNull(entry.createdAt),
				lastAt: isoOrNull(entry.lastAt),
				turns: entry.turns,
				pinned: Boolean(entry.pinned),
				archived: Boolean(entry.archived),
				archivedAt: isoOrNull(entry.archivedAt ?? null),
				project: projectOf(entry),
				dir: dirPath,
				messages: exported.length,
				truncated,
				images: exported.reduce((sum, message) => sum + (message.images?.filter((one) => one.path).length ?? 0), 0),
			});
		} catch (error) {
			counts.failedChats += 1;
			notes.push(`会话 ${entry.conversationId} 没导出：${shortError(error)}`);
		}
	}

	if (chats.length === 0) return emptyPart("conversations", "还没有会话");

	files.push(
		jsonFile("conversations/index.json", {
			total: counts.conversations,
			archived: counts.archived,
			entries: index,
		}),
	);
	if (counts.conversations === 0 && counts.failedChats > 0) {
		return {
			id: "conversations",
			label: EXPORT_PART_LABELS.conversations,
			status: "failed",
			files,
			counts,
			limits: { messagesPerChat: EXPORT_MESSAGE_LIMIT, images: withImages },
			notes,
			error: `${counts.failedChats} 段会话都读不出来`,
		};
	}
	return {
		id: "conversations",
		label: EXPORT_PART_LABELS.conversations,
		status: "ok",
		files,
		counts,
		limits: { messagesPerChat: EXPORT_MESSAGE_LIMIT, images: withImages },
		notes,
	};
}

function chatDirName(entry: ChatIndexEntry): string {
	const date = localStamp(entry.createdAt).slice(0, 10) || "0000-00-00";
	return `${date}-${slugifyTitle(chatTitleOf(entry))}-${entry.conversationId.slice(0, 8)}`;
}

function uniqueDir(base: string, used: Set<string>): string {
	let candidate = base;
	let index = 2;
	while (used.has(candidate)) {
		candidate = `${base}-${index}`;
		index += 1;
	}
	used.add(candidate);
	return candidate;
}

function collectMemory(): BundlePart {
	if (!memoryEngine) {
		return emptyPart("memory", "记忆没启用（MEMORY_ENABLED=false）");
	}
	const stats = memoryEngine.stats();
	const byScope: Record<string, number> = {};
	const byKind: Record<string, number> = {};
	const rows: MemoryRecord[] = [];

	for (const scope of Object.keys(stats.byScope).sort()) {
		const records = memoryEngine.list({ scopes: [scope], limit: MEMORY_SCOPE_LIMIT, includeSuperseded: true });
		byScope[scope] = records.length;
		for (const record of records) {
			byKind[record.kind] = (byKind[record.kind] ?? 0) + 1;
			rows.push(record);
		}
	}

	const exported = rows.length;
	const truncated = stats.total > exported;
	const files: BundleFile[] = [
		jsonlFile("memory/records.jsonl", rows),
		jsonFile("memory/index.json", {
			total: stats.total,
			exported,
			truncated,
			byScope,
			byKind,
		}),
	];
	return {
		id: "memory",
		label: EXPORT_PART_LABELS.memory,
		status: exported > 0 ? "ok" : "empty",
		files,
		counts: { records: exported, scopes: Object.keys(byScope).length },
		limits: { perScope: MEMORY_SCOPE_LIMIT },
		notes: truncated ? [`记忆共 ${stats.total} 条，导出 ${exported} 条（每作用域上限 ${MEMORY_SCOPE_LIMIT}）`] : [],
	};
}

function collectLibrary(): BundlePart {
	const files: BundleFile[] = [];
	const counts: Record<string, number> = {};
	const notes: string[] = [];

	try {
		const store = projectsStore();
		const projects = store.listProjects(true);
		files.push(
			jsonFile("library/projects.json", {
				workspace: store.getWorkspace(),
				projects,
				proposals: store.listProposals("all"),
			}),
		);
		counts.projects = projects.length;
	} catch (error) {
		notes.push(`项目库读失败：${shortError(error)}`);
	}

	try {
		const topics = topicsStore().list();
		files.push(jsonFile("library/topics.json", { topics }));
		counts.topics = topics.length;
	} catch (error) {
		notes.push(`课题读失败：${shortError(error)}`);
	}

	try {
		const diary = diaryStore();
		const total = diary.count();
		const entries = diary.list(total + 1);
		files.push(jsonlFile("library/diary.jsonl", entries));
		counts.diary = entries.length;
	} catch (error) {
		notes.push(`日记读失败：${shortError(error)}`);
	}

	try {
		const routines = partnersStore().listRoutines();
		files.push(jsonFile("library/routines.json", { routines }));
		counts.routines = routines.length;
	} catch (error) {
		notes.push(`例行读失败：${shortError(error)}`);
	}

	const hasAny = (counts.projects ?? 0) + (counts.topics ?? 0) + (counts.diary ?? 0) + (counts.routines ?? 0) > 0;
	return {
		id: "library",
		label: EXPORT_PART_LABELS.library,
		status: hasAny ? "ok" : "empty",
		files,
		counts,
		notes,
	};
}

function collectTeam(): BundlePart {
	if (!COMPANIONS_ENABLED) return emptyPart("team", "执事没启用（COMPANIONS_ENABLED=false）");

	const store = partnersStore();
	const partners = store.list();
	const files: BundleFile[] = [];
	const counts: Record<string, number> = { partners: partners.length };
	const notes: string[] = [];

	const roster: Record<string, unknown>[] = [];
	/** partnerId → 头像在包里的路径（群成员复用同一份，不重复落文件） */
	const avatarPaths = new Map<string, string>();
	for (const partner of partners) {
		let avatarPath: string | null = null;
		if (partner.avatar) {
			const match = /^data:([^;,]+);base64,(.*)$/.exec(partner.avatar);
			if (match) {
				const bytes = decodeBase64(match[2]!);
				const ext = imageExtension(match[1]!);
				avatarPath = `team/avatars/${partner.id}.${ext}`;
				files.push({ path: avatarPath, bytes, compress: false });
				avatarPaths.set(partner.id, avatarPath);
			}
		}
		const soul = store.readSoulFromHome(partner.id);
		if (soul) files.push({ path: `team/souls/${partner.id}.md`, text: soul });
		const contract = store.readContractFromHome(partner.id);
		if (contract) files.push({ path: `team/contracts/${partner.id}.md`, text: contract });
		roster.push({
			id: partner.id,
			name: partner.name,
			status: partner.status,
			currentVersion: partner.currentVersion,
			domain: partner.domain,
			dispatchAuthority: partner.dispatchAuthority,
			currentGoal: partner.currentGoal,
			tagline: partner.tagline,
			diary: partner.diary,
			createdAt: partner.createdAt,
			updatedAt: partner.updatedAt,
			avatarPath,
			soulPath: soul ? `team/souls/${partner.id}.md` : null,
			contractPath: contract ? `team/contracts/${partner.id}.md` : null,
		});
	}
	files.push(jsonFile("team/partners.json", { partners: roster }));

	const groups = store.listGroups();
	counts.groups = groups.length;
	files.push(
		jsonFile(
			"team/groups.json",
			{
				groups: groups.map((group) => ({
					id: group.id,
					name: group.name,
					notice: group.notice,
					responderKind: group.responderKind,
					responderPartnerId: group.responderPartnerId,
					createdAt: group.createdAt,
					updatedAt: group.updatedAt,
					members: group.members.map((member) => ({
						partnerId: member.partnerId,
						name: member.name,
						position: member.position,
						status: member.status,
						domain: member.domain,
						avatarPath: avatarPaths.get(member.partnerId) ?? null,
					})),
				})),
			},
		),
	);

	const messages: unknown[] = [];
	for (const group of groups) {
		let cursor = 0;
		// 每页 500（store 的硬顶），翻到没有新行为止
		for (;;) {
			const page = store.listGroupMessages(group.id, { afterSeq: cursor, limit: 500 });
			if (page.length === 0) break;
			for (const message of page) {
				// 行里本来就带 groupId（群消息表主键含它），不重复拼
				messages.push(message);
			}
			cursor = page[page.length - 1]!.seq;
			if (page.length < 500) break;
		}
	}
	counts.groupMessages = messages.length;
	files.push(jsonlFile("team/group-messages.jsonl", messages));

	const hasAny = partners.length > 0 || groups.length > 0;
	return {
		id: "team",
		label: EXPORT_PART_LABELS.team,
		status: hasAny ? "ok" : "empty",
		files,
		counts,
		notes,
	};
}

async function collectConfig(): Promise<BundlePart> {
	const files: BundleFile[] = [];
	const counts: Record<string, number> = {};
	const notes: string[] = [];

	try {
		const catalog = modelCatalog();
		files.push(jsonFile("config/providers.json", catalog));
		counts.providers = catalog.providers.length;
	} catch (error) {
		notes.push(`供应商目录读失败：${shortError(error)}`);
	}

	try {
		const usage = readLlmConfig() ? await usageSummary() : { models: [] };
		files.push(jsonFile("config/usage.json", usage));
		counts.models = usage.models.length;
	} catch (error) {
		notes.push(`用量读失败：${shortError(error)}`);
	}

	try {
		const flags = listFlags();
		files.push(jsonFile("config/flags.json", flags));
		counts.flags = flags.flags.length;
	} catch (error) {
		notes.push(`开关读失败：${shortError(error)}`);
	}

	return {
		id: "config",
		label: EXPORT_PART_LABELS.config,
		status: "ok",
		files,
		counts,
		notes,
	};
}

const COLLECTORS: Record<ExportPartId, (withImages: boolean) => Promise<BundlePart> | BundlePart> = {
	conversations: (withImages) => collectConversations(withImages),
	memory: () => collectMemory(),
	library: () => collectLibrary(),
	team: () => collectTeam(),
	config: () => collectConfig(),
};

export class ExportTooLargeError extends Error {}

export { COLLECTORS, chatDirName, collectConfig, collectConversations, collectLibrary, collectMemory, collectTeam, uniqueDir };
