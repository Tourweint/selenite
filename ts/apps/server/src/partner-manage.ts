import {
	archiveManager,
	DOMAIN_PATTERN,
	ensureManager,
} from "../../../../../chancellor/src/manager/registry.ts";
import { chancellorWorkRoot } from "./delegation.ts";
import {
	delegationSoulSeed,
	partnersStore,
	type PartnerRow,
	type PartnersStore,
} from "./partners.ts";

/**
 * 执事（chancellor 分管宰相）的建 / 停 / 列（批次D D3）。
 *
 * 这里的函数是**唯一的核心实现**：HTTP 端点（companion-api.ts）与模型侧工具
 * （tools.ts 的 partner_manage）都调它，避免"端点一套、工具一套"漂移。
 * 端点对外形状（400/201/404 的消息）由调用方映射，不在这里掺 HTTP 语义。
 *
 * 存储与 chancellor 工作根通过 `MinisterContext` 注入：生产用 `defaultMinisterContext()`
 * （全局 partnersStore + chancellorWorkRoot），单测传临时目录，不碰真实 .data/。
 */

export interface MinisterContext {
	store: PartnersStore;
	workRoot: string;
}

export function defaultMinisterContext(): MinisterContext {
	return { store: partnersStore(), workRoot: chancellorWorkRoot() };
}

export type MinisterResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: string };

/** 与 D2 端点逐字一致的 domain 校验文案，端点/工具共用一份。 */
const DOMAIN_ERROR =
	"domain 必须是小写 ASCII（小写字母、数字、连字符，不能以连字符开头或结尾）";

export interface CreateMinisterInput {
	name: string;
	/**
	 * 领域标签（2026-11-07 起可选）。
	 *
	 * 语义降级：它不再是派活路由键，只是"这个执事负责哪块"的备注。
	 * 留空 = 不绑定 chancellor 分管目录、不参与分管派单（等同普通执事）；
	 * 填了仍会建 `managers/<domain>/` 并保留原有兼容行为。
	 */
	domain?: string;
	/** create 可选：一句话身份；缺省用 delegationSoulSeed 播种。 */
	soul?: string;
}

/**
 * 建一个执事（带 domain 的 D2 路径）：校验 → 建档案（SOUL 播种 + delegation 链接）
 * → 建宰相目录并透记 partner_id；任一步失败都回滚档案，返回可映射成 400 的 error。
 *
 * 与 companion-api POST 的「带 domain」分支等价：name≤40、domain 合法、重复 domain、
 * ensureManager 失败回滚，消息逐字保留，端点对外形状零变化。
 */
export function createMinisterPartner(
	input: CreateMinisterInput,
	ctx: MinisterContext = defaultMinisterContext(),
): MinisterResult<PartnerRow> {
	const { store, workRoot } = ctx;
	const { name } = input;
	const domain = input.domain?.trim() ?? "";
	if (!name || name.length > 40) return { ok: false, error: "name 必填且不超过 40 字" };
	// 留空 = 普通执事（不带分管目录）。这是 2026-11-07 的语义降级：
	// 领域从"必填路由键"变成"可选标签"，所以这里允许空串直接落库。
	if (domain) {
		if (!DOMAIN_PATTERN.test(domain)) return { ok: false, error: DOMAIN_ERROR };
		if (store.partnerIdByDomain(domain)) {
			return { ok: false, error: `domain「${domain}」已被其他执事占用` };
		}
	}
	const soulSeed = input.soul?.trim() || delegationSoulSeed(name, domain);
	const partner = store.create(name, domain ? { domain, soulSeed } : { soulSeed });
	if (!domain) return { ok: true, value: partner };
	try {
		// 宿主建宰相目录并透记 partner_id；chancellor 只存不解读。
		ensureManager(workRoot, domain, { partnerId: partner.id });
	} catch (error) {
		// 宰相目录没建成就别留半个执事：回滚刚建的档案。
		store.delete(partner.id);
		const detail = error instanceof Error ? error.message : String(error);
		return { ok: false, error: `建执事失败：${detail}` };
	}
	return { ok: true, value: partner };
}

/**
 * 停一个执事：执事先把 chancellor 领域目录归档（改名 .archived-，runs 历史保留），
 * 再删档案（+版本+链接+家目录）。普通执事（无 domain）行为不变，不碰 chancellor。
 * 归档失败只告警、不挡档案删除（与 D2 端点一致）。
 */
export function stopMinisterPartner(
	partnerId: string,
	ctx: MinisterContext = defaultMinisterContext(),
): { ok: true } | { ok: false; error: "not_found" } {
	const { store, workRoot } = ctx;
	const partner = store.get(partnerId);
	if (!partner) return { ok: false, error: "not_found" };
	if (partner.domain) {
		try {
			archiveManager(workRoot, partner.domain);
		} catch (error) {
			console.warn(
				`[partners] 归档领域 ${partner.domain} 失败：${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	if (!store.delete(partnerId)) return { ok: false, error: "not_found" };
	return { ok: true };
}

/** 对外投影：只给名字 / domain / 状态 / 派发权；不带内部会话 id，也不回显执事 uuid。 */
export interface MinisterProjection {
	name: string;
	domain: string;
	status: string;
	/** 派发权（2026-11-06）：是否作为分管负责人接单。 */
	dispatchAuthority: boolean;
}

/**
 * 列出全部执事（带 domain 的 partner）。`filterPartnerId` 可选：只留该 id 的执事。
 */
export function listMinisterPartners(
	ctx: MinisterContext = defaultMinisterContext(),
	filterPartnerId?: string,
): MinisterProjection[] {
	const { store } = ctx;
	return store
		.list()
		.filter((partner) => partner.domain !== null)
		.filter((partner) => !filterPartnerId || partner.id === filterPartnerId)
		.map((partner) => ({
			name: partner.name,
			domain: partner.domain as string,
			status: partner.status,
			dispatchAuthority: partner.dispatchAuthority,
		}));
}

/**
 * 切换执事派发权（2026-11-06 执事派发权开关）。核心实现：HTTP 端点（PATCH body）与
 * partner_manage 工具（set_dispatch）共用。只对带 domain 的执事有意义；
 * 普通执事返回可映射成 400 的 error。立即生效：派单时实时查库，无缓存。
 */
export function setMinisterDispatchAuthority(
	partnerId: string,
	enabled: boolean,
	ctx: MinisterContext = defaultMinisterContext(),
): MinisterResult<PartnerRow> {
	const partner = ctx.store.get(partnerId);
	if (!partner || !partner.domain) {
		return { ok: false, error: "找不到该执事（只能切带 domain 的执事的派发权）" };
	}
	const updated = ctx.store.setDispatchAuthority(partnerId, enabled);
	if (!updated) return { ok: false, error: "找不到该执事" };
	return { ok: true, value: updated };
}
