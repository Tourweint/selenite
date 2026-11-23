/**
 * 设置 → 上下文 · 默认开销（2026-11-16 续）
 *
 * 口径：
 *   - 不创建会话、不读聊天记录；按角色显式装配一份“全新会话会读到什么”；
 *   - 只算固定 / 半固定前缀：系统段、工具定义、技能索引、记忆预算；
 *     当前在办、记忆召回、会话消息都不进来；
 *   - 不复用 `indexFor`（会按会话冻结）；技能走 `previewIndex`，纯渲染不写状态；
 *   - 工具从已安装的真实 extension 取，不手抄工具清单。
 *
 * 这不是“第二个请求”，也不是请求历史：它只是把装配函数用默认参数跑一遍。
 */

import type { Message, SystemMessage, Tool } from "@earendil-works/pi-ai";
import type { ContextView, ToolRegistration } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { getHarness, lifediaryExt } from "./agent/lifecycle-harness.ts";
import { collectInjections, guardProvider, type InjectionContext, type InjectionProvider } from "./agent/injection.ts";
import {
  clarifyContractProvider,
  currentProjectProvider,
  personaProvider,
  userProfileProvider,
  verificationIronLawProvider,
} from "./agent/lifecycle-injections.ts";
import { buildPartnerTurnContext, splitContractSections } from "./agent/partner-context.ts";
import { CHANCELLOR_ENABLED, PERSONA, memoryEngine, skillStore } from "./agent/assist.ts";
import { executorLine } from "./executor-config.ts";
import { readWorkerPersona, WORKER_PERSONA_CHAT_TOOLS } from "./worker-persona.ts";
import { WORKER_SKILL_OWNER, workerSkillScopeEnabled } from "./skill-state.ts";
import {
  CHIEF_PARTNER_ID,
  COMPANIONS_ENABLED,
  PARTNER_CONTRACT_SECTIONS,
  partnersStore,
  resolvePersona,
} from "./partners.ts";
import { renderPartnerIdentityParts } from "./partner-runtime-run-partner-turn.ts";
import {
  contextInspectPayloadOf,
  type ContextInspectPayload,
} from "./context-inspect.ts";
import { modelToolCatalog, partnerToolsEnabled } from "./partner-tools.ts";
import { toolIndexText } from "./tool-index.ts";
import { buildTaskProfileSections } from "./pool/task-profile.ts";
import { poolToolCatalog } from "./pool/pool-tools.ts";
import { workerToolsPayload } from "./worker-tools.ts";

export type ContextDefaultKind = "chief" | "partner" | "worker" | "dispatch";

export interface ContextDefaultRole {
  /** 前端选择值：chief / worker / partner:<id> */
  id: string;
  label: string;
  kind: ContextDefaultKind;
  chatKind: ContextDefaultKind;
}

export interface ContextDefaultPayload extends ContextInspectPayload {
  default: true;
  role: ContextDefaultRole;
  roles: ContextDefaultRole[];
}

/** 岗位契约四节 → 默认页的稳定 key。节名来自 CONTRACT.md 的固定二级标题。 */
const CONTRACT_FIELD_KEYS: Record<string, string> = {
  职责范围: "partner_contract_scope",
  决策分级: "partner_contract_decision",
  验收标准: "partner_contract_acceptance",
  汇报对象: "partner_contract_report",
};

const BASE_ROLES: ContextDefaultRole[] = [
  { id: "chief", label: "总管", kind: "chief", chatKind: "chief" },
];

/** 角色目录：总管 → 活跃执事 → 普通 worker。读不到执事库时至少保留总管 / worker。 */
export function contextDefaultRoles(): ContextDefaultRole[] {
  const roles: ContextDefaultRole[] = [...BASE_ROLES];
  if (COMPANIONS_ENABLED) {
    try {
      const partners = partnersStore()
        .list()
        .filter(
          (partner) =>
            partner.id !== CHIEF_PARTNER_ID &&
            partner.status === "active",
        );
      for (const partner of partners) {
        roles.push({
          id: `partner:${partner.id}`,
          label: partner.name || "未命名执事",
          kind: "partner",
          chatKind: "partner",
        });
      }
    } catch {
      // 执事库读不出来：默认页仍要可用，不能因为一个目录读失败就整页 503。
    }
  }
  roles.push({ id: "worker", label: "普通 worker", kind: "worker", chatKind: "worker" });
  // 第二套运行时（2026-11-22）：派活工人（池）的 profile 与普通会话不同，单列一档。
  roles.push({
    id: "dispatch-worker",
    label: "派活工人（池）",
    kind: "dispatch",
    chatKind: "worker",
  });
  return roles;
}

function roleOf(roleId: string | undefined, roles: ContextDefaultRole[]): ContextDefaultRole | null {
  if (!roleId) return roles[0] ?? null;
  return roles.find((role) => role.id === roleId) ?? null;
}

/**
 * 默认开销的完整字段清单（2026-11-16 再修）：用户要在「默认开销」里调试上下文，
 * 不管当前角色是总管 / 执事 / worker，所有已知固定字段都列出来；角色不适用的
 * 字段显示 0 字槽位，而不是整行消失。会变字段（在办 / 印象 / 心情 / 心里话 /
 * 履历）不在这里，仍由「会变的部分」另块提示。
 *
 * 顺序也是页面的顺序：角色人设 → 通用规则 → 执事身份七节 → 岗位契约 → 目标 →
 * 纪律八节 → 表达习惯 / 主动性 → 注入防线 / 当前项目。
 */
export const DEFAULT_SECTION_KEYS = [
  "persona",
  // 关于我（2026-11-19）：全局固定背景，紧跟 persona；worker / 群会话为 0 字槽位。
  "user_profile",
  "verification_iron_law",
  "clarify_contract",
  "partner_soul",
  "partner_voice",
  "partner_values",
  "partner_scenario",
  "partner_skill_index",
  "partner_boundary",
  "partner_contract_scope",
  "partner_contract_decision",
  "partner_contract_acceptance",
  "partner_contract_report",
  "partner_goal",
  "partner_verification",
  "partner_ruling",
  "partner_work_silence",
  "partner_grounding",
  "partner_artifact_handoff",
  "partner_owner_data",
  "partner_brief_card",
  "partner_attention",
  "partner_learning",
  "partner_proactivity",
  "injection_guard",
  "current_project",
  // 2026-11-16 多 CLI：当前派活执行器（新单派给谁 / 模型 / 权限）。
  "delegate_executor",
  // 2026-11-16 C 段：低频工具索引段，排在末尾（缓存前缀变化一次）。
  "tool_index",
] as const;

/**
 * 把当前角色产出的 sections 补齐成完整清单。`skills` 是单独块，不参与字段排序，
 * 仍跟在系统字段后面，让 `contextInspectViewOf` 照原口径把它拎出去。
 */
export function completeDefaultSections(
	sections: Array<{ key: string; text: string }>,
): Array<{ key: string; text: string }> {
	const byKey = new Map(sections.map((section) => [section.key, section.text]));
	const complete: Array<{ key: string; text: string }> = DEFAULT_SECTION_KEYS.map((key) => ({
		key,
		text: byKey.get(key) ?? "",
	}));
	const skills = byKey.get("skills");
	if (skills) complete.push({ key: "skills", text: skills });
	return complete;
}

function sectionText(key: string, text: string | null | undefined): string | null {
  const value = String(text ?? "").trim();
  if (!value) return null;
  // lifecycle 的系统段在真实请求里由 renderSections 包 <key>；默认页也保持同一口径。
  if (key === "partner_identity" || key === "partner_context") return value;
  return `<${key}>\n${value}\n</${key}>`;
}

function providerText(provider: InjectionProvider, ctx: InjectionContext): string | null {
  try {
    return collectInjections([provider], ctx).system[0]?.text ?? null;
  } catch {
    return null;
  }
}

function pushSection(
  sections: Array<{ key: string; text: string }>,
  key: string,
  text: string | null | undefined,
): void {
  const value = sectionText(key, text);
  if (value) sections.push({ key, text: value });
}

/**
 * 原样放进一个字段，**空也保留**：默认页的执事字段与 `pushField` 的空槽位用。
 * 这些字段不是 lifecycle 的 `<key>...</key>` 系统段，真实注入就是原文；
 * 空槽位也列出来，用户才能看见“这个字段现在是 0 字”，而不是整行消失。
 */
function pushRawField(
  sections: Array<{ key: string; text: string }>,
  key: string,
  text: string | null | undefined,
): void {
  sections.push({ key, text: String(text ?? "") });
}

/** 有内容按 lifecycle 的真实包裹口径；空也保留成 0 字槽位。 */
function pushField(
  sections: Array<{ key: string; text: string }>,
  key: string,
  text: string | null | undefined,
): void {
  const value = sectionText(key, text);
  if (value) sections.push({ key, text: value });
  else pushRawField(sections, key, "");
}

/** 技能索引的“人”：普通助手用自己的命名空间（2026-11-21），执事用真实 id，主对话回落 chief。 */
function skillPartnerOfRole(role: ContextDefaultRole): string | null {
  if (!COMPANIONS_ENABLED) return null;
  if (role.kind === "partner") {
    const partnerId = role.id.slice("partner:".length);
    return partnerId || null;
  }
  if (role.kind === "worker" && workerSkillScopeEnabled()) return WORKER_SKILL_OWNER;
  return CHIEF_PARTNER_ID;
}

function buildDefaultSections(
  role: ContextDefaultRole,
  disabled: ReadonlySet<string>,
): Array<{ key: string; text: string }> {
  const sections: Array<{ key: string; text: string }> = [];
  const partnerId = role.kind === "partner" ? role.id.slice("partner:".length) : null;
  const baseCtx = {
    conversationId: 0,
    partnerId,
    // InjectionContext 的 chatKind 只有 chief / worker；执事身份走 partner 分支，
    // 这里给 chief 不会影响只用于 guard / current_project 的调用。
    chatKind: role.kind === "worker" ? ("worker" as const) : ("chief" as const),
    group: false,
    dryRun: true,
  };

  if (role.kind === "partner") {
    const store = partnersStore();
    const partner = store.get(partnerId ?? "");
    if (!partner) return sections;
    const soul = store.readSoulFromHome(partner.id) ?? "";
    // 身份不再合成一个大块：SOUL / 说话方式（口吻）/ 里子 / 处境 / 主人画像 /
    // 技能索引 / 运行边界各成一行；没有内容的也保留 0 字槽位。
    for (const part of renderPartnerIdentityParts(partner, soul)) {
      pushRawField(sections, part.key, part.text);
    }

    // 默认基线不含“当前在办 / 履历 / 活模块”：那些要按会话查任务中心与记忆，
    // 不属于“没有聊天也能知道的固定开销”。
    const turn = buildPartnerTurnContext(partner.id, 0, {
      persona: { currentWork: false, workHistory: false },
      living: null,
    });

    // 按 PartnerTurnContext 的真实字段拆开，不把一段大文本随便切开：
    // 岗位契约四节（CONTRACT.md 固定二级标题）/ 当前目标 / 纪律各自成行。
    // 空节也保留为 0 字槽位：默认页要能看见“缺了什么”，而不是整行消失。
    const contractSections = splitContractSections(turn.contract ?? "");
    for (const name of PARTNER_CONTRACT_SECTIONS) {
      const body = contractSections.get(name)?.trim() ?? "";
      pushRawField(
        sections,
        CONTRACT_FIELD_KEYS[name] ?? "partner_contract",
        body ? `## ${name}\n${body}` : "",
      );
    }
    pushRawField(sections, "partner_goal", turn.goal);
    // 纪律按固定块逐节成字段（2026-11-16 续）：默认页不再合成一个
    // `partner_discipline` 大块，否则人看不出是哪一条效果差、也没法单独改。
    for (const field of turn.disciplineFields) {
      pushRawField(sections, field.id, field.text);
    }
    // 学习 / 主动性也要有槽位：内容再短（甚至 0 字）也按顺序显示，
    // 不再因为“有内容才 push”把它们藏掉。
    pushRawField(sections, "partner_learning", turn.learning);
    pushRawField(sections, "partner_proactivity", turn.proactivity);
  } else {
    pushField(
      sections,
      "persona",
      // 2026-11-16：默认开销页看到的是 worker 人设的当前值（每轮现读，同一份全局文件）。
      // 2026-11-22：会话里实际多拼一句工具提示（WORKER_PERSONA_CHAT_TOOLS），基线页也要算进去，
      // 否则默认开销比真实请求少一截、还让人以为句是"凭空多出来的"。
      role.kind === "worker"
        ? readWorkerPersona() + WORKER_PERSONA_CHAT_TOOLS
        : resolvePersona(partnersStore, PERSONA),
    );
    pushField(sections, "verification_iron_law", providerText(verificationIronLawProvider, baseCtx));
    // 开工前问清只给总管；worker 没有这个字段，不造 0 字槽位（避免把“不适用”误读成“空”）。
    if (role.kind === "chief") {
      pushField(sections, "clarify_contract", providerText(clarifyContractProvider, baseCtx));
    }
  }

  // 关于我（2026-11-19）：与真实装配走同一个 provider；执事看自己的开关，总管回落 chief，
  // worker 由 provider 直接跳过（这里仍保留 0 字槽位，页面能看见"这个角色不读"）。
  pushField(sections, "user_profile", providerText(userProfileProvider, baseCtx));

  pushField(sections, "injection_guard", providerText(guardProvider, baseCtx));
  pushField(sections, "current_project", providerText(currentProjectProvider, baseCtx));
  // 当前派活执行器（2026-11-16）：与 live 系统提示同一行；默认开销页也要能看见。
  pushSection(sections, "delegate_executor", CHANCELLOR_ENABLED ? executorLine() : null);

  // 低频工具索引（C 段）：算进默认基线，让默认开销页看到"新会话初始会读到什么"。
  // 工具面本身仍不含 deferred（defaultTools 过滤），这里只是把索引段的字节数记进来。
  // chief / partner / worker 工具面本来就一样，只有 disabledTools 勾选差异。
  //（AGENT_TOOL_INDEX 回滚开关 2026-11-21 退役，索引段恒渲染——名单空则整段省略。）
  {
    const deferred = modelToolCatalog()
      .filter((tool) => tool.deferred === true && !disabled.has(tool.name))
      .map((tool) => ({ name: tool.name, description: tool.description }));
    pushSection(sections, "tool_index", toolIndexText(deferred));
  }

  const skills = skillStore?.previewIndex?.(skillPartnerOfRole(role)) ?? null;
  pushSection(sections, "skills", skills);
  return sections;
}

/**
 * 默认页的工具面按这个角色对应的人设勾选过滤（2026-11-16 工具裁剪 B）：
 * chief → 总管行、partner → 该执事行、worker → 不过滤。开关关 / 读执事库失败 → 不过滤，
 * 别让一个目录故障把整页打成 503。目的：默认开销页看到的就是这个人真实能看到的工具面。
 */
function disabledToolsOfRole(role: ContextDefaultRole): Set<string> {
  if (!partnerToolsEnabled() || role.kind === "worker" || role.kind === "dispatch") {
    return new Set();
  }
  try {
    const row =
      role.kind === "chief"
        ? partnersStore().get(CHIEF_PARTNER_ID)
        : partnersStore().get(role.id.slice("partner:".length));
    return new Set(row?.disabledTools ?? []);
  } catch {
    return new Set();
  }
}

function defaultTools(disabled: ReadonlySet<string> = new Set()): ToolRegistration[] {
  const pool: readonly ToolRegistration[] = [
    ...(CodingTools.tools ?? []),
    ...(lifediaryExt?.tools ?? []),
  ];
  const seen = new Set<string>();
  const tools: ToolRegistration[] = [];
  for (const tool of pool) {
    if (tool.deferred === true) continue; // 初始前缀里不会出现的延迟工具，不算默认开销。
    if (disabled.has(tool.name)) continue; // 人设页取消勾选的工具，这个人的默认面也看不到。
    if (seen.has(tool.name)) continue;
    seen.add(tool.name);
    tools.push(tool);
  }
  return tools;
}

/** 派活工人（池）预览用的占位文本：真实单子由拆单器写入，这里只显示段结构。 */
const DISPATCH_PLACEHOLDER_TASK = "（任务要求：由拆单器写入）";
const DISPATCH_PLACEHOLDER_DONE = "（完成标准：由拆单器写入）";

/**
 * 派活工人（池）的默认上下文（2026-11-22 注入页预览）。
 *
 * 与 `pool/task-profile.ts` 的 `buildTaskProfileSections` 同源：固定段顺序、人设段、
 * 交付契约、工作边界都取真实实现；任务/项目记忆/前置任务用占位或 0 字槽位。
 * 这样设置页看到的不是手抄的第二份清单，而是池进程真正会读到的那几段。
 */
function buildDispatchSections(): Array<{ key: string; text: string }> {
  const persona = readWorkerPersona();
  const taskSections = buildTaskProfileSections({
    persona,
    instruction: DISPATCH_PLACEHOLDER_TASK,
    doneWhen: DISPATCH_PLACEHOLDER_DONE,
    taskDir: "<任务目录>",
    workDir: "<工作目录>",
    writes: [],
  });
  const byKey = new Map<string, string>(
    taskSections.map((section) => [section.key, section.text]),
  );
  // 固定顺序；project_memory / upstream 即使预览里没有内容也保留 0 字槽位，
  // 用户才知道“这两段存在、只是这单没有”。
  const order = [
    "worker_rules",
    "injection_guard",
    "verification_iron_law",
    "persona",
    "task",
    "project_memory",
    "upstream",
    "delivery_contract",
    "boundary",
  ];
  return order
    .filter((key) => byKey.has(key) || key === "project_memory" || key === "upstream")
    .map((key) => {
      // persona 只展示可编辑的正文；「## 你是谁」标题与冲突说明是固定的代码包装，
      // 不塞进 text——否则用户在上下文页保存会把包装写回 worker-persona.md。
      const raw = key === "persona" ? persona : (byKey.get(key) ?? "");
      return { key, text: sectionText(key, raw) ?? "" };
    });
}

/** 池工人实际可用的五件（按 worker-tools 当前勾选过滤；escalate 恒开）。 */
function dispatchTools(): ToolRegistration[] {
  try {
    const payload = workerToolsPayload();
    const allowed = new Set([
      ...payload.granted,
      ...(payload.escalate ? ["escalate"] : []),
    ]);
    return poolToolCatalog().filter((tool) => allowed.has(tool.name));
  } catch {
    // 读配置失败：显示完整五件，不把设置页打成 503。
    return poolToolCatalog();
  }
}

function defaultView(
  sections: Array<{ key: string; text: string }>,
  tools: ToolRegistration[],
): ContextView {
  const sectionMap: Record<string, string> = {};
  for (const section of sections) sectionMap[section.key] = section.text;
  const message: SystemMessage = {
    role: "system",
    content: "",
    ...(Object.keys(sectionMap).length ? { sections: sectionMap } : {}),
    ...(tools.length ? { toolsAdded: tools as Tool[] } : {}),
    timestamp: 0,
  };
  const messages: Message[] = [message];
  return {
    head: undefined,
    entries: [],
    contributions: [],
    messages,
  };
}

/**
 * 一份默认开销。`roleId` 为空 = 总管；未知角色返回 null（路由 404）。
 * 工具需要打开 harness 取真实 extension；失败向上抛，由路由转 503。
 */
export async function contextDefaultPayload(
  roleId?: string,
): Promise<ContextDefaultPayload | null> {
  const roles = contextDefaultRoles();
  const role = roleOf(roleId, roles);
  if (!role) return null;

  const isDispatch = role.kind === "dispatch";
  // 池工人预览不依赖宿主 Harness：段与工具都从池自己的 profile 取。
  if (!isDispatch) await getHarness();
  const disabled = disabledToolsOfRole(role);
  const tools = isDispatch ? dispatchTools() : defaultTools(disabled);
  const sections = isDispatch
    ? buildDispatchSections()
    : completeDefaultSections(buildDefaultSections(role, disabled));
  const view = defaultView(sections, tools);
  const payload = contextInspectPayloadOf({
    conversationId: "",
    title: role.label,
    chatKind: role.chatKind,
    usage: null,
    view,
    memoryEnabled: isDispatch ? false : Boolean(memoryEngine),
    lastInjections: null,
  });
  return {
    ...payload,
    default: true,
    role,
    roles,
  };
}
