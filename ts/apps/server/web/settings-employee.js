/**
 * 二级页 · 员工档案
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { el } from "./dom.js";
import { request } from "./net.js";
import { cs, csHead, drawerOpen, renderCsHome } from "./settings-drawer.js";
import { MEMORY_KIND_LABEL } from "./settings-memory.js";
import { state } from "./state.js";

/* ── 二级页 · 员工档案（2026-11-09；2026-11-13 合并成「一页四分段」）──
 * 用户口径：工作履历 / 记忆 / 例行规则 / 技能四类都改不了 → 只读，但视图要能一页看全。
 * 所以四个旧页（records / memories / routines / skills）合并成一页四个分段；
 * 首页四条行仍各自直达对应分段（openPartnerProfile 传的旧页名照旧认，见 renderCsPage）。
 * 数据三源（零新存储）：
 *   GET /api/v1/agent/memory?scope=partner:<id>&limit=2000 → work 进履历、其余进记忆
 *   GET /api/v1/routines?partnerId=<id>                     → 例行规则
 *   GET /api/v1/partners/:id/skills                        → 技能
 * 刻意只读：编辑仍走人设页三卡（SOUL / 契约 / 目标）与例行任务既有编辑面；
 * 记忆删除 / 整理沿用设置页记忆区，档案页不重复做（避免两处真相）。
 * 一次拉全量（首页的条数与「最近一条」也吃这一份），失败只影响本页，不拦抽屉。
 */

/** 档案页的 scope：总管读写 global，执事读写自己的键空间。 */
function csProfileScope(target) {
  return target === "chief" ? "global" : `partner:${target}`;
}

/** 时间戳统一成「YYYY-MM-DD HH:mm」，取不到就空串。 */
function csProfileWhen(value) {
  return String(value || "").replace("T", " ").slice(0, 16);
}

/** 档案页通用的空态话术（与 persona 页同一套 cs-note）。 */
function csProfileEmpty(body, text) {
  const note = document.createElement("p");
  note.className = "cs-note";
  note.textContent = text;
  body.append(note);
}

/** 一行字截到 n 个字，给首页「最近一条」用（合并空白，多了加省略号）。 */
function csClip(text, n = 26) {
  const one = String(text || "").replace(/\s+/g, " ").trim();
  if (!one) return "";
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

/** 记忆 / 履历同源：一次拉全量（2000 是服务端上限），前端按 kind 分拣。 */
async function csLoadProfileMemory(target) {
  const response = await request(
    `/api/v1/agent/memory?scope=${encodeURIComponent(csProfileScope(target))}&limit=2000`,
    { cache: "no-store" },
  );
  if (response.status === 404) return { disabled: true, items: [] };
  if (!response.ok) throw new Error(String(response.status));
  const data = await response.json().catch(() => ({}));
  return { disabled: false, items: Array.isArray(data.items) ? data.items : [] };
}

async function csLoadProfileRoutines(target) {
  const response = await request(`/api/v1/routines?partnerId=${encodeURIComponent(target)}`, {
    cache: "no-store",
  });
  // 404 = 执事能力整体未启用（整组路由不挂），按空列表处理
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(String(response.status));
  const data = await response.json().catch(() => ({}));
  return Array.isArray(data.routines) ? data.routines : [];
}

async function csLoadProfileSkills(target) {
  const response = await request(`/api/v1/partners/${encodeURIComponent(target)}/skills`, {
    cache: "no-store",
  });
  // 404 = 执事不存在 / 执事能力未启用，按空列表处理，不假装成故障
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(String(response.status));
  const data = await response.json().catch(() => ({}));
  return Array.isArray(data.skills) ? data.skills : [];
}

/** 触发器原样展示：cron/interval/once/event 的表达式不翻译成人话。 */
function csTriggerText(trigger) {
  const type = String(trigger?.type || "");
  if (type === "cron") return `cron · ${trigger.expr ?? ""}`;
  if (type === "interval") return `interval · ${trigger.seconds ?? ""}`;
  if (type === "once") return `once · ${trigger.at ?? ""}`;
  if (type === "event") return `event · ${trigger.kind ?? ""}`;
  return type || JSON.stringify(trigger ?? {});
}

/** 三处来源一次拉全：记忆一次（履历与记忆同源）、例行、技能。 */
async function csLoadArchive(target) {
  const [memory, routines, skills] = await Promise.all([
    csLoadProfileMemory(target),
    csLoadProfileRoutines(target),
    csLoadProfileSkills(target),
  ]);
  return { target, memory, routines, skills };
}

/** 同一目标并行只拉一次；首页条数与档案页内容共用这一份。 */
function csArchiveData(target) {
  if (cs.archive && cs.archive.target === target) return Promise.resolve(cs.archive);
  if (cs.archiveJob && cs.archiveJob.target === target) return cs.archiveJob.promise;
  const promise = csLoadArchive(target).then((data) => {
    cs.archive = data;
    cs.archiveJob = null;
    return data;
  });
  // 失败也要把 job 放掉，否则下一次打开会永远等一个已经失败的 promise
  promise.catch(() => {
    cs.archiveJob = null;
  });
  cs.archiveJob = { target, promise };
  return promise;
}

/** 首页后台预取：回来只重画首页，别把用户已经点开的二级页盖掉。 */
async function csPrimeArchive(target) {
  try {
    await csArchiveData(target);
  } catch {
    return; // 拉不到就维持静态副文本，不拦抽屉
  }
  if (drawerOpen() && cs.page === "home" && cs.target === target) renderCsHome();
}

/** 档案条目按时间倒序（取不到时间的排最后）。 */
function csByNewest(items) {
  return (items || [])
    .filter(Boolean)
    .slice()
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

function csArchiveWork(data) {
  if (data.memory.disabled) return [];
  return csByNewest(data.memory.items.filter((item) => item && item.kind === "work"));
}

function csArchiveMemories(data) {
  if (data.memory.disabled) return [];
  return csByNewest(data.memory.items.filter((item) => item && item.kind !== "work"));
}

/** 四类档案的分段配置：抽屉首页的四条行与档案页的四个分段共用这一张表。 */
const CS_PROFILE_PAGES = {
  records: {
    title: "工作履历",
    tab: "履历",
    icon: "history",
    unit: "条",
    sub: "结算过的派单台账",
    empty: "还没有结算过的单子——派出去的单完工后会自动记在这里。",
    count: (data) => (data.memory.disabled ? null : csArchiveWork(data).length),
    preview: (data) => {
      if (data.memory.disabled) return "记忆未启用";
      const latest = csArchiveWork(data)[0];
      if (!latest) return "还没有";
      const day = csProfileWhen(latest.createdAt).slice(5, 10);
      return `最近：${day ? `${day} ` : ""}${csClip(latest.content, 18)}`;
    },
  },
  memories: {
    title: "记忆",
    tab: "记忆",
    icon: "notes",
    unit: "条",
    sub: "偏好 / 事实 / 经历 / 实体",
    empty: "还没有记忆。你教它的话（“记住…”）会落在这里。",
    count: (data) => (data.memory.disabled ? null : csArchiveMemories(data).length),
    preview: (data) => {
      if (data.memory.disabled) return "记忆未启用";
      const latest = csArchiveMemories(data)[0];
      if (!latest) return "还没有";
      const kind = MEMORY_KIND_LABEL[String(latest.kind || "fact")] || String(latest.kind || "fact");
      return `最近：${kind} · ${csClip(latest.content, 16)}`;
    },
  },
  routines: {
    title: "例行规则",
    tab: "规则",
    icon: "repeat",
    unit: "条",
    sub: "定时 / 事件触发的自主轮",
    empty: "还没有例行规则。",
    count: (data) => data.routines.length,
    preview: (data) => {
      const first = data.routines[0];
      if (!first) return "还没有";
      const name = String(first.name || "（未命名）");
      return first.enabled === false ? `${name} · 已停用` : name;
    },
  },
  skills: {
    title: "技能",
    tab: "技能",
    icon: "book",
    unit: "个",
    sub: "家目录里的技能手册",
    empty: "还没有技能文件。",
    count: (data) => data.skills.length,
    preview: (data) => {
      const latest = data.skills
        .slice()
        .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))[0];
      return latest ? `最近改：${String(latest.name || "")}` : "还没有";
    },
  },
};

/** 一条只读档案：日期栏（可选）+ 正文 + 一行小字 + 右端值（可选）。 */
function csArchRow({ date, dot, title, meta, tag, right }) {
  const row = document.createElement("div");
  row.className = "cs-arch-row";
  if (date) {
    const dateNode = document.createElement("span");
    dateNode.className = "cs-arch-date";
    dateNode.textContent = date;
    row.append(dateNode);
  }
  if (dot) {
    const dotNode = document.createElement("span");
    dotNode.className = `cs-arch-dot${dot === "off" ? " off" : ""}`;
    row.append(dotNode);
  }
  const main = document.createElement("div");
  main.className = "cs-arch-main";
  const text = document.createElement("span");
  text.className = "cs-arch-text";
  text.textContent = String(title || "");
  main.append(text);
  if (tag || meta) {
    const metaRow = document.createElement("span");
    metaRow.className = "cs-arch-meta";
    if (tag) {
      const chip = document.createElement("span");
      chip.className = "pill-tag";
      chip.textContent = tag;
      metaRow.append(chip);
    }
    if (meta) {
      const node = document.createElement("span");
      node.textContent = meta;
      metaRow.append(node);
    }
    main.append(metaRow);
  }
  row.append(main);
  if (right) {
    const rightNode = document.createElement("span");
    rightNode.className = "cs-arch-right";
    rightNode.textContent = right;
    row.append(rightNode);
  }
  return row;
}

function csPaintArchRecords(panel, data, config) {
  if (data.memory.disabled) {
    csProfileEmpty(panel, "记忆未启用（服务端 MEMORY_ENABLED=false），看不到工作履历。");
    return;
  }
  const items = csArchiveWork(data);
  if (!items.length) {
    csProfileEmpty(panel, config.empty);
    return;
  }
  for (const item of items) {
    const when = csProfileWhen(item.createdAt);
    const source = String(item.source || "");
    panel.append(
      csArchRow({
        date: when.slice(5, 10),
        title: item.content,
        meta: [when.slice(11), source && source !== "work" ? source : ""].filter(Boolean).join(" · "),
      }),
    );
  }
}

function csPaintArchMemories(panel, data, config) {
  if (data.memory.disabled) {
    csProfileEmpty(panel, "记忆未启用（服务端 MEMORY_ENABLED=false）。");
    return;
  }
  const items = csArchiveMemories(data);
  if (!items.length) {
    csProfileEmpty(panel, config.empty);
    return;
  }
  for (const item of items) {
    const kind = String(item.kind || "fact");
    const when = csProfileWhen(item.createdAt).slice(5, 10);
    panel.append(
      csArchRow({
        title: item.content,
        tag: MEMORY_KIND_LABEL[kind] || kind,
        meta: [String(item.source || ""), when].filter(Boolean).join(" · "),
      }),
    );
  }
}

function csPaintArchRoutines(panel, data, config) {
  if (!data.routines.length) {
    csProfileEmpty(panel, config.empty);
    return;
  }
  for (const routine of data.routines) {
    const triggers = Array.isArray(routine.triggers) ? routine.triggers : [];
    panel.append(
      csArchRow({
        dot: routine.enabled ? "on" : "off",
        title: String(routine.name || "（未命名）"),
        meta: triggers.map(csTriggerText).join(" / ") || "无触发条件",
        right: routine.enabled === false ? "停用" : routine.sessionMode === "fresh" ? "新会话" : "同会话",
      }),
    );
  }
}

function csPaintArchSkills(panel, data, config) {
  if (!data.skills.length) {
    csProfileEmpty(panel, config.empty);
    return;
  }
  const skills = data.skills
    .slice()
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  for (const skill of skills) {
    panel.append(
      csArchRow({
        title: String(skill.name || ""),
        meta: String(skill.summary || ""),
        right: csProfileWhen(skill.updatedAt).slice(5, 10),
      }),
    );
  }
}

/**
 * 档案一页四分段（B 版）：履历 / 记忆 / 规则 / 技能，全部只读。
 * 分段条上的条数来自同一份数据；首次进入先「读取中」，回来重画整页。
 */
async function renderCsArchivesPage() {
  const drawer = el.chatSettingsDrawer;
  if (!drawer) return;
  drawer.replaceChildren(csHead("档案", { back: true }));
  const body = document.createElement("div");
  body.className = "cs-body";
  body.dataset.cards = ""; // 卡片化排版（群设置共用骨架，不吃这一套）
  drawer.append(body);

  const target = cs.target;
  if (!target) {
    csProfileEmpty(
      body,
      "这条是普通助手会话，没有可看的员工档案。打开某个执事的会话，或点花名册里的「档案」再看。",
    );
    return;
  }
  // 花名册直达时目标是显式给的，未必等于当前会话身份；把「这是谁的档案」写清楚，
  // 免得出现「改了别人却以为改的是这个助手」那种谎报（csResolveTarget 注释里的老坑）。
  const partner = state.partners.find((item) => item.id === target) || null;
  const name = String(partner?.name || "").trim() || (target === "chief" ? "总管" : target);
  const who = document.createElement("p");
  who.className = "cs-note cs-note-top";
  who.textContent = `${name} · 只读。履历是结算过的单子，记忆是它自己攒的；规则在例行任务里改，技能是家目录里的文件。`;
  body.append(who);

  const data = cs.archive && cs.archive.target === target ? cs.archive : null;
  const tabs = document.createElement("div");
  tabs.className = "cs-arch-tabs";
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "档案分段");
  for (const [key, config] of Object.entries(CS_PROFILE_PAGES)) {
    const count = data ? config.count(data) : null;
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "cs-arch-tab";
    tab.dataset.tab = key;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(key === cs.archiveTab));
    tab.append(document.createTextNode(config.tab));
    const num = document.createElement("em");
    num.textContent = count == null ? "—" : String(count);
    tab.append(num);
    tab.addEventListener("click", () => {
      if (cs.archiveTab === key) return;
      cs.archiveTab = key;
      void renderCsArchivesPage();
    });
    tabs.append(tab);
  }
  body.append(tabs);

  const panel = document.createElement("div");
  panel.className = "cs-arch-panel";
  panel.setAttribute("role", "tabpanel");
  body.append(panel);

  if (!data) {
    csProfileEmpty(panel, "读取中…");
    try {
      await csArchiveData(target);
    } catch (error) {
      if (error.message !== "forbidden") csProfileEmpty(panel, `读取失败：${error.message}`);
      return;
    }
    // 晚到的响应不盖掉用户已经切走的页（同 refreshCsDetail 口径）
    if (!drawerOpen() || cs.page !== "archives" || cs.target !== target) return;
    void renderCsArchivesPage();
    return;
  }

  const config = CS_PROFILE_PAGES[cs.archiveTab] || CS_PROFILE_PAGES.records;
  const paint =
    {
      records: csPaintArchRecords,
      memories: csPaintArchMemories,
      routines: csPaintArchRoutines,
      skills: csPaintArchSkills,
    }[cs.archiveTab] || csPaintArchRecords;
  paint(panel, data, config);
}

export { CS_PROFILE_PAGES, csArchRow, csArchiveData, csArchiveMemories, csArchiveWork, csByNewest, csClip, csLoadArchive, csLoadProfileMemory, csLoadProfileRoutines, csLoadProfileSkills, csPaintArchMemories, csPaintArchRecords, csPaintArchRoutines, csPaintArchSkills, csPrimeArchive, csProfileEmpty, csProfileScope, csProfileWhen, csTriggerText, renderCsArchivesPage };
