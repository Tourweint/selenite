import assert from "node:assert/strict";
import { test } from "node:test";
import {
	RECOVER_NOTE,
	markRecoverResume,
	recoverNoteEnabled,
	resetRecoverNotes,
	takeRecoverNote,
} from "./recover-note.ts";

/**
 * 恢复注记（任务书 T3 §5.4）：注入一次 + 第二次不再注入。
 * 记账是进程内的（与 resumeCount 同族），每个用例先清一次。
 */

test.beforeEach(() => resetRecoverNotes());

test("文案不超过 300 字，且包含「先查再动」", () => {
	assert.ok(RECOVER_NOTE.length <= 300, `文案 ${RECOVER_NOTE.length} 字，超了`);
	assert.match(RECOVER_NOTE, /先查再动/);
});

test("开关缺省开，明确 false/0/off 才关", () => {
	assert.equal(recoverNoteEnabled({}), true);
	assert.equal(recoverNoteEnabled({ AGENT_RECOVER_NOTE: "false" }), false);
	assert.equal(recoverNoteEnabled({ AGENT_RECOVER_NOTE: "0" }), false);
	assert.equal(recoverNoteEnabled({ AGENT_RECOVER_NOTE: "OFF" }), false);
	assert.equal(recoverNoteEnabled({ AGENT_RECOVER_NOTE: "true" }), true);
});

test("注入一次，第二次不再注入（每张单最多一次）", () => {
	markRecoverResume(42);
	assert.equal(takeRecoverNote(42), RECOVER_NOTE);
	assert.equal(takeRecoverNote(42), undefined, "第二次不该再注入");
	// 没标记过的会话不受影响
	markRecoverResume(43);
	assert.equal(takeRecoverNote(44), undefined);
});

test("开关关着时不注入，并且不积压（开回来也不补发）", () => {
	markRecoverResume(51);
	assert.equal(takeRecoverNote(51, { AGENT_RECOVER_NOTE: "false" }), undefined);
	assert.equal(takeRecoverNote(51), undefined, "关着时取过一次就该清账");
});
