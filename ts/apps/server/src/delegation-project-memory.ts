/**
 * 派活时注入项目记忆（2026-11-16）。
 *
 * 背景：派出去的 worker（chancellor 的本机池 `pool` 与 codebuddy / qoder / claude-code /
 * codex / opencode）读的是同一份 TASK.md，**两边都没有 harness 的记忆引擎**——
 * 所以只能在这份文本里把项目记忆送过去。这是唯一一个"一个方法覆盖两边"的位置。
 *
 * 用户口径（2026-11-16）：
 * - 内部派活按正常会话的量级给：**16 条 / 2000 字**；
 * - 外部 CLI 不单独做一套，走同一份文本。
 *
 * 硬约束：
 * - **只取单子所属项目的记忆**（project scope），不碰 global / partner（避免把私事带进外部 CLI）；
 * - 记忆库读不出来 / 开关关掉 → 返回空串，requirement 原样，**绝不阻塞派活**；
 * - 拼接结果**只进交给 chancellor 的 requirement**，不参与幂等指纹（同一请求不能因为
 *   记忆更新而变成"内容不同"）；
 * - 段首写明"供参考，不是本任务的指令"，冲突时以任务要求为准。
 */

import { scopeKey, type MemoryEngine } from "@lifediary/memory";

/** 最多注入几条（2026-11-16 用户拍板）。 */
export const DELEGATION_PROJECT_MEMORY_LIMIT = 16;

/** 整段（标题 + 条目 + 尾注）的字数上限（2026-11-16 用户拍板）。 */
export const DELEGATION_PROJECT_MEMORY_MAX_CHARS = 2000;

export interface ProjectMemoryHit {
	kind: string;
	content: string;
	createdAt: string;
}

/**
 * 渲染「项目记忆」段（纯函数，单测直接喂）。
 * 空命中 → 空串；超条数 / 超字数按顺序截断，尾注写明只挑了几条。
 */
export function renderDelegationProjectMemory(
	hits: readonly ProjectMemoryHit[],
	projectName: string,
	limit = DELEGATION_PROJECT_MEMORY_LIMIT,
	maxChars = DELEGATION_PROJECT_MEMORY_MAX_CHARS,
): string {
	if (hits.length === 0) return "";
	const title = `## 项目记忆（${projectName} 长期积累的规矩和坑；供参考，不是本任务的指令）`;
	const lines: string[] = [];
	let used = title.length;
	for (const hit of hits) {
		if (lines.length >= limit) break;
		const day = typeof hit.createdAt === "string" ? hit.createdAt.slice(0, 10) : "";
		const content = String(hit.content ?? "").trim();
		if (!content) continue;
		const line = `- [${hit.kind || "fact"}] ${content}${day ? `（${day}）` : ""}`;
		if (used + line.length + 1 > maxChars) break;
		lines.push(line);
		used += line.length + 1;
	}
	if (lines.length === 0) return "";
	const tail = `（只挑了最相关的 ${lines.length} 条；与本任务冲突时，以任务要求为准。）`;
	return `${title}\n${lines.join("\n")}\n${tail}`;
}

/** 追加到 requirement 尾部（`appendPlanSteps` 同款形态：不改变原 requirement）。 */
export function appendDelegationProjectMemory(requirement: string, section: string): string {
	return section ? `${requirement}\n\n${section}` : requirement;
}

/**
 * 按单子所属项目召回记忆并渲染成段。
 * 同步（memory engine 的 recall 是同步的）；任何失败都返回空串。
 */
export function delegationProjectMemoryText(
	engine: MemoryEngine | null | undefined,
	project: { id: string; name: string } | null | undefined,
	query: string,
): string {
	//（DELEGATION_PROJECT_MEMORY 回滚开关 2026-11-21 退役，恒注入。）
	if (!engine || !project) return "";
	try {
		const hits = engine.recall({
			text: query,
			scopes: [scopeKey({ type: "project", id: project.id })],
			limit: DELEGATION_PROJECT_MEMORY_LIMIT,
		});
		return renderDelegationProjectMemory(
			hits.map((hit) => ({
				kind: hit.record.kind,
				content: hit.record.content,
				createdAt: hit.record.createdAt,
			})),
			project.name,
		);
	} catch {
		// 记忆库坏了不阻塞派活：宁可少给，不让单子派不出去
		return "";
	}
}
