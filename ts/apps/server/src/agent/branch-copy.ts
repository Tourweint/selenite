/**
 * 从回答分支 · 复制计划（2026-11-17 批3a，纯函数）。
 *
 * 只读源会话的 entries，产出"可逐条 append 到新会话"的条目计划；真正的 append 在调用方
 * 的 durable 事务里做（新 id 只能由 appendEntry 分配，纯函数无法知道）。
 * 设计口径见 docs/设计方案/2026-11-17-会话分叉（从某条回答另开一支）.md §复制的技术口径。
 */

import { contentText } from "@earendil-works/pi-ai";
import { flagEnabled } from "../flags.ts";

/** 会话分叉回滚开关（2026-11-18 抠进插件清单）：`false` / `0` / `off` → 分支端点 404、前端按 /agent/policy 的 chatBranch 收起「从这里分支」。默认开。 */
export function chatBranchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return flagEnabled("CHAT_BRANCH_ENABLED", env);
}

export interface BranchPlan {
	/** 已处理：usage 全 0、compaction head / edits.target 待回填；按原顺序，可直接喂给 tx.appendEntry。 */
	entries: Array<Record<string, unknown>>;
	count: number;
	/**
	 * compaction 的 head 重映射（**仅历史 / 合成数据的后向引用**）：entries 下标 → 复制下标。
	 * 新会话里的真实 id 要等 append 后才知道，调用方维护 复制下标 → newId，追加后回填 draft.head。
	 */
	headRemaps: Array<{ entryIndex: number; headIndex: number }>;
	/**
	 * 上下文覆盖（`edits[].target`）的重映射：entries 下标 → edits 下标 → 复制下标。
	 * 与 head 一样，纯函数只给下标，真实新 id 由调用方在追加时回填。
	 */
	editRemaps: Array<{ entryIndex: number; editIndex: number; targetIndex: number }>;
	/**
	 * 真实 compaction 的 head 是**前向引用**（first kept entry 在 compaction 之后）。
	 * 副本里摘掉 head 后，它退化为普通摘要条目（model 里的 summary 照常进上下文），
	 * 上下文等价；未来再压缩会重新折叠。这里只计数，便于日志核对。
	 */
	flattenedCompaction: number;
	/** head 不在复制范围而丢掉的 compaction 条数（写日志，不向客户端报错） */
	droppedCompaction: number;
}

export type BranchPlanResult =
	| { ok: true; plan: BranchPlan }
	| { ok: false; reason: "not_assistant" | "empty" | "too_large"; message: string };

const MAX_ENTRIES = 400;
const MAX_BYTES = 64 * 1024 * 1024;

/** usage 全 0 同形：数字归零、嵌套 cost 递归归零、其它键保留形状。 */
function zeroUsage(usage: unknown): unknown {
	if (typeof usage === "number") return 0;
	if (Array.isArray(usage)) return usage.map(zeroUsage);
	if (usage && typeof usage === "object") {
		return Object.fromEntries(
			Object.entries(usage as Record<string, unknown>).map(([key, value]) => [key, zeroUsage(value)]),
		);
	}
	return usage;
}

/**
 * sourceEntries 是源会话从 1 到分叉点的全部条目（含 id），按原顺序。
 * targetIndex 指向分叉的那条 pi.assistant。
 */
export function planBranchCopy(
	sourceEntries: ReadonlyArray<{
		id: number;
		kind: string;
		model?: any[];
		data?: any;
		head?: unknown;
		edits?: any[];
	}>,
	targetIndex: number,
): BranchPlanResult {
	const target = sourceEntries[targetIndex];
	if (!target || target.kind !== "pi.assistant" || !Number.isInteger(targetIndex) || targetIndex < 0) {
		return {
			ok: false,
			reason: "not_assistant",
			message: "分叉点不是一条助手回答",
		};
	}
	const message = Array.isArray(target.model) ? target.model[0] : undefined;
	const text = message
		? contentText(message.content as Parameters<typeof contentText>[0]).trim()
		: "";
	if (!text) {
		return { ok: false, reason: "empty", message: "这条回答没有正文，不能从这里分叉" };
	}

	// 复制 0..targetIndex（含）全部条目，不挑 kind——未知 kind 照抄，保住上下文一致性。
	const slice = sourceEntries.slice(0, targetIndex + 1);
	if (slice.length > MAX_ENTRIES) {
		return { ok: false, reason: "too_large", message: "这条太长了，先压缩再复制" };
	}

	// 源条目 id → 复制下标（复制顺序），用于 compaction head 重映射。
	const indexById = new Map<number, number>();
	slice.forEach((entry, index) => indexById.set(Number(entry.id), index));

	const entries: Array<Record<string, unknown>> = [];
	const headRemaps: Array<{ entryIndex: number; headIndex: number }> = [];
	const editRemaps: Array<{ entryIndex: number; editIndex: number; targetIndex: number }> = [];
	let flattenedCompaction = 0;
	let droppedCompaction = 0;

	slice.forEach((entry, index) => {
		const copy: Record<string, unknown> = { ...entry };

		// usage 清零：历史 usage 账按条目扫，复制一份会让账单翻倍。没有 usage 的不补。
		if (Array.isArray(copy.model)) {
			copy.model = copy.model.map((item: any) => {
				if (!item || typeof item !== "object" || !("usage" in item)) return item;
				return { ...item, usage: zeroUsage(item.usage) };
			});
		}

		// 上下文覆盖的 target 是源会话的旧 id，原样抄过去会对不上、覆盖静默失效。
		// 换成复制下标并暂时摘掉 target，真实新 id 由调用方在追加时回填。
		if (Array.isArray(copy.edits)) {
			const keptEdits: Array<Record<string, unknown>> = [];
			for (const edit of copy.edits) {
				const oldTarget = Number((edit as { target?: unknown })?.target);
				const targetIndex = Number.isFinite(oldTarget) ? indexById.get(oldTarget) : undefined;
				if (targetIndex === undefined) continue; // 目标不在复制范围：丢掉这条 edit
				const clonedEdit = { ...(edit as Record<string, unknown>) };
				delete clonedEdit.target;
				keptEdits.push(clonedEdit);
				editRemaps.push({
					entryIndex: entries.length,
					editIndex: keptEdits.length - 1,
					targetIndex,
				});
			}
			if (keptEdits.length > 0) copy.edits = keptEdits;
			else delete copy.edits;
		}

		if (entry.kind === "pi.compaction") {
			const oldHead = Number((entry as { head?: unknown }).head);
			const headIndex = Number.isFinite(oldHead) ? indexById.get(oldHead) : undefined;
			if (headIndex === undefined) {
				// head 指向不在复制范围（理论上不会，从 1 开始复制）：丢掉这条，不报错。
				droppedCompaction += 1;
				return;
			}
			delete copy.head;
			if (headIndex < index) {
				// 历史 / 合成数据的后向引用：记下重映射，等真实新 id 回填。
				headRemaps.push({ entryIndex: entries.length, headIndex });
			} else {
				// 真实 compaction 的 head 是**前向引用**（first kept entry 在 compaction 之后）：
				// 追加到这里时那条还没落库，注不回 id。摘掉 head 后，compaction 条目的
				// model: [UserMessage(<summary>)] 被内核当普通摘要消息贡献进上下文，
				// 副本 = 摘要 + 保留段，与源上下文等价；未来再压缩会重新折叠。
				flattenedCompaction += 1;
			}
		}

		entries.push(copy);
	});

	if (JSON.stringify(entries).length > MAX_BYTES) {
		return { ok: false, reason: "too_large", message: "这条太长了，先压缩再复制" };
	}

	return {
		ok: true,
		plan: {
			entries,
			count: entries.length,
			headRemaps,
			editRemaps,
			flattenedCompaction,
			droppedCompaction,
		},
	};
}
