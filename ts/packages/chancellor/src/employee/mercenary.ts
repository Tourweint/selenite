import type { QoderResult } from "../types.ts";
import {
	buildQoderInvocation,
	createQoderCnEmployee,
	createQoderIntlEmployee,
	MERCENARY_CAPABILITIES,
	QODER_CAPABILITIES,
	resolveQoderBinary,
	runQoderCn,
	runQoderIntl,
	type QoderCall,
	type QoderInvocation,
} from "./qoder.ts";

/**
 * 旧的「雇佣兵」入口保留为 Qoder 国际版的别名。
 *
 * 2026-11-03 起真正的实现搬到了 `qoder.ts`（国际版 / CN 两个适配器），
 * 拆单、验收这些内部调用仍走 `runQoder`，行为不变；
 * 想换 CN 用 `CHANCELLOR_EMPLOYEE=qoder-cn`。
 */
export function runQoder(call: QoderCall): Promise<QoderResult> {
  return runQoderIntl(call);
}

export function createMercenaryEmployee() {
  return createQoderIntlEmployee("mercenary");
}

export {
	buildQoderInvocation,
	MERCENARY_CAPABILITIES,
	QODER_CAPABILITIES,
	resolveQoderBinary,
	runQoderCn,
	runQoderIntl,
	type QoderCall,
	type QoderInvocation,
};
