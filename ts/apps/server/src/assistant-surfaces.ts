/**
 * 助手总览（2026-11-22 注入页）
 *
 * 只读汇总，给设置 → 注入 → 人设顶部的「助手的人设与工具」卡用：
 * 总管 / 活跃执事 / 普通助手 / 派活工人（池）各自的人设预览、工具名、可调与固定项。
 *
 * 刻意只给预览与入口，不返回全文正文、不返回密钥；完整上下文仍走
 * `/api/v1/agent/context-defaults?role=<id>`。
 */

import type { Hono } from "hono";
import { PERSONA } from "./agent/assist.ts";
import {
  CHIEF_PARTNER_ID,
  COMPANIONS_ENABLED,
  partnersStore,
  resolvePersona,
} from "./partners.ts";
import { modelToolCatalog } from "./partner-tools.ts";
import { poolToolCatalog } from "./pool/pool-tools.ts";
import { readWorkerPersona } from "./worker-persona.ts";
import { workerToolsPayload } from "./worker-tools.ts";

export interface AssistantSurface {
  id: string;
  label: string;
  kind: "chief" | "partner" | "worker" | "dispatch";
  persona: {
    chars: number;
    preview: string;
    editable: boolean;
    hash: string;
  };
  tools: {
    count: number;
    names: string[];
    editable: boolean;
    hash: string;
    note?: string;
  };
  adjustable: string[];
  fixed: string[];
  contextHash: string;
  modelHash?: string;
}

const PREVIEW_MAX = 160;

function previewOf(text: string): { chars: number; preview: string } {
  const value = String(text ?? "").trim();
  return {
    chars: value.length,
    preview: value.length > PREVIEW_MAX ? `${value.slice(0, PREVIEW_MAX).trimEnd()}…` : value,
  };
}

function hashOfPartner(id: string): string {
  return `#/settings/partners/${encodeURIComponent(id)}`;
}

function contextHashOf(id: string): string {
  return `#/settings/context?role=${encodeURIComponent(id)}`;
}

function toolNamesOf(
  catalog: ReadonlyArray<{ name: string }>,
  disabled: ReadonlySet<string> = new Set(),
): string[] {
  return catalog
    .map((tool) => String(tool.name || "").trim())
    .filter((name) => name !== "" && !disabled.has(name));
}

function chiefSurface(): AssistantSurface {
  const store = partnersStore();
  const row = store.get(CHIEF_PARTNER_ID);
  const persona = previewOf(resolvePersona(partnersStore, PERSONA));
  const disabled = new Set(row?.disabledTools ?? []);
  return {
    id: CHIEF_PARTNER_ID,
    label: row?.name?.trim() || "总管",
    kind: "chief",
    persona: {
      ...persona,
      editable: true,
      hash: hashOfPartner(CHIEF_PARTNER_ID),
    },
    tools: {
      count: toolNamesOf(modelToolCatalog(), disabled).length,
      names: toolNamesOf(modelToolCatalog(), disabled),
      editable: true,
      hash: hashOfPartner(CHIEF_PARTNER_ID),
      note: "按人勾选；按需工具要先 tool_search。",
    },
    adjustable: ["人设", "工具"],
    fixed: [],
    contextHash: contextHashOf(CHIEF_PARTNER_ID),
  };
}

function partnerSurface(partner: {
  id: string;
  name?: string;
  disabledTools?: string[];
}): AssistantSurface {
  const store = partnersStore();
  const soul = store.readSoulFromHome(partner.id) ?? "";
  const disabled = new Set(partner.disabledTools ?? []);
  const names = toolNamesOf(modelToolCatalog(), disabled);
  return {
    id: `partner:${partner.id}`,
    label: partner.name?.trim() || "执事",
    kind: "partner",
    persona: {
      ...previewOf(soul),
      editable: true,
      hash: hashOfPartner(partner.id),
    },
    tools: {
      count: names.length,
      names,
      editable: true,
      hash: hashOfPartner(partner.id),
      note: "按人勾选；按需工具要先 tool_search。",
    },
    adjustable: ["人设", "岗位契约", "工具"],
    fixed: [],
    contextHash: contextHashOf(`partner:${partner.id}`),
  };
}

function workerSurface(): AssistantSurface {
  const persona = previewOf(readWorkerPersona());
  const names = toolNamesOf(modelToolCatalog());
  return {
    id: "worker",
    label: "普通助手",
    kind: "worker",
    persona: {
      ...persona,
      editable: true,
      hash: hashOfPartner("worker"),
    },
    tools: {
      count: names.length,
      names,
      editable: true,
      hash: hashOfPartner("worker"),
      note: "会话工具；常驻/按需在 注入 → 工具，派活工具在普通助手页。",
    },
    adjustable: ["人设", "技能", "派活工具"],
    fixed: ["验证铁律", "注入防线"],
    contextHash: contextHashOf("worker"),
  };
}

function dispatchSurface(): AssistantSurface {
  const persona = previewOf(readWorkerPersona());
  let names: string[] = [];
  try {
    const payload = workerToolsPayload();
    const allowed = new Set([
      ...payload.granted,
      ...(payload.escalate ? ["escalate"] : []),
    ]);
    names = toolNamesOf(poolToolCatalog(), new Set(
      poolToolCatalog()
        .map((tool) => tool.name)
        .filter((name) => !allowed.has(name)),
    ));
  } catch {
    names = toolNamesOf(poolToolCatalog());
  }
  return {
    id: "dispatch-worker",
    label: "派活工人（池）",
    kind: "dispatch",
    persona: {
      ...persona,
      editable: true,
      hash: hashOfPartner("worker"),
    },
    tools: {
      count: names.length,
      names,
      editable: true,
      hash: hashOfPartner("worker"),
      note: "前四件与 native 共用勾选；escalate 恒开。",
    },
    adjustable: ["人设（与普通助手共用）", "工具四件", "模型"],
    fixed: ["工人纪律", "注入防线", "验证铁律", "交付契约", "工作边界"],
    contextHash: contextHashOf("dispatch-worker"),
    modelHash: "#/settings/agent",
  };
}

/** 汇总端点 payload：顺序 = 总管 → 活跃执事 → 普通助手 → 派活工人（池）。 */
export function assistantSurfacesPayload(): { ok: true; surfaces: AssistantSurface[] } {
  const surfaces: AssistantSurface[] = [chiefSurface()];
  if (COMPANIONS_ENABLED) {
    try {
      const rows = partnersStore()
        .list()
        .filter(
          (partner) =>
            partner.id !== CHIEF_PARTNER_ID && partner.status === "active",
        );
      for (const row of rows) surfaces.push(partnerSurface(row));
    } catch {
      // 执事库读不出来：总管 / worker / dispatch 仍要有，不整页 500。
    }
  }
  surfaces.push(workerSurface(), dispatchSurface());
  return { ok: true, surfaces };
}

/** 路由挂载；鉴权沿用主 app 的 `/api/v1/*` 中间件。 */
export function mountAssistantSurfacesRoutes(app: Hono): void {
  app.get("/api/v1/agent/assistant-surfaces", (c) => c.json(assistantSurfacesPayload()));
}
