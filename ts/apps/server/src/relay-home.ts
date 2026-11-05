import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { externalChatIds, openChat, renameChat, sayInConversation } from "./agent.ts";
import { RelayInvokeError, type RelayClient } from "./relay-client.ts";
import { companionHomeEnabled } from "./relay-config.ts";

/**
 * 执事认主机底座（2026-11-05 多端同步方案块3，阶段三）。
 *
 * 这是**归属与路由的底座**，不是执事本身——执事的档案/记忆/例行任务是
 * 施工蓝图批次B 的事；B 落地后把 partners.actorId 对到这里的路由表即可。
 *
 * 职责（照抄 cindy 的 CAS + 降级纪律，方案 §四阶段三）：
 * - 认主机：CAS 抢占（expected 不符时中继带回实际值，绝不盲抢）；
 * - 降级：不是主机的副本不发送、不领取（ demoted 标记 + 发送守卫）；
 * - 换家顺序：先写中继路由表 → 再动本机；失败保持降级；
 * - 凭证不随行：执事在本机跑就用本机 env 的 key，档案/记忆的迁移归批次B。
 *
 * 回滚开关：COMPANION_HOME_ENABLED=false（默认）→ 端点 404、不校准、不占位。
 */

const STORE_PATH =
	process.env.COMPANION_HOMES_PATH?.trim() || ".data/companion-homes.json";
const DEMOTION_CHECK_MS = 60_000;

interface CompanionRow {
	actorId: string;
	name: string;
	/** 专线会话（对外 uuid）；首次发消息时惰性建 */
	conversationId: string | null;
	demoted: boolean;
	updatedAt: number;
}

class CompanionHomeStore {
	private rows = new Map<string, CompanionRow>();
	private loaded = false;

	private load(): void {
		if (this.loaded) return;
		this.loaded = true;
		try {
			if (!existsSync(STORE_PATH)) return;
			const parsed = JSON.parse(readFileSync(STORE_PATH, "utf8")) as { rows?: CompanionRow[] };
			for (const row of parsed.rows ?? []) this.rows.set(row.actorId, row);
		} catch {
			// 坏文件当空表：归属仲裁在中继，本机只是缓存
		}
	}

	private save(): void {
		mkdirSync(dirname(STORE_PATH), { recursive: true });
		const tmp = `${STORE_PATH}.tmp`;
		writeFileSync(tmp, JSON.stringify({ rows: [...this.rows.values()] }, null, 2), "utf8");
		renameSync(tmp, STORE_PATH);
	}

	get(actorId: string): CompanionRow | null {
		this.load();
		return this.rows.get(actorId) ?? null;
	}

	put(row: CompanionRow): void {
		this.load();
		this.rows.set(row.actorId, row);
		this.save();
	}

	list(): CompanionRow[] {
		this.load();
		return [...this.rows.values()];
	}
}

export interface CompanionHomeStatus {
	selfDeviceId: string | null;
	actors: Array<{
		actorId: string;
		name: string;
		conversationId: string | null;
		demoted: boolean;
		homeDeviceId: string | null;
		isHome: boolean;
	}>;
}

export function companionHomeController(client: RelayClient) {
	const store = new CompanionHomeStore();

	/** 与中继路由表对齐本机降级位（重连后与周期性调用）。 */
	async function ensureDemotion(): Promise<void> {
		if (!companionHomeEnabled()) return;
		if (!client.connected || !client.selfDeviceId) return;
		let actors: Array<{ actorId: string; homeDeviceId: string | null }> = [];
		try {
			const meta = (await client.meta("actors", {})) as { actors?: typeof actors };
			actors = meta.actors ?? [];
		} catch {
			return; // 中继暂时问不到：保持现状，下个周期再对
		}
		const self = client.selfDeviceId;
		for (const row of store.list()) {
			const remote = actors.find((actor) => actor.actorId === row.actorId);
			if (!remote) continue; // 路由表里没有它（可能被清了）：本机不动，等中继为准
			const isHome = remote.homeDeviceId === self;
			if (isHome === row.demoted) {
				store.put({ ...row, demoted: !isHome, updatedAt: Date.now() });
				if (!isHome) {
					console.log(`[home] 执事 ${row.name} 的主机不在这台设备，本地副本已降级`);
				}
			}
		}
	}

	return {
		/** 状态查询（HTTP）。远程实际主机位一并带出。 */
		async status(): Promise<CompanionHomeStatus> {
			const self = client.connected ? client.selfDeviceId : null;
			let remote: Record<string, string | null> = {};
			try {
				const meta = (await client.meta("actors", {})) as { actors?: Array<{ actorId: string; homeDeviceId: string | null }> };
				remote = Object.fromEntries((meta.actors ?? []).map((actor) => [actor.actorId, actor.homeDeviceId]));
			} catch {
				/* 中继不可达：只报本机缓存 */
			}
			return {
				selfDeviceId: self,
				actors: store.list().map((row) => ({
					actorId: row.actorId,
					name: row.name,
					conversationId: row.conversationId,
					demoted: row.demoted,
					homeDeviceId: remote[row.actorId] ?? null,
					isHome: self !== null && remote[row.actorId] === self,
				})),
			};
		},

		/** 新建执事并抢占主机位（expected=null，先到先得）。 */
		async create(name: string): Promise<{ actorId: string; homeDeviceId: string }> {
			if (!client.connected || !client.selfDeviceId) {
				throw new RelayInvokeError("device_offline", "中继未连接，不能创建执事");
			}
			const actorId = randomUUID();
			const claim = (await client.meta("actor-claim", {
				actorId,
				name,
				expectedHomeDeviceId: null,
			})) as { ok: boolean; homeDeviceId?: string; code?: string };
			if (!claim.ok) throw new RelayInvokeError("internal", "新建执事的空位抢占失败（理论上不可能）");
			store.put({
				actorId,
				name: name.trim().slice(0, 40) || "执事",
				conversationId: null,
				demoted: false,
				updatedAt: Date.now(),
			});
			return { actorId, homeDeviceId: claim.homeDeviceId! };
		},

		/** 换家到本机：先读实际值再 CAS（照抄 cindy takeOver 顺序）。
		 * 本机没有档案行也能接管——归属与名字以中继路由表为准（cindy 语义：
		 * "在这台电脑继续"不要求本地曾有副本；档案/记忆的随行归批次B）。 */
		async takeover(actorId: string): Promise<{ homeDeviceId: string }> {
			if (!client.connected || !client.selfDeviceId) {
				throw new RelayInvokeError("device_offline", "中继未连接，不能换家");
			}
			const home = (await client.meta("actor-home", { actorId })) as {
				homeDeviceId: string | null;
				name?: string | null;
			};
			if (!home.name && !store.get(actorId)) {
				throw new RelayInvokeError("bad_request", "这个执事不存在（中继路由表里没有）");
			}
			const claim = (await client.meta("actor-claim", {
				actorId,
				name: store.get(actorId)?.name ?? home.name ?? "",
				expectedHomeDeviceId: home.homeDeviceId ?? null,
			})) as { ok: boolean; homeDeviceId?: string; code?: string; homeDeviceId2?: string };
			if (!claim.ok) {
				throw new RelayInvokeError(
					"internal",
					`换家冲突：主机刚被别的设备改成 ${(claim as unknown as { homeDeviceId?: string }).homeDeviceId ?? "未知"}，重读后再试`,
				);
			}
			// 先写中继（已成功）→ 再动本机：本机解除降级；本地曾有副本则保留其专线会话
			const existing = store.get(actorId);
			store.put({
				actorId,
				name: existing?.name ?? (home.name ?? "执事").slice(0, 40),
				conversationId: existing?.conversationId ?? null,
				demoted: false,
				updatedAt: Date.now(),
			});
			return { homeDeviceId: claim.homeDeviceId! };
		},

		/** 给执事的专线会话说话。降级/非主机一律拒绝（fail-closed）。 */
		async sendMessage(actorId: string, text: string): Promise<{ accepted: boolean; conversationId: string }> {
			const row = store.get(actorId);
			if (!row) throw new RelayInvokeError("bad_request", "本机没有这个执事");
			if (row.demoted) {
				throw new RelayInvokeError("remote_disabled", "这台设备不是该执事的主机（已降级），去主机上发");
			}
			if (!client.connected || !client.selfDeviceId) {
				throw new RelayInvokeError("device_offline", "中继未连接");
			}
			// 双保险：以中继为准再核一次（本机缓存可能滞后）
			const home = (await client.meta("actor-home", { actorId })) as { homeDeviceId: string | null };
			if (home.homeDeviceId !== client.selfDeviceId) {
				store.put({ ...row, demoted: true, updatedAt: Date.now() });
				throw new RelayInvokeError("remote_disabled", "这台设备不是该执事的主机（以中继为准），去主机上发");
			}
			let conversationId = row.conversationId;
			if (!conversationId) {
				const chat = await openChat(undefined);
				if (!chat) throw new RelayInvokeError("internal", "本机没有可用的模型配置");
				conversationId = chat.externalId;
				void renameChat(conversationId, `执事 ${row.name}`);
				store.put({ ...row, conversationId, updatedAt: Date.now() });
			}
			// sayInConversation 吃内部自增 id；uuid → 内部 id 反查
			let internalId: number | null = null;
			for (const [internal, external] of await externalChatIds()) {
				if (external === conversationId) internalId = internal;
			}
			if (internalId === null) throw new RelayInvokeError("internal", "专线会话映射丢失");
			const accepted = await sayInConversation(internalId, text);
			if (!accepted) throw new RelayInvokeError("internal", "专线会话不存在");
			return { accepted: true, conversationId };
		},

		/** chat/send 通道守卫：会话若是**已降级执事**的专线，拒绝代发。 */
		async chatSendGuard(conversationId: string): Promise<string | null> {
			for (const row of store.list()) {
				if (row.conversationId === conversationId && row.demoted) {
					return `会话属于执事「${row.name}」，但它的主机不在这台设备（已降级）`;
				}
			}
			return null;
		},

		ensureDemotion,

		/** 周期校准（index.ts 接线用）。 */
		startPeriodicCheck(): void {
			const timer = setInterval(() => void ensureDemotion(), DEMOTION_CHECK_MS);
			timer.unref?.();
		},
	};
}

export type CompanionHomeController = ReturnType<typeof companionHomeController>;
