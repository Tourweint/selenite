/**
 * 代码内置的技能名（2026-11-16 工具裁剪 A）。
 *
 * 这些技能**始终进索引、始终能被 skill(name) 取到**，不受技能启停位（默认全关）影响，
 * 也不受按人可见性过滤——内置手册是工具政策的载体（如 delegate 的完整派活流程），
 * 关掉它等于让工具描述失去配套说明，所以没有开关、只能按提交回退。
 *
 * 只认这份代码名单，不认技能文件 frontmatter 里的自封（用户目录里放一个同名 "delegate.md"
 * 声明自己是 core 也没用）。名单是代码常量 → core 资格只由编译进来的这份文件决定。
 * 普通技能（不在这份名单里）的行为完全不变，仍走既有启停位 / 按人可见性。
 */
export const CORE_SKILL_NAMES = new Set(["delegate"]);

export function isCoreSkill(name: string): boolean {
	return CORE_SKILL_NAMES.has(name);
}
