/**
 * 会话存活核对（2026-11-17，手机同步回收）。
 *
 * 手机本地存着会话清单（「首轮必须落库」的映射，见 App 仓库 AGENTS.md），
 * 电脑上删掉 / 归档之后，那些行会永远留在手机上。手机每次同步拿本地绑定的
 * conversationId 来问一句，这里只回「已经不在电脑上」的那些，手机据此软删本地行。
 *
 * 为什么不复用 `listChats`：那个接口为了首句与时间**逐会话读 context**
 * （已知代价见接口文档 §5），且带 limit 截断——拿它做回收判定会把"被截断"误判成"已删除"。
 *
 * 判定口径分两段：
 * - 本文件是**第一段（便宜）**：不在 durable 会话表 / 已归档 / `task-` 前缀；
 * - 第二段在 `session-index.ts` 的 `missingChats`（可见性）：会话在表里但一条消息都没有
 *   （`readChatStats` 为 null，`turns == 0`）也算不在——与 `GET /agent/chats` 的可见性同口径。
 *   2026-11-17 实机联调补：只按会话表判定，会把"电脑上早就不显示了"的空壳会话永远留在手机上。
 *
 * 刻意返回 `[]` 的两种情形：LLM 未配置（列表接口此时也返回空，不能把全部当已删）、
 * 请求为空。宁可少回收，不可误删。
 */
export function missingChatIds(
	ids: readonly string[],
	options: {
		byExternal: Readonly<Record<string, number>>;
		archived: ReadonlySet<string>;
		taskPrefix: string;
	},
): string[] {
	const seen = new Set<string>();
	const missing: string[] = [];
	for (const id of ids) {
		if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
		seen.add(id);
		const gone =
			id.startsWith(options.taskPrefix) ||
			options.archived.has(id) ||
			options.byExternal[id] === undefined;
		if (gone) missing.push(id);
	}
	return missing;
}
