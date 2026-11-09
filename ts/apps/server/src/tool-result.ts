/**
 * 工具返回统一契约（2026-11-10 批 16 §一；全景调研五 §八#1）。
 *
 * 形状只有两种：
 *   - 成功 `{ ok: true, data }`；
 *   - 失败 `{ ok: false, error: { code, message, hint? } }`。
 * `code` 给机器分支（稳定枚举，不改语义），`message` 给人 / 模型读，
 * `hint` 是可选的"下一步该干什么"（gstack「错误写给 AI 看」的同族实践）。
 *
 * **为什么先只给新工具用**：我们现有 20 来个工具的返回形状各自为政（有的回中文句子、
 * 有的回 JSON、有的直接抛错），一次性全改会把每一条工具链路的模型行为一起动掉，
 * 审查范围无法验证。所以这一批只落**契约与三个最近新增的工具**（`ask_user` /
 * `report_progress` / `recall_sessions`），旧工具逐字节不动。
 *
 * **旧工具怎么逐步迁移**（下一批从哪开始）：先迁只读、低风险的（`recall` / `recall_sessions`
 * 同族 → `web_search` / `propose_topic`），每迁一个就把该工具的输出解析与
 * 对应测试一起改，一次一批；写类工具（`delegate` / `work_*`）最后迁，
 * 因为它们的结果还被回执 / 恢复链路读取。迁移时保持人读的 `message` 不变，
 * 只把外层包成 `ToolResult`，别顺手改文案。
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
