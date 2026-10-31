import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 技能库（2026-10-31，App 方案《Agent 化与上下文分层》步骤 2，D4/D5）。
 *
 * 技能 = 一份**流程类手册**（怎么引导一场会议回顾、怎么引导一次回忆），不是事实、不是人格。
 * 存放：`AGENT_SKILLS_DIR`（默认 `apps/server/skills/`）下的 `*.md` 文件，文件名 = 技能名。
 * 文件格式刻意简单：**第 1 行 = 索引里的一行摘要，其余 = 完整手册**。
 *
 * 与缓存的关系（方案 §2.1 不变量：所有 system 在首轮 user 前写齐，此后冻结）：
 * - 索引走 L1（extension 的 `skills` section），durable 对 section 是"最小补丁"语义——
 *   渲染值不变就不追加新 `pi.system`；
 * - 所以索引**按会话冻结**：每个会话第一次渲染时记下当时的索引，之后技能目录再变也不改写，
 *   本会话不会中途追加 system（那会整段作废已命中的缓存前缀）；
 * - "技能增删只影响下一个会话"是刻意取舍（方案 D5 / §4.4）。
 * - 技能**正文**不进 system：模型判断需要时调 `skill(name)` 工具取，走 L2（每轮追加）。
 */

export interface SkillStore {
	/** 全部技能名（`skill` 工具的兜底提示用） */
	names(): string[];
	/** 完整手册正文；名字不存在返回 undefined */
	manual(name: string): string | undefined;
	/**
	 * 本会话的技能索引。首轮渲染后按会话冻结；
	 * 没有任何技能时返回 undefined（section 整个省略，别渲染一个空标题）。
	 */
	indexFor(conversationId: number): string | undefined;
}

export function createSkillStore(dir: string): SkillStore | null {
	if (!existsSync(dir)) return null;

	const skills = new Map<string, { summary: string; manual: string }>();
	for (const file of readdirSync(dir).sort()) {
		if (!file.endsWith(".md")) continue;
		const name = file.slice(0, -3);
		const raw = readFileSync(join(dir, file), "utf8").trim();
		const [first, ...rest] = raw.split("\n");
		const summary = (first ?? "").trim();
		const manual = rest.join("\n").trim();
		// 格式不对的文件宁可不上索引：渲染半份手册比没有手册更糟
		if (!summary || !manual) {
			console.warn(`[skills] 跳过格式不对的技能文件（第 1 行应是摘要）：${file}`);
			continue;
		}
		skills.set(name, { summary, manual });
	}
	if (skills.size === 0) return null;

	const frozen = new Map<number, string>();
	const renderIndex = (): string => {
		const lines = [...skills.entries()].map(([name, skill]) => `- ${name}：${skill.summary}`);
		return (
			"可用技能（对方的事需要按某个流程引导时，先调 skill(name) 取完整手册再开始）：\n" +
			lines.join("\n")
		);
	};

	console.log(`[skills] 已加载 ${skills.size} 条技能：${[...skills.keys()].join("、")}`);
	return {
		names: () => [...skills.keys()],
		manual: (name) => skills.get(name)?.manual,
		indexFor(conversationId) {
			let index = frozen.get(conversationId);
			if (index === undefined) {
				index = renderIndex();
				frozen.set(conversationId, index);
			}
			return index;
		},
	};
}
