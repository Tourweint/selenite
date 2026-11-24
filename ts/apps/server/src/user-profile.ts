/**
 * 关于我（2026-11-19）：全局一份、每轮固定注入的主人档案。
 *
 * 与记忆分层的硬边界：**不进记忆库、不参与召回打分、不衰减、不进整理/拆分**。
 * 它解决的是"每轮都必须在"的固定背景（称呼、输入习惯、说话禁忌），
 * 而不是"说到才想起"的记忆。方案见 `docs/设计方案/2026-11-19-关于我（全局固定注入）.md`。
 *
 * 落点 `.data/user-profile.md`（纯文本，原子写，≤8192 字节；`USER_PROFILE_PATH` 覆盖）。
 * 空文件 / 空串 = 不注入。每轮现读，改完下一轮生效。
 * `USER_PROFILE_ENABLED=false/0/off` = 整段不注入、端点只读（回滚用）。
 *
 * 每 Agent 的读取开关住在 `partners.user_profile_read`（1 / NULL = 读，0 = 不读）：
 * 默认读，普通 worker 会话与派活工人固定不读（不设开关）。
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Hono } from "hono";
import { flagEnabled } from "./flags.ts";
import { CHIEF_PARTNER_ID, partnersStore } from "./partners.ts";

/** 正文字节上限（UTF-8 计）：这是每轮固定前缀，不能让"关于我"长成第二份记忆。 */
export const USER_PROFILE_LIMIT = 8192;

/** 注入段落头：只当背景，不当指令；不要逐条复述。 */
export const USER_PROFILE_SECTION_HEADER =
	"【关于我】（主人自己写的长期背景；只用来理解他的习惯与偏好，不要逐条复述，也不要当成这一轮的任务）";

export function userProfileEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return flagEnabled("USER_PROFILE_ENABLED", env);
}

export function userProfilePath(env: NodeJS.ProcessEnv = process.env): string {
	return env.USER_PROFILE_PATH?.trim() || ".data/user-profile.md";
}

/** 文件优先；不存在 / 空 / 读失败 → 空串（= 不注入）。 */
export function readUserProfile(env: NodeJS.ProcessEnv = process.env): string {
	try {
		return readFileSync(userProfilePath(env), "utf8").trim();
	} catch {
		return "";
	}
}

/** trim 后空 = 删文件；否则临时文件 + rename 原子写，超限抛错。 */
export function writeUserProfile(text: string, env: NodeJS.ProcessEnv = process.env): void {
	const path = userProfilePath(env);
	const content = String(text ?? "").trim();
	if (!content) {
		rmSync(path, { force: true });
		return;
	}
	const bytes = Buffer.byteLength(content, "utf8");
	if (bytes > USER_PROFILE_LIMIT) {
		throw new Error(`「偏好」超过 ${USER_PROFILE_LIMIT} 字节上限（当前 ${bytes}）`);
	}
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, content, "utf8");
	try {
		renameSync(tmp, path);
	} catch (error) {
		rmSync(tmp, { force: true });
		throw error;
	}
}

/** 注入正文：头 + 内容；内容空 → undefined（整段不出现）。 */
export function renderUserProfileSection(content: string): string | undefined {
	const body = String(content ?? "").trim();
	if (!body) return undefined;
	return `${USER_PROFILE_SECTION_HEADER}\n${body}`;
}

export interface UserProfileAgentView {
	id: string;
	name: string;
	kind: "chief" | "partner";
	read: boolean;
}

/** GET / 写回共用的「谁读」列表：总管在前，其余按档案创建顺序；归档的不列。 */
export interface UserProfileStoreLike {
	list(): Array<{ id: string; name: string; status: string; userProfileRead?: boolean }>;
}

export function userProfileAgentsOf(store: UserProfileStoreLike): UserProfileAgentView[] {
	const rows = store.list().filter((row) => row.status !== "archived");
	return rows
		.map((row) => ({
			id: row.id,
			name: row.name,
			kind: row.id === CHIEF_PARTNER_ID ? ("chief" as const) : ("partner" as const),
			read: row.userProfileRead !== false,
		}))
		.sort((left, right) => {
			if (left.kind !== right.kind) return left.kind === "chief" ? -1 : 1;
			return 0;
		});
}

export interface UserProfilePayload {
	ok: true;
	enabled: boolean;
	editable: boolean;
	content: string;
	chars: number;
	limit: number;
	agents: UserProfileAgentView[];
	/** 固定 false：普通 worker 会话与派活工人不读，没有开关。 */
	workerReads: false;
}

/**
 * 响应投影。`store` 只给单测用；生产不传 = 读 partners 当前列表。
 * 读执事库失败不让整页 503：agents 退空数组，正文照常可编辑。
 */
export function userProfilePayload(
	env: NodeJS.ProcessEnv = process.env,
	store?: UserProfileStoreLike | null,
): UserProfilePayload {
	const content = readUserProfile(env);
	let agents: UserProfileAgentView[] = [];
	try {
		const source = store ?? partnersStore();
		agents = userProfileAgentsOf(source);
	} catch {
		agents = [];
	}
	const enabled = userProfileEnabled(env);
	return {
		ok: true,
		enabled,
		editable: enabled,
		content,
		chars: content.length,
		limit: USER_PROFILE_LIMIT,
		agents,
		workerReads: false,
	};
}

/**
 * 端点挂载：与 worker-persona / tool-pool 同款，由 index.ts 挂在 `/api/v1/*` 中间件之后。
 * 拆成挂载函数是为了 HTTP 断言能真起 Hono 路由，不 import index.ts（它会 serve 活端口）。
 */
export function mountUserProfileRoutes(app: Hono): void {
	app.get("/api/v1/agent/user-profile", (c) => {
		c.header("cache-control", "no-store");
		return c.json(userProfilePayload());
	});

	app.put("/api/v1/agent/user-profile", async (c) => {
		const body = (await c.req.json().catch(() => null)) as { content?: unknown } | null;
		if (!body || typeof body.content !== "string") {
			return c.json({ error: "bad_request", message: "content 必须是字符串" }, 400);
		}
		if (!userProfileEnabled()) {
			return c.json(
				{ error: "bad_request", message: "「偏好」已关闭（USER_PROFILE_ENABLED=false）" },
				400,
			);
		}
		const content = body.content.trim();
		if (Buffer.byteLength(content, "utf8") > USER_PROFILE_LIMIT) {
			return c.json(
				{ error: "bad_request", message: `content 超过 ${USER_PROFILE_LIMIT} 字节上限` },
				400,
			);
		}
		writeUserProfile(content);
		c.header("cache-control", "no-store");
		return c.json(userProfilePayload());
	});

	app.put("/api/v1/agent/user-profile/agents/:id", async (c) => {
		const id = c.req.param("id");
		if (id === "worker") {
			return c.json(
				{ error: "bad_request", message: "普通 worker 不读「偏好」，没有开关" },
				400,
			);
		}
		const body = (await c.req.json().catch(() => null)) as { read?: unknown } | null;
		if (!body || typeof body.read !== "boolean") {
			return c.json({ error: "bad_request", message: "read 必须是布尔值" }, 400);
		}
		if (!userProfileEnabled()) {
			return c.json(
				{ error: "bad_request", message: "「偏好」已关闭（USER_PROFILE_ENABLED=false）" },
				400,
			);
		}
		const store = partnersStore();
		if (!store.get(id)) {
			return c.json({ error: "not_found", message: "这个 Agent 不存在" }, 404);
		}
		store.setUserProfileRead(id, body.read);
		c.header("cache-control", "no-store");
		return c.json(userProfilePayload());
	});
}
