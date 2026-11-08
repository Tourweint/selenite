import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSkillStore, skillSlashOf } from "./skills.ts";
import { createSkillState, skillStateEnabled } from "./skill-state.ts";

/**
 * 技能启停位 + 斜杠调用（2026-11-09 用户拍板：默认全关，开了才进索引，/名字 直接调用）。
 */
const root = mkdtempSync(join(tmpdir(), "lifediary-skill-state-"));
const skillsDir = join(root, "skills");
mkdirSync(skillsDir, { recursive: true });
for (const [name, body] of [
	["alpha", "alpha 摘要\nalpha 正文"],
	["beta", "beta 摘要\nbeta 正文"],
] as const) {
	writeFileSync(join(skillsDir, `${name}.md`), body, "utf8");
}

test("skill-state：默认全关，开了才可见，关了 tool 侧立刻取不到", () => {
	const state = createSkillState(join(root, "state.json"));
	const store = createSkillStore(skillsDir, { visible: (name) => state.isEnabled(name) });
	assert.ok(store, "目录里有技能，store 不为 null");
	// 默认全关：索引整个省略、名单为空、手册取不到
	assert.equal(store.indexFor(1), undefined);
	assert.deepEqual(store.names(), []);
	assert.equal(store.manual("alpha"), undefined);

	state.setEnabled("alpha", true);
	assert.equal(store.names().join(","), "alpha");
	assert.match(store.indexFor(2) ?? "", /alpha 摘要/);
	assert.doesNotMatch(store.indexFor(2) ?? "", /beta/);
	assert.match(store.manual("alpha") ?? "", /alpha 正文/);
	assert.equal(store.manual("beta"), undefined, "关着的技能 tool 侧立刻取不到");

	state.setAll(true, ["alpha", "beta"]);
	assert.equal(store.names().length, 2);
	state.setAll(false, ["alpha", "beta"]);
	assert.deepEqual(store.names(), []);
	assert.equal(store.indexFor(3), undefined, "全关 = 整个索引 section 省略");

	// 新实例读同一份文件：持久化生效
	const reopened = createSkillState(join(root, "state.json"));
	assert.equal(reopened.isEnabled("alpha"), false);

	// 逃生门：SKILL_STATE=false = 不过滤（旧行为）
	process.env.SKILL_STATE = "false";
	assert.equal(skillStateEnabled(), false);
	delete process.env.SKILL_STATE;

	rmSync(root, { recursive: true, force: true });
});

test("skillSlashOf：/名字 + 空白或行尾才算，路径样不算，大小写受限", () => {
	assert.equal(skillSlashOf("/alpha 帮我盘点"), "alpha");
	assert.equal(skillSlashOf("/alpha"), "alpha");
	assert.equal(skillSlashOf("  /beta\t开头有缩进也算"), "beta");
	assert.equal(skillSlashOf("/alpha/beta 不是路径"), null, "路径样不算");
	assert.equal(skillSlashOf("/alphatool 别误伤普通词"), "alphatool");
	assert.equal(skillSlashOf("/Alpha 大写不收"), null);
	assert.equal(skillSlashOf("/-bad 开头短横线不收"), null);
	assert.equal(skillSlashOf("普通消息"), null);
	assert.equal(skillSlashOf(""), null);
});
