import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ProjectError, ProjectsStore } from "./projects.ts";
import { PartnersStore } from "./partners.ts";

/**
 * 项目合并（2026-11-17 项目合并与记忆迁移）：只测登记表这一层。
 * 记忆搬迁 / 会话改绑在各自模块的测试里；这里确保「根调过去、源消失、指针改指」。
 */

function tempRoot(prefix: string): string {
	return mkdtempSync(join(tmpdir(), `lifediary-${prefix}-`));
}

test("mergeInto：源的文件夹调到目标名下（降为附加），源登记消失，当前项目指针改指目标", () => {
	const root = tempRoot("merge");
	const store = new ProjectsStore(join(root, "projects.sqlite"));
	try {
		const workspace = join(root, "ws");
		mkdirSync(workspace, { recursive: true });
		store.setWorkspace(workspace);

		const a = store.confirmProposal(store.proposeProject("源项目", "a").id);
		const b = store.confirmProposal(store.proposeProject("目标项目", "b").id);
		// 源再加一个文件夹，验证多根也一起搬
		const extra = join(root, "a-extra");
		mkdirSync(extra, { recursive: true });
		store.addRoot(a.id, { path: extra });
		store.setCurrentProject(a.id);

		const result = store.mergeInto(a.id, b.id);
		assert.equal(result.rootsMoved, 2);
		assert.equal(result.rootsSkipped, 0);

		const names = store.listProjects().map((project) => project.name);
		assert.deepEqual(names, ["目标项目"], "源项目登记应已删除");
		const merged = store.listProjects()[0]!;
		assert.equal(merged.roots.length, 3, "目标原有 1 个根 + 源 2 个根");
		assert.equal(merged.roots[0]?.role, "primary", "目标自己的主文件夹不动");
		assert.deepEqual(
			merged.roots.slice(1).map((item) => item.role),
			["extra", "extra"],
			"调过来的根一律降为附加",
		);
		assert.equal(store.getCurrentProjectId(), b.id, "当前项目跟着改指目标");
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("mergeInto：拒绝合并到自己、目标不存在、目标已归档", () => {
	const root = tempRoot("merge-guard");
	const store = new ProjectsStore(join(root, "projects.sqlite"));
	try {
		const workspace = join(root, "ws");
		mkdirSync(workspace, { recursive: true });
		store.setWorkspace(workspace);
		const a = store.confirmProposal(store.proposeProject("甲", "a").id);
		const b = store.confirmProposal(store.proposeProject("乙", "b").id);
		const c = store.confirmProposal(store.proposeProject("丙", "c").id);
		store.setArchived(c.id, true);

		assert.throws(() => store.mergeInto(a.id, a.id), (error: unknown) => {
			return error instanceof ProjectError && error.code === "bad_request";
		});
		assert.throws(() => store.mergeInto(a.id, "no-such-project"), (error: unknown) => {
			return error instanceof ProjectError && error.code === "not_found";
		});
		assert.throws(() => store.mergeInto(a.id, c.id), (error: unknown) => {
			return error instanceof ProjectError && error.code === "target_archived";
		});
		// 失败不产生副作用
		assert.equal(store.listProjects(true).length, 3);
		assert.ok(b.id);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("reparentProject：挂载从源换到目标，原本两边都挂的去重成一条", () => {
	const root = tempRoot("reparent");
	const store = new PartnersStore(join(root, "partners.sqlite"), join(root, "homes"));
	try {
		const partner = store.create("执事甲");
		const other = store.create("执事乙");
		store.setProjectIds(partner.id, ["src", "keep"]);
		store.setProjectIds(other.id, ["src", "tgt"]);

		const changed = store.reparentProject("src", "tgt");
		assert.equal(changed, 2);
		assert.deepEqual(store.get(partner.id)?.projectIds, ["tgt", "keep"]);
		assert.deepEqual(store.get(other.id)?.projectIds, ["tgt"], "原本两边都挂的去重成一条");
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});
