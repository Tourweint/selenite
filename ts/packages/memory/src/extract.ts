import type { MemoryCandidate, MemoryScope } from "./types.ts";

/**
 * 抽取层：把一段对话变成"值得记的候选"。
 *
 * 这是整个记忆系统里最该被替换的一层。当前实现是**纯规则**，
 * 只为了把链路跑通；它做不了一件事——判断什么才是真正重要的。
 * 真正该做的是让 LLM 在会话边界提炼（见 TODO），但那属于细节，
 * 框架先把这个位置留出来。
 */

export interface ExtractMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface ExtractInput {
	messages: ExtractMessage[];
	scope: MemoryScope;
	now: Date;
}

export interface Extractor {
	extract(input: ExtractInput): Promise<MemoryCandidate[]>;
}

/** 寒暄/无信息量的短句，不值得存 */
const NOISE = /^(嗯+|哦+|好的?|行|对|是|在吗|你好|谢谢|哈哈+|ok|okay|hi|hey)[。！？.!?~～\s]*$/i;

const SENTENCE_SPLIT = /[。！？!?\n]+/;

/**
 * 规则版抽取器：
 * 只从**用户说的话**里取，助手说的不记（助手的话是我们自己的产物，
 * 记下来会形成自我强化的回声）。按句切分，过滤寒暄与碎片。
 */
export class HeuristicExtractor implements Extractor {
	async extract(input: ExtractInput): Promise<MemoryCandidate[]> {
		const candidates: MemoryCandidate[] = [];
		const scope = scopeToKey(input.scope);

		for (const message of input.messages) {
			if (message.role !== "user") continue;

			for (const raw of message.content.split(SENTENCE_SPLIT)) {
				const sentence = raw.trim();
				if (sentence.length < 6) continue;
				if (NOISE.test(sentence)) continue;

				candidates.push({
					// TODO(细节): 区分 fact / entity / preference。
					// 需要 LLM 参与判断，规则版一律记成 episode。
					kind: "episode",
					scope,
					content: sentence,
					importance: Math.min(1, sentence.length / 60) * 0.6 + 0.2,
					veracity: "stated",
					source: "extract:heuristic",
					validUntil: null,
				});
			}
		}

		return candidates;
	}
}

/** 什么都不抽的版本：用于"只想跑通、不想存记忆"的场景 */
export class NoopExtractor implements Extractor {
	async extract(): Promise<MemoryCandidate[]> {
		return [];
	}
}

function scopeToKey(scope: MemoryScope): string {
	switch (scope.type) {
		case "global":
			return "global";
		case "day":
			return `day:${scope.date}`;
		case "topic":
			return `topic:${scope.name}`;
		case "session":
			return `session:${scope.id}`;
	}
}
