/**
 * 派活的进度与「需要你」事件（2026-11-02）。
 *
 * 为什么单独一个模块：发事件的是工具（`tools.ts` 里的 `delegate`），
 * 收事件的是对话流（`agent.ts` 的 `chatStream`）。这两个文件本来就互相引用，
 * 再把通道塞进其中一边就会成环。放中间，两边都只依赖它。
 *
 * 为什么不用 `phaseSinks` 那套：那个通道只有"在想/在动手"两个值，
 * 表达不了「第 2 件 / 共 3 件 / 写测试」，也表达不了「它在等你回答什么」。
 */

export type DelegationEvent =
	/** 进度：正在办第几件、共几件、这件叫什么 */
	| { type: "delegate"; done: number; total: number; current: string }
	/** 需要人：一个问题，不是一句「出错了」 */
	| { type: "attention"; kind: "need_input" | "need_decision" | "need_action"; question: string };

type Sink = (event: DelegationEvent) => void;

const sinks = new Map<number, Set<Sink>>();

export function watchDelegation(conversationId: number, sink: Sink): () => void {
	let set = sinks.get(conversationId);
	if (!set) {
		set = new Set();
		sinks.set(conversationId, set);
	}
	set.add(sink);
	return () => {
		set.delete(sink);
		if (set.size === 0) sinks.delete(conversationId);
	};
}

export function emitDelegation(conversationId: number, event: DelegationEvent): void {
	const set = sinks.get(conversationId);
	if (!set) return;
	for (const sink of set) {
		try {
			sink(event);
		} catch {
			/* 订阅方异常不该影响派活 */
		}
	}
}
