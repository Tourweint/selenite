/**
 * 工具返回统一契约（2026-11-10 批 16 §一；全景调研五 §八#1）。
 *
 * 形状只有两种：
 *   - 成功 `{ ok: true, data }`；
 *   - 失败 `{ ok: false, error: { code, message, hint? } }`。
 * `code` 给机器分支（稳定枚举，不改语义），`message` 给人 / 模型读，
 * `hint` 是可选的"下一步该干什么"（gstack「错误写给 AI 看」的同族实践）。
 *
 * **为什么不是一次全改**：我们现有 20 来个工具的返回形状各自为政（有的回中文句子、
 * 有的回 JSON、有的直接抛错），一次性全改会把每一条工具链路的模型行为一起动掉，
 * 审查范围无法验证。所以批 16 先落**契约 + 三个新工具**（`ask_user` /
 * `report_progress` / `recall_sessions`），其余逐字节不动；再按下面的顺序一批一批迁。
 *
 * **旧工具怎么逐步迁移**（下一批从哪开始）：先迁只读、低风险的，每迁一个就把该工具的输出解析与
 * 对应测试一起改，一次一批。
 *
 * 迁移进度（2026-11-10 批 23b 核对）：
 *   - **已迁**：`recall_sessions` / `ask_user` / `report_progress` /
 *     `recall` / `web_search` / `propose_topic` / `skill`（批 18）、
 *     `delegate`（批 23b；只包外层，`needs_project` / `ticketId` 等业务分支留在 `data`）。
 *   - **还没迁**（都是会改状态或结果被别的链路读取的，必须单独一批一起改）：
 *     `remember` / `set_reminder` / `persona_recall` / `send_to_agent` /
 *     `propose_project` / `partner_skill_write` / `partner_manage` / `group_manage` /
 *     `routine_manage`。其中 `work_*` / `partner_*` 的结果被回执与恢复链路解析，
 *     改形状要连读取方一起改。`delegate` 已单独迁完：回执链路读的是 `startDelegation`
 *     的落库记录，不解析工具输出文本。
 *   - **不在范围内**：`read` / `write` / `edit` / `bash` 是 durable 的 `CodingTools` 提供的，
 *     形状由上游决定，这里不改。
 *
 * 迁移时保持人读的 `message` 不变，只把外层包成 `ToolResult`，别顺手改文案。
 *
 * 序列化：模型侧只能拿到文本，所以用 `encodeToolResult()` 统一成一行 JSON ——
 * 一个地方决定编码，将来要换格式（比如加 schemaVersion）只改这里。
 */

export interface ToolError {
	/** 稳定错误码（小写下划线），调用方 / 测试据此分支，不据 message 分支。 */
	code: string;
	/** 给人 / 模型看的一句话。 */
	message: string;
	/** 可选：下一步怎么做（"错误写给 AI 看"）。 */
	hint?: string;
}

export type ToolOk<T> = { ok: true; data: T };
export type ToolErr = { ok: false; error: ToolError };
export type ToolResult<T> = ToolOk<T> | ToolErr;

export function ok<T>(data: T): ToolOk<T> {
	return { ok: true, data };
}

export function err(code: string, message: string, hint?: string): ToolErr {
	return {
		ok: false,
		error: hint === undefined ? { code, message } : { code, message, hint },
	};
}

/** 编码成工具输出文本。固定一行 JSON，不带缩进 / 时间戳（同输入逐字节相同）。 */
export function encodeToolResult<T>(result: ToolResult<T>): string {
	return JSON.stringify(result);
}
