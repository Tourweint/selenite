/**
 * 技能库位置（2026-11-23；2026-11-24 内置来源可移除）
 *
 * 用户口径：技能库不能只认默认位置，要能添加多个位置、建 / 改技能时选位置；
 * 不想读的来源要能直接移除。
 *
 * 这里只管「位置这一块怎么画、怎么增删」：
 *   - 读取链 4 种来源：主目录（env / user）、自加位置（custom）、`.agents/skills`（只读）、内置目录（只读）；
 *   - 自加位置带显示名；除主目录外，每行都有「移除」——**只改读取清单，磁盘文件一个不动**：
 *     自加位置 = 删登记；`.agents` / 内置目录 = 不再读取（重新添加同一路径即恢复）；
 *   - 添加位置只收已存在的绝对路径（不替用户建目录，打错一个字母不该生成空文件夹）；
 *   - 能力开关由服务端 `extraDirs` 说了算：关着就整块不出现添加入口。
 *
 * 渲染完把 `reload`（= loadSkills）留给本模块调用：加/减位置后重新拉列表即可，
 * 不在别处再存一套位置状态。
 */

import { attr, esc } from "./markdown.js";
import { request } from "./net.js";
import { clearModalHint, setModalHint } from "./project-modal.js";
import { closeModal, inShell, openModal, selectDirectory, toast } from "./ui-atoms.js";

/** 来源的短标签（行首那一列；自加位置优先用用户填的显示名） */
const SKILL_LOC_KIND = {
	env: "显式目录",
	user: "主目录",
	agents: ".agents",
	app: "内置",
};

function locKind(row) {
	if (row.origin === "custom") return row.label || "自加位置";
	return SKILL_LOC_KIND[row.origin] || String(row.origin || "");
}

function skillCountAt(items, dir) {
	let count = 0;
	for (const item of items || []) if (item.dir === dir) count += 1;
	return count;
}

/**
 * 画位置卡。data = GET /api/v1/agent/skills 的响应（含 dirs / items / extraDirs）。
 * options.reload：位置增删成功后重拉列表（由 skills-settings 传入）。
 */
function renderSkillLocations(box, data, options = {}) {
	if (!box) return;
	const dirs = Array.isArray(data?.dirs) ? data.dirs : [];
	if (!dirs.length) {
		box.hidden = true;
		box.replaceChildren();
		return;
	}
	box.hidden = false;
		const rows = dirs
			.map((source) => {
				const count = skillCountAt(data.items, source.dir);
				const missing = source.exists === false;
				const custom = source.origin === "custom";
				// 2026-11-23：可写 / 只读标记退役（本页只读，写落到哪里不是这里能决定的）；
				// 「不存在」保留——它解释的是「为什么这几个技能读不到」，是真异常。
				const state = missing
					? `<span class="sk-loc-state is-missing" title="登记还在，但磁盘上找不到这个目录：里面的技能暂时读不到">不存在</span>`
					: "";
				const remove = source.removable
					? `<button class="sk-loc-remove" type="button" data-skill-loc-remove="${attr(source.dir)}" data-skill-loc-custom="${custom ? "1" : "0"}" title="${
							custom ? "从技能库位置里移除（只删登记，磁盘文件不动）" : "不再从这个目录读取技能（磁盘文件不动）"
						}">移除</button>`
					: `<span class="sk-loc-remove is-empty" aria-hidden="true"></span>`;
				return `<div class="sk-loc-row">
					<span class="sk-loc-kind" title="${attr(source.label || SKILL_LOC_KIND[source.origin] || source.dir)}">${esc(locKind(source))}</span>
					<span class="sk-loc-path${missing ? " is-missing" : ""}" title="${attr(source.dir)}">${esc(source.dir)}</span>
					<span class="sk-loc-count">${count ? `${count} 个` : "0 个"}</span>
					${state}
					${remove}
				</div>`;
			})
			.join("");
	box.innerHTML = `
		<div class="sk-loc-head">
			<span class="sk-loc-title">技能库位置</span>
			<span class="sk-loc-spacer"></span>
			${
				data.extraDirs === false
					? ""
					: `<button class="ghost sk-loc-add" type="button" data-skill-loc-add title="把另一个目录加进技能库（只登记，不搬文件）">添加位置</button>`
			}
		</div>
		<div class="sk-loc-rows">${rows}</div>`;

	box.querySelector("[data-skill-loc-add]")?.addEventListener("click", () => openAddSkillDirModal(options.reload));
	for (const button of box.querySelectorAll("[data-skill-loc-remove]")) {
		button.addEventListener("click", () =>
			openRemoveSkillDirModal(
				String(button.getAttribute("data-skill-loc-remove") || ""),
				button.getAttribute("data-skill-loc-custom") !== "0",
				options.reload,
			),
		);
	}
}

function openAddSkillDirModal(reload) {
	openModal("添加技能库位置", (body) => {
		body.innerHTML = `
			<p class="modal-desc">把一个已有的目录加进技能库。目录里放 <code>&lt;技能名&gt;.md</code>（第 1 行是摘要），或 <code>&lt;技能名&gt;/SKILL.md</code>。只登记位置，不搬文件、不建目录。</p>
			<div class="modal-field">
				<span>目录（绝对路径）</span>
				<div class="modal-row">
					<input class="modal-input is-mono" id="sk-loc-new-path" type="text" spellcheck="false" placeholder="例如：D:\\skills" />
					${inShell() ? '<button class="ghost" id="sk-loc-new-pick" type="button">选择目录</button>' : ""}
				</div>
			</div>
			<div class="modal-field">
				<span>显示名（可留空）</span>
				<input class="modal-input" id="sk-loc-new-label" type="text" maxlength="40" spellcheck="false" placeholder="例如：团队手册" />
			</div>
			<p class="modal-hint" id="sk-loc-new-hint"></p>
			<div class="modal-actions">
				<button class="ghost" type="button" data-modal-cancel>取消</button>
				<button class="modal-primary" id="sk-loc-new-go" type="button">添加</button>
			</div>`;

		const pathInput = body.querySelector("#sk-loc-new-path");
		const labelInput = body.querySelector("#sk-loc-new-label");
		const hint = body.querySelector("#sk-loc-new-hint");
		const go = body.querySelector("#sk-loc-new-go");
		body.querySelector("[data-modal-cancel]")?.addEventListener("click", closeModal);

		body.querySelector("#sk-loc-new-pick")?.addEventListener("click", async () => {
			const chosen = await selectDirectory();
			if (!chosen) return; // 用户取消：保留原值
			pathInput.value = chosen;
			clearModalHint(hint);
		});
		pathInput.addEventListener("input", () => clearModalHint(hint));
		labelInput.addEventListener("input", () => clearModalHint(hint));

		const submit = async () => {
			if (go.disabled) return;
			const path = pathInput.value.trim();
			if (!path) {
				setModalHint(hint, "先填目录的绝对路径。");
				pathInput.focus();
				return;
			}
			go.disabled = true;
			setModalHint(hint, "添加中…", false);
			try {
				const response = await request("/api/v1/agent/skill-dirs", {
					method: "POST",
					body: JSON.stringify({ path, label: labelInput.value.trim() }),
				});
				const data = await response.json().catch(() => ({}));
				if (!response.ok) {
					setModalHint(hint, data.message || `没加成：HTTP ${response.status}`);
					return;
				}
				closeModal();
				toast("已加入技能库位置");
				reload?.();
			} catch (error) {
				if (error.message === "forbidden") {
					closeModal();
					return;
				}
				setModalHint(hint, `没加成：${error.message}`);
			} finally {
				go.disabled = false;
			}
		};
		go.addEventListener("click", () => void submit());
		pathInput.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				void submit();
			}
		});
	});
}

function openRemoveSkillDirModal(dir, custom, reload) {
	if (!dir) return;
	openModal("移除技能库位置", (body) => {
		body.innerHTML = `
			<p class="modal-desc">${
				custom
					? `把 <code>${esc(dir)}</code> 从技能库里移除？只删这条登记：目录本身和里面的文件一个都不动，以后想用再加回来。`
					: `以后不再从 <code>${esc(dir)}</code> 读取技能？只改读取清单：目录本身和里面的文件一个都不动，想恢复就点「添加位置」把同一个路径加回来。`
			}</p>
			<p class="modal-hint" id="sk-loc-del-hint"></p>
			<div class="modal-actions">
				<button class="ghost" type="button" data-modal-cancel>取消</button>
				<button class="modal-danger" id="sk-loc-del-go" type="button">移除</button>
			</div>`;
		const hint = body.querySelector("#sk-loc-del-hint");
		const go = body.querySelector("#sk-loc-del-go");
		body.querySelector("[data-modal-cancel]")?.addEventListener("click", closeModal);
		go.addEventListener("click", async () => {
			if (go.disabled) return;
			go.disabled = true;
			setModalHint(hint, "移除中…", false);
			try {
				const response = await request(
					`/api/v1/agent/skill-dirs?path=${encodeURIComponent(dir)}`,
					{ method: "DELETE" },
				);
				const data = await response.json().catch(() => ({}));
				if (!response.ok) {
					setModalHint(hint, data.message || `没删掉：HTTP ${response.status}`);
					return;
				}
				closeModal();
				toast(custom ? "已从技能库移除（文件没动）" : "已不再读取这个目录（文件没动）");
				reload?.();
			} catch (error) {
				if (error.message === "forbidden") {
					closeModal();
					return;
				}
				setModalHint(hint, `没删掉：${error.message}`);
			} finally {
				go.disabled = false;
			}
		});
	});
}

export { openAddSkillDirModal, openRemoveSkillDirModal, renderSkillLocations };
