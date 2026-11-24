/**
 * 注入 → 上下文：可编辑段的就地编辑（2026-11-21）
 *
 * 这一页只借「注入」这一个入口，保存仍然写回各自的源头，不新造统一存储：
 * - 人设（总管 SOUL / worker 人设 / 执事 SOUL）→ PATCH /partners/:id 或 PUT /agent/worker-persona
 * - 关于我 → PUT /agent/user-profile
 * - 岗位契约 → PUT /partners/:id/contract（整份四节一起写）
 * - 当前目标 → PATCH /partners/:id { currentGoal }
 * - 纪律七节 → GET/PUT /partners/:id/discipline（只合并当前这一节）
 *
 * 边界：
 * - 代码固定段（验证铁律 / 开工前问清 / 注入防线 / 派活执行器 / 低频工具索引）没有编辑入口。
 * - `current_project` 由会话所属项目派生，不在这里改。
 * - 记忆正文不是这里改的：索引页只提供「标过时 / 删除」，抽取出来的正文不改写。
 * - 保存后只重拉这一页；按会话冻结的段（技能索引 / 当前项目）要到新会话才变。
 */

import { esc } from "./markdown.js";
import { request } from "./net.js";
import { closeModal, openModal, toast } from "./ui-atoms.js";

/** 纪律七节：key → DISCIPLINE.md 里的固定二级标题。红线不在里面（宿主固定）。 */
const DISCIPLINE_TITLE_BY_KEY = {
	partner_verification: "验证铁律",
	partner_ruling: "裁决纪律",
	partner_work_silence: "干活期间",
	partner_grounding: "答案接地",
	partner_artifact_handoff: "产物交接",
	partner_brief_card: "汇报卡",
	partner_attention: "提问纪律",
};

/**
 * 普通助手会话的 persona 段在默认页会拼上这句工具提示（服务端 `WORKER_PERSONA_CHAT_TOOLS`）。
 * 它不在 `.data/worker-persona.md` 里；从上下文页保存时先剥掉，避免把提示写进人设文件。
 * 改这句时与服务端 `worker-persona.ts` 同步。
 */
const WORKER_CHAT_TOOLS_HINT =
	"需要长期记住的事用 remember；想不起对方说过什么用 recall；要定时提醒用 set_reminder。";

const CONTRACT_TITLES = {
	partner_contract_scope: "职责范围",
	partner_contract_decision: "决策分级",
	partner_contract_acceptance: "验收标准",
	partner_contract_report: "汇报对象",
};

function unwrapTag(text, key) {
	const raw = String(text ?? "").trim();
	const open = `<${key}>`;
	const close = `</${key}>`;
	if (raw.startsWith(open) && raw.endsWith(close)) return raw.slice(open.length, -close.length).trim();
	return raw;
}

function stripPrefix(text, prefix) {
	const raw = String(text ?? "").trim();
	return raw.startsWith(prefix) ? raw.slice(prefix.length).trim() : raw;
}

/** 契约 / 纪律源文件按固定二级标题切；空节保留（空 = 不注入这一条）。 */
function parseSections(source) {
	const map = new Map();
	let current = null;
	let buffer = [];
	const flush = () => {
		if (!current) return;
		map.set(current, buffer.join("\n").trim());
		buffer = [];
	};
	for (const line of String(source ?? "").split(/\r?\n/)) {
		const heading = /^##\s+(.+?)\s*$/.exec(line);
		if (heading) {
			flush();
			current = heading[1] || null;
			continue;
		}
		if (current) buffer.push(line);
	}
	flush();
	return map;
}

function serializeSections(map) {
	return [...map.entries()]
		.map(([title, body]) => (body.trim() ? `## ${title}\n${body.trim()}` : `## ${title}\n`))
		.join("\n\n");
}

async function readJson(response) {
	const data = await response.json().catch(() => null);
	if (!response.ok || !data || data.ok === false) {
		throw new Error(data?.message || data?.error || `HTTP ${response.status}`);
	}
	return data;
}

/**
 * 这一节写回哪里。返回 null = 不支持就地改（代码固定 / 派生字段）。
 * `needsLoad` 的 target 在弹层里异步取当前值（契约要整份、纪律要合并覆盖）。
 */
function resolveTarget({ key, text, roleId, partnerId }) {
	if (key === "persona") {
		if (roleId === "worker" || roleId === "dispatch-worker") {
			const raw = unwrapTag(text, "persona");
			return {
				kind: "worker-persona",
				title: roleId === "dispatch-worker" ? "派活工人人设" : "普通 worker 人设",
				note:
					roleId === "dispatch-worker"
						? "派活工人与普通助手共用这一份人设；保存后下一单生效。"
						: "所有普通 worker 共用这一份；保存后下一轮生效。",
				value:
					roleId === "worker"
						? raw.replace(WORKER_CHAT_TOOLS_HINT, "").trim()
						: raw,
			};
		}
		if (roleId === "chief") {
			return {
				kind: "chief-soul",
				title: "总管人设",
				note: "改的是总管档案里的 SOUL；保存后下一轮生效。人设不能清空。",
				value: unwrapTag(text, "persona"),
				requiresText: true,
			};
		}
		if (partnerId) {
			return {
				kind: "partner-soul",
				partnerId,
				title: "执事人设",
				note: "改的是这个执事的 SOUL；保存后下一轮生效。人设不能清空。",
				value: unwrapTag(text, "persona"),
				requiresText: true,
			};
		}
	}
	if (key === "user_profile") {
		return {
			kind: "user-profile",
			title: "偏好",
			note: "全局一份；会读它的 Agent（总管 + 开了开关的执事）下一轮生效。",
			value: unwrapTag(text, "user_profile"),
		};
	}
	if (key === "partner_soul" && partnerId) {
		return {
			kind: "partner-soul",
			partnerId,
			title: "执事人设（SOUL）",
			note: "改的是这个执事的 SOUL；保存后下一轮生效。人设不能清空。",
			value: String(text ?? "").trim(),
			requiresText: true,
		};
	}
	if (key === "partner_goal" && partnerId) {
		return {
			kind: "partner-goal",
			partnerId,
			title: "当前目标",
			note: "留空 = 清除；写了他每轮都记得。",
			value: stripPrefix(text, "【当前目标】"),
		};
	}
	if (key.startsWith("partner_contract_") && partnerId) {
		return {
			kind: "partner-contract",
			partnerId,
			title: `岗位契约 · ${CONTRACT_TITLES[key] || "编辑"}`,
			note: "这一行是契约四节之一；下面给的是整份契约，保存会四节一起写回。",
			needsLoad: true,
		};
	}
	const disciplineTitle = DISCIPLINE_TITLE_BY_KEY[key];
	if (disciplineTitle && partnerId) {
		return {
			kind: "partner-discipline",
			partnerId,
			title: `执事纪律 · ${disciplineTitle}`,
			note: "只改这一条；清空 = 这一条不注入。其他纪律节保持原样。",
			disciplineTitle,
			needsLoad: true,
			fallback: stripPrefix(text, `【${disciplineTitle}】`),
		};
	}
	return null;
}

/** 异步取当前值：契约拿整份；纪律拿覆盖（没有覆盖就用宿主默认的当前节）。 */
async function loadTargetValue(target) {
	if (target.kind === "partner-contract") {
		const data = await readJson(
			await request(`/api/v1/partners/${encodeURIComponent(target.partnerId)}`, { cache: "no-store" }),
		);
		if (typeof data.contract !== "string") throw new Error("岗位契约未启用（PARTNER_CONTRACT=false）");
		return { value: data.contract, extra: {} };
	}
	if (target.kind === "partner-discipline") {
		const data = await readJson(
			await request(`/api/v1/partners/${encodeURIComponent(target.partnerId)}/discipline`, {
				cache: "no-store",
			}),
		);
		if (data.editable === false) throw new Error("纪律覆盖已关闭（PARTNER_DISCIPLINE_EDIT=false），只能看");
		const override = String(data.override ?? "");
		const overrideMap = parseSections(override);
		const defaultMap = parseSections(String(data.defaultDiscipline ?? ""));
		const value = overrideMap.has(target.disciplineTitle)
			? overrideMap.get(target.disciplineTitle) || ""
			: defaultMap.get(target.disciplineTitle) || target.fallback || "";
		return { value, extra: { override } };
	}
	return { value: target.value ?? "", extra: {} };
}

async function saveTarget(target, value, extra) {
	if (target.kind === "chief-soul") {
		await readJson(
			await request("/api/v1/partners/chief", {
				method: "PATCH",
				body: JSON.stringify({ soul: value }),
			}),
		);
		return;
	}
	if (target.kind === "worker-persona") {
		await readJson(
			await request("/api/v1/agent/worker-persona", {
				method: "PUT",
				body: JSON.stringify({ persona: value }),
			}),
		);
		return;
	}
	if (target.kind === "user-profile") {
		await readJson(
			await request("/api/v1/agent/user-profile", {
				method: "PUT",
				body: JSON.stringify({ content: value }),
			}),
		);
		return;
	}
	if (target.kind === "partner-soul") {
		await readJson(
			await request(`/api/v1/partners/${encodeURIComponent(target.partnerId)}`, {
				method: "PATCH",
				body: JSON.stringify({ soul: value }),
			}),
		);
		return;
	}
	if (target.kind === "partner-goal") {
		await readJson(
			await request(`/api/v1/partners/${encodeURIComponent(target.partnerId)}`, {
				method: "PATCH",
				body: JSON.stringify({ currentGoal: value }),
			}),
		);
		return;
	}
	if (target.kind === "partner-contract") {
		await readJson(
			await request(`/api/v1/partners/${encodeURIComponent(target.partnerId)}/contract`, {
				method: "PUT",
				body: JSON.stringify({ contract: value }),
			}),
		);
		return;
	}
	if (target.kind === "partner-discipline") {
		const map = parseSections(String(extra?.override ?? ""));
		// 清空 = 显式写一个空节（服务端按“标题存在但节内为空”删掉这一条）；
		// 不能直接删键，否则本来就来自宿主默认的节会原样回来。
		map.set(target.disciplineTitle, value.trim());
		const next = serializeSections(map);
		const response = next.trim()
			? await request(`/api/v1/partners/${encodeURIComponent(target.partnerId)}/discipline`, {
					method: "PUT",
					body: JSON.stringify({ discipline: next }),
				})
			: await request(`/api/v1/partners/${encodeURIComponent(target.partnerId)}/discipline`, {
					method: "DELETE",
				});
		await readJson(response);
		return;
	}
	throw new Error("这一节没有可用的保存通道");
}

/**
 * 打开一节的编辑弹层。`section` 来自上下文页的展开行：
 * `{ key, label, text, roleId, partnerId }`；保存成功后调 `onSaved` 重拉页面。
 */
export async function openContextSectionEditor(section, onSaved) {
	const target = resolveTarget(section);
	if (!target) {
		toast("这一节是代码固定或随会话派生的，不能在这里改");
		return;
	}
	const title = target.title || section.label || "编辑这一节";
	openModal(
		title,
		(body) => {
			body.innerHTML = `
        <p class="modal-desc">${esc(target.note || "")}</p>
        <textarea class="pf-contract" id="ctx-edit-text" rows="12" spellcheck="false" readonly
                  aria-label="${esc(title)}" placeholder="读取中…"></textarea>
        <p class="modal-hint" id="ctx-edit-hint"></p>
        <div class="modal-actions">
          <button class="ghost" type="button" data-modal-cancel>关闭</button>
          <button class="ghost" type="button" id="ctx-edit-reset" disabled>撤销</button>
          <button class="modal-primary" type="button" id="ctx-edit-save" disabled>保存</button>
        </div>`;
			const text = body.querySelector("#ctx-edit-text");
			const hint = body.querySelector("#ctx-edit-hint");
			const save = body.querySelector("#ctx-edit-save");
			const reset = body.querySelector("#ctx-edit-reset");
			if (!(text instanceof HTMLTextAreaElement) || !(save instanceof HTMLButtonElement)) return;
			let initial = "";
			let extra = {};
			let saving = false;
			let loaded = false;

			const setHint = (message, isError = false) => {
				if (!hint) return;
				hint.textContent = message;
				hint.classList.toggle("is-error", isError);
			};
			const refresh = () => {
				const dirty = loaded && text.value !== initial;
				const emptyBlocked = Boolean(target.requiresText) && !text.value.trim();
				save.disabled = !loaded || saving || !dirty || emptyBlocked;
				if (reset instanceof HTMLButtonElement) reset.disabled = !loaded || saving || !dirty;
			};
			const apply = (value, nextExtra) => {
				initial = String(value ?? "");
				extra = nextExtra || {};
				text.value = initial;
				text.placeholder = "";
				text.readOnly = false;
				loaded = true;
				setHint("");
				refresh();
			};

			text.addEventListener("input", () => {
				if (target.requiresText && !text.value.trim()) {
					setHint("人设不能清空；要换内容就直接改写。", true);
				} else {
					setHint("");
				}
				refresh();
			});
			reset?.addEventListener("click", () => {
				text.value = initial;
				setHint("");
				refresh();
			});
			body.querySelector("[data-modal-cancel]")?.addEventListener("click", () => closeModal());
			save.addEventListener("click", async () => {
				if (save.disabled) return;
				if (target.requiresText && !text.value.trim()) {
					setHint("人设不能清空；要换内容就直接改写。", true);
					return;
				}
				saving = true;
				refresh();
				setHint("保存中…");
				try {
					await saveTarget(target, text.value, extra);
					saving = false;
					toast("已保存，按源头的生效时机起效");
					closeModal();
					if (typeof onSaved === "function") onSaved();
				} catch (error) {
					saving = false;
					setHint(`没存成：${error instanceof Error ? error.message : String(error)}`, true);
					refresh();
				}
			});

			// 同步目标（人设 / 关于我 / 目标）直接填；契约与纪律先取当前值。
			if (!target.needsLoad) {
				apply(target.value, {});
				return;
			}
			void loadTargetValue(target)
				.then(({ value, extra: nextExtra }) => {
					if (!text.isConnected) return;
					apply(value, nextExtra);
				})
				.catch((error) => {
					if (!text.isConnected) return;
					text.placeholder = "读取失败";
					setHint(error instanceof Error ? error.message : String(error), true);
				});
		},
		{ className: "modal-wide" },
	);
}
