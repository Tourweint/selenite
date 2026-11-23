/**
 * 记忆页共享常量（分类名 / 顺序 / 组头悬停解释）
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出。
 * 2026-11-21 随 MEMORY_PAGE_A 退役删去旧版记忆页整套（*Legacy 函数与旧版专属的
 * 装载 / 整理 / 导入 / 列表管线——A 版管线在 memory-page.js + memory-items.js），
 * 本文件只留三张表给记忆页与员工页共用。
 */

/* 分类中文名（三处共用：记忆页 / 记忆条目投影 / 员工页履历标签） */
export const MEMORY_KIND_LABEL = {
  preference: "偏好",
  intention: "打算",
  fact: "事实",
  experience: "经验",
  episode: "经历",
  entity: "人事物",
  work: "履历",
};
export const MEMORY_KIND_ORDER = ["preference", "intention", "fact", "experience", "entity", "episode", "work"];
/* 组头悬停解释（2026-11-08）：组标题挪到卡片外，"经历是干啥的"这类疑问悬停即答 */
export const MEMORY_KIND_TIPS = {
  preference: "你的喜好与习惯（例如「喜欢简洁的汇报」）。召回时排在前面成段，不相关时不会带。",
  intention: "还没兑现的打算（例如「下周开始跑步」）。未过期时优先想起；到期后自动变成普通事实。",
  fact: "关于你和你的生活的客观事实（例如「家里有两只猫」），按相关度召回。",
  experience: "这类活下次可以怎么做。从你的纠正里提炼出来，不会过期。",
  entity: "重要的人、项目、东西的条目，聊到相关的就会想起。",
  episode: "聊过、经历过的事的记录，帮你想起「上次……」。日常经过，默认收起。",
  work: "派单结算留下的履历，只增不改；记忆页下方「工作履历」里看。",
};
