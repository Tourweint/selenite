/** partners.ts */

/* 2026-11-13 按职责整段切到同目录的多个文件；本文件只做 re-export，保持原路径的导入方零改动。 */

export { CHIEF_PARTNER_ID, COMPANIONS_ENABLED, PARTNER_CONTRACT_DECISION_DEFAULTS, PARTNER_CONTRACT_SECTIONS, PARTNER_SLOT_LIMIT, chiefPartnerEnabled, chiefSkillsDir, partnerContractEnabled, partnerDisciplineEditEnabled, partnerContractTemplate, partnerProjectMemoryEnabled } from "./partner-contract.ts";
export type { GroupMessageRow, GroupResponderKind, GroupRow, ModelChainItemLike, PartnerRow, PartnerSessionLinkRow, PartnerStatus, RoutineDef, RoutineTrigger, RoutineTriggerGates } from "./partner-types.ts";
export { PartnersStore } from "./partner-store.ts";
export { chiefSoul, effectivePartnerIdOfSession, ensureChiefPartner, partnersStore, resolvePartnerScope, resolvePersona } from "./partner-rows.ts";
export { delegationSoulSeed, ministerDispatchAllowed, ministerDispatchMasterEnabled, partnerIdentityForDomain } from "./partner-api.ts";
