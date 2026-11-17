import { runQoder, type QoderCall } from "./dispatch.ts";
import type { QoderResult } from "./types.ts";

/**
 * 内部质检（拆单 / 验收 / 目标核对）的模型入口（2026-11-16）。
 *
 * 这三个步骤不是工人：它们是派活流程里的内部质检，只做一次纯文本 LLM 调用。
 * 之前直接借 Qoder CLI 的 `-p`，是 chancellor 早期作为独立库时的历史选择；
 * 2026-11-16 用户拍板：内部东西用核心 PI，不要把外部 CLI 的职责搬进内部。
 *
 * 宿主（harness）启动时用 `setInternalAsk()` 注入一个核心模型调用；
 * 不注入（standalone CLI / 旧测试）仍回 Qoder，保持旧行为。
 */
export type InternalAsk = (call: QoderCall) => Promise<QoderResult>;

let internalAsk: InternalAsk | null = null;

/** 宿主注入；传 null = 回到 Qoder。 */
export function setInternalAsk(fn: InternalAsk | null): void {
  internalAsk = fn;
}

/** plan / review / goal 统一从这里拿调用；没有注入就是 Qoder。 */
export function askInternal(call: QoderCall): Promise<QoderResult> {
  return (internalAsk ?? runQoder)(call);
}
