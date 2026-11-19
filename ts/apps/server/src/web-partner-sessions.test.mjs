import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSessionTree,
  parsePartnerExternalId,
  partnerIdOfConversation,
  partnerSessionLabel,
} from "../web/partner-sessions.js";

/**
 * 一人多会话批2 的前端镜像口径（2026-11-17）：与服务端 partner-session-role.test.ts 对齐。
 * 模块不碰 DOM，这里直接 import 验解析 / 归属 / 标题三件事。
 */

test("parsePartnerExternalId：canonical / side / group / partnerId 含连字符 / 非 partner 前缀", () => {
  assert.deepEqual(parsePartnerExternalId("partner-diary"), { partnerId: "diary", role: "canonical" });
  assert.deepEqual(parsePartnerExternalId("partner-diary-side-1a2b3c4d"), {
    partnerId: "diary",
    role: "side",
  });
  assert.deepEqual(parsePartnerExternalId("partner-diary-group-abc"), {
    partnerId: "diary",
    role: "group",
  });
  assert.deepEqual(parsePartnerExternalId("partner-a-b"), { partnerId: "a-b", role: "canonical" });
  assert.equal(parsePartnerExternalId("worker-123"), null);
  assert.equal(parsePartnerExternalId(""), null);
  assert.equal(parsePartnerExternalId(null), null);
});

test("partnerIdOfConversation：canonical + side 有值，group 为 空串", () => {
  assert.equal(partnerIdOfConversation("partner-diary"), "diary");
  assert.equal(partnerIdOfConversation("partner-diary-side-1a2b3c4d"), "diary");
  assert.equal(partnerIdOfConversation("partner-diary-group-abc"), "");
  assert.equal(partnerIdOfConversation("worker-123"), "");
});

test("partnerSessionLabel：title 优先；turns=0 → 新会话；有 firstText → 用它", () => {
  assert.equal(partnerSessionLabel({ title: "装修那摊事", firstText: "今天怎么样", turns: 3 }), "装修那摊事");
  assert.equal(partnerSessionLabel({ firstText: "今天怎么样", turns: 3 }), "今天怎么样");
  assert.equal(partnerSessionLabel({ firstText: "今天怎么样", turns: 0 }), "新会话");
  assert.equal(partnerSessionLabel({ turns: 0 }), "新会话");
  assert.equal(partnerSessionLabel({}), "新会话");
});

test("buildSessionTree：副本挂到母会话下，母会话缺失 / 环都退回顶层", () => {
  const canonical = { conversationId: "c", role: "canonical", lastAt: 300 };
  const child = { conversationId: "b", role: "side", lastAt: 200, origin: { source: "c" } };
  const grandchild = { conversationId: "a", role: "side", lastAt: 100, origin: { source: "b" } };
  const orphan = { conversationId: "x", role: "side", lastAt: 50, origin: { source: "gone" } };

  const tree = buildSessionTree([canonical, child, grandchild, orphan]);
  assert.deepEqual(
    tree.map((node) => node.session.conversationId),
    ["c", "x"],
    "母会话在顶层；来源缺失的副本不装成别人的孩子",
  );
  const c = tree[0];
  assert.equal(c.children.length, 1);
  assert.equal(c.children[0].session.conversationId, "b");
  assert.equal(c.children[0].children[0].session.conversationId, "a");

  // 自环 / 互环：不能无限递归，节点也不能重复出现
  const self = { conversationId: "s", role: "side", lastAt: 1, origin: { source: "s" } };
  const a = { conversationId: "a", role: "side", lastAt: 1, origin: { source: "b" } };
  const b = { conversationId: "b", role: "side", lastAt: 1, origin: { source: "a" } };
  const flat = buildSessionTree([self, a, b]);
  const seen = [];
  const walk = (nodes) => {
    for (const node of nodes) {
      seen.push(node.session.conversationId);
      walk(node.children);
    }
  };
  walk(flat);
  assert.deepEqual(seen.sort(), ["a", "b", "s"]);
});
