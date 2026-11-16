/**
 * 内部质检的核心模型（2026-11-16）
 *
 * 拆单 / 验收 / 目标核对不再借外部 CLI：用宿主当前的运行时模型做一次纯文本完成
 * （`models.completeSimple`，不挂工具）。和 `partner-learning.ts` 的
 * `completeWithPartnerModel` 同一套写法，只是模型取全局运行时选择、不取执事候选链。
 *
 * 回滚：`CHANCELLOR_INTERNAL=qoder` → 不注入，chancellor 回到原来的 Qoder 调用。
 * 默认 `core`。faux 模式没有真实内部模型，会明确失败（不再静默借 Qoder）。
 */

import { contentText } from "@earendil-works/pi-ai";
import type { QoderCall } from "../../../../../chancellor/src/dispatch.ts";
import { setInternalAsk } from "../../../../../chancellor/src/index.ts";
import type { QoderResult } from "../../../../../chancellor/src/types.ts";
import { currentModels, isFaux, readLlmConfig } from "./provider.ts";

export type InternalMode = "core" | "qoder";

const SYSTEM_PROMPT =
	"你是一个只输出所要求格式的内部文本模型。不要输出解释、前言或额外内容。";

/** `CHANCELLOR_INTERNAL=core`（缺省）/ `qoder`（回滚）。 */
export function chancellorInternalMode(
	env: NodeJS.ProcessEnv = process.env,
): InternalMode {
	return (env.CHANCELLOR_INTERNAL ?? "").trim().toLowerCase() === "qoder"
		? "qoder"
		: "core";
}

/** 进程启动一次：把核心调用注入 chancellor；qoder 模式注入 null（回到默认）。 */
export function installInternalAsk(
	env: NodeJS.ProcessEnv = process.env,
): InternalMode {
	const mode = chancellorInternalMode(env);
	setInternalAsk(mode === "core" ? coreInternalAsk : null);
	return mode;
}

export async function coreInternalAsk(call: QoderCall): Promise<QoderResult> {
	if (isFaux()) {
		return failed("faux 模式没有内部模型；拆单/验收需要真实模型");
	}
	const config = readLlmConfig();
	if (!config) return failed("内部模型未配置（LLM 未配置）");
	const models = currentModels();
	const model = models.getModel(config.model.provider, config.model.modelId);
	if (!model) {
		return failed(
			`内部模型不在模型目录里：${config.model.provider}/${config.model.modelId}`,
		);
	}

	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, call.timeoutMs);
	const onAbort = (): void => controller.abort();
	call.signal?.addEventListener("abort", onAbort, { once: true });

	try {
		const response = await models.completeSimple(
			model,
			{
				systemPrompt: SYSTEM_PROMPT,
				messages: [{ role: "user", content: call.prompt, timestamp: Date.now() }],
			},
			{
				signal: controller.signal,
				// 拆单要输出完整 JSON；验收/目标核对是短结论。
				maxTokens: call.label === "plan" ? 4000 : 1600,
				temperature: 0,
			},
		);
		if (response.stopReason === "aborted") {
			return failed(timedOut ? "内部模型超时" : "已停止", {
				...(timedOut ? { timedOut: true } : { aborted: true }),
			});
		}
		if (response.stopReason === "error") {
			// 原始错误只进服务端日志（可能带上游地址），调用方只拿分类。
			console.warn(
				`[internal] ${call.label} 调用失败：${(response.errorMessage ?? "unknown").slice(0, 200)}`,
			);
			return failed("内部模型调用失败（详见服务端日志）");
		}
		const text = contentText(response.content).trim();
		if (text === "") return failed("内部模型返回为空");
		return {
			ok: true,
			result: text,
			sessionId: null,
			isError: false,
			permissionDenials: 0,
			exitCode: 0,
			timedOut: false,
			aborted: false,
			stderrTail: "",
			error: null,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// 原始错误只进服务端日志（可能带上游地址）；不把提示词写进日志。
		console.warn(`[internal] ${call.label} 调用失败：${message.slice(0, 200)}`);
		return failed(
			timedOut ? "内部模型超时" : "内部模型调用失败（详见服务端日志）",
			{ ...(timedOut ? { timedOut: true } : {}) },
		);
	} finally {
		clearTimeout(timer);
		call.signal?.removeEventListener("abort", onAbort);
	}
}

function failed(
	error: string,
	patch: Partial<QoderResult> = {},
): QoderResult {
	return {
		ok: false,
		result: "",
		sessionId: null,
		isError: false,
		permissionDenials: 0,
		exitCode: null,
		timedOut: false,
		aborted: false,
		stderrTail: "",
		error,
		...patch,
	};
}
