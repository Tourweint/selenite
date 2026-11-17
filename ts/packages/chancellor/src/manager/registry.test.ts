import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  archiveManager,
  ensureManager,
  listManagers,
  readManagerMeta,
  validateDomain,
} from "./registry.ts";

/** workRoot 传 <root>/runs；managers 根目录按约定落在同级 <root>/managers。 */
function tempWorkRoot(): { root: string; workRoot: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "chancellor-registry-"));
  return {
    root,
    workRoot: join(root, "runs"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("ensureManager：partnerId 写入 meta.json，listManagers 投影带出", () => {
  const { workRoot, cleanup } = tempWorkRoot();
  try {
    const info = ensureManager(workRoot, "desktop-shell", { partnerId: "p-123" });
    assert.equal(info.partner_id, "p-123");
    assert.equal(readManagerMeta(info.root)?.partner_id, "p-123");

    const entry = listManagers(workRoot).find((e) => e.domain === "desktop-shell");
    assert.equal(entry?.meta?.partner_id, "p-123", "listManagers 必须带出 partner_id");

    // chancellor 自己派单时不带 opts：宿主写进来的 partner_id 不能被冲掉。
    ensureManager(workRoot, "desktop-shell");
    assert.equal(readManagerMeta(info.root)?.partner_id, "p-123");

    // 普通领域（宿主没注入）partner_id 为 null，不是 undefined。
    const plain = ensureManager(workRoot, "finance");
    assert.equal(plain.partner_id, null);
  } finally {
    cleanup();
  }
});

test("domain 强制小写 ASCII（DOMAIN_PATTERN）：非法名直接抛错", () => {
  const { workRoot, cleanup } = tempWorkRoot();
  try {
    for (const bad of ["前端", "UPPER", "-bad", "bad-", "a_b", ""]) {
      assert.throws(() => validateDomain(bad, workRoot), /不合法/);
    }
    assert.equal(validateDomain("desktop-shell", workRoot), "desktop-shell");
  } finally {
    cleanup();
  }
});

test("archiveManager：改名 .archived- 前缀、listManagers 不再列出、幂等、runs 保留", () => {
  const { workRoot, cleanup } = tempWorkRoot();
  try {
    const info = ensureManager(workRoot, "finance", { partnerId: "p-f" });
    // 造一点工单历史，验证「不物理删」。
    writeFileSync(join(info.runs_dir, "ticket-1.json"), "{}");
    assert.equal(listManagers(workRoot).some((e) => e.domain === "finance"), true);

    const archived = archiveManager(workRoot, "finance");
    assert.ok(archived, "归档返回新路径");
    assert.ok(archived.includes(".archived-finance-"), "归档目录带 .archived- 前缀");
    assert.ok(existsSync(archived), "归档目录存在");
    assert.equal(existsSync(info.root), false, "原目录已被改名，不是复制");
    assert.ok(existsSync(join(archived, "runs", "ticket-1.json")), "runs 历史保留");
    assert.equal(
      listManagers(workRoot).some((e) => e.domain === "finance"),
      false,
      "listManagers 跳过 . 开头的归档目录",
    );

    // 幂等：已归档 / 从未建过的领域再调都返回 null，不抛错。
    assert.equal(archiveManager(workRoot, "finance"), null);
    assert.equal(archiveManager(workRoot, "never-existed"), null);
  } finally {
    cleanup();
  }
});
