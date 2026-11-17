/**
 * 「也许值得提起」的装配开关（2026-11-10 批 17 §二）。
 *
 * 为什么单独一个纯函数模块：这是"主动开口"类能力，默认关；判断"这一轮是不是执事轮"
 * 需要会话身份，但**策略本身**（默认关 + 执事轮不注入）不该散落在 assist.ts 的
 * 大函数里。放这里，单测可以直接断言，不必起记忆引擎。
 *
 * 口径：
 *   - `MEMORY_PROACTIVE` 缺省 false；只有 `true` / `1` / `on` 才开（观望型能力用"显式开"）；
 *   - 执事轮一律不注入——执事在干活，主动提起旧事只会让它跑题；
 *   - 群会话本来就不走记忆引擎，不在这里判断。
 */

import { flagValue } from "./flags.ts";

/** 主动提起总开关（默认关）：观望型能力保持严格 opt-in——只有显式 true / 1 / on 才开，拼错不开。 */
export function memoryProactiveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = flagValue("MEMORY_PROACTIVE", env).trim().toLowerCase();
	return raw === "true" || raw === "1" || raw === "on";
}

/**
 * 这一轮要不要渲染主动提起组。
 *
 * `isPartnerTurn` = 当前会话是否落在某个执事的 `partner:<id>` 键空间（总管主对话 /
 * 普通会话都传 false）。执事轮一律不注入；其余按总开关。
 */
export function proactiveForTurn(
	isPartnerTurn: boolean,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	if (isPartnerTurn) return false;
	return memoryProactiveEnabled(env);
}
