/**
 * 二级页 · 模型
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { el } from "./dom.js";
import { fetchModelCatalog, menuProviders, normalizeModelRow, renderModelMenu } from "./hover-tip.js";
import { CS_ICONS } from "./icons.js";
import { request } from "./net.js";
import { cs, csCard, csHead, csLoadProviders, csSvg, partnerModelChain } from "./settings-drawer.js";
import { KEY_MODEL_PROVIDER } from "./shell.js";
import { state } from "./state.js";
import { closePopover, openPopover, popoverOpen } from "./ui-atoms.js";

/* ── 二级页 · 模型：主选 + 备选同页 ─────────────────────────
 * 用户口径（2026-11-07）：「选模型那个功能，应该跟设置里那个是一个方法吧」
 *   「调整人设、调整模型（主选模型和备选模型），都是在自己已有的这些里调，这俩应该是一样的设置」。
 *
 * 所以这一页是**同一个角色**的两件模型设置，共用一份「已有模型」清单：
 *   ① 主选：全局运行时模型（POST /agent/model，下一轮生效）——与 composer pill、
 *      设置→模型的默认模型行是同一个接口、同一套目录，不另造一份；
 *   ② 备选：这个执事的候选链（PATCH /partners/:id { modelChain }）——只在主模型
 *      「没应答且原因可切」时按链往下换，keyEnv 只填变量名（密钥纪律）。
 * 两段都从**已有**模型里选（选项来自 /agent/model），不再要求手打
 * providerId|modelId|KEY_ENV_NAME。批量加模型卡退役（2026-11-08 用户口径：
 * 「模型肯定是能出现的，手输兜底没用」）——加模型的正式入口在 设置 → 模型。 */
function renderCsModelPage() {
  const drawer = el.chatSettingsDrawer;
  const catalog = cs.catalog;
  if (!drawer || !catalog) return;
  drawer.replaceChildren(csHead("模型", { back: true }));
  const body = document.createElement("div");
  body.className = "cs-body";
  body.dataset.cards = ""; // 卡片化排版（群设置共用骨架，不吃这一套）
  drawer.append(body);
  const providers = menuProviders(catalog);
  body.append(csModelWho());
  body.append(csPrimaryCard(providers, catalog.current || null));
  // 备选链挂在执事身上；普通助手会话没有链可配，不摆这张卡
  if (cs.target) body.append(csFallbackCard(providers));
}

/** 这页改的是谁：避免在执事会话里以为改了执事、其实改的是全局主选 */
function csModelWho() {
  const partner = state.partners.find((item) => item.id === cs.target);
  const name = String(partner?.name || "").trim() || "总管";
  const node = document.createElement("p");
  node.className = "cs-note";
  node.style.padding = "0 2px 2px";
  node.textContent = `主选对所有对话生效；备选只属于「${name}」。`;
  return node;
}

/** ① 主选：与设置页「默认模型」同一个接口（POST /agent/model），只是换成下拉 */
function csPrimaryCard(providers, current) {
  const card = csCard("主选模型");
  const field = document.createElement("div");
  field.className = "cs-field";
  field.innerHTML = `
    <div class="cs-model-pick">
      <button type="button" class="cs-input cs-model-trigger" id="cs-primary-trigger"
              aria-haspopup="menu" aria-expanded="false">
        <span class="cs-model-label" id="cs-primary-label"></span>
        <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      <div class="model-menu composer-pop cs-model-menu" id="cs-primary-menu" role="menu" hidden></div>
    </div>
    <span class="cs-hint" id="cs-primary-hint">切换后下一轮生效。</span>`;
  card.append(field);
  const trigger = field.querySelector("#cs-primary-trigger");
  const label = field.querySelector("#cs-primary-label");
  const menu = field.querySelector("#cs-primary-menu");
  const hint = field.querySelector("#cs-primary-hint");

  const paintLabel = () => {
    const cur = state.modelCatalog?.current || current || null;
    label.textContent = cur ? cur.modelId : "还没选模型";
    label.title = cur ? `${cur.providerId} · ${cur.modelId}` : "";
  };
  paintLabel();

  if (!providers.length) {
    trigger.disabled = true;
    label.textContent = "还没有可选模型";
    hint.textContent = "配好供应商后这里就有清单了。";
    return card;
  }

  trigger.addEventListener("click", async () => {
    if (popoverOpen(menu)) {
      closePopover(menu, trigger);
      return;
    }
    trigger.disabled = true;
    try {
      // 每次打开都现拉：不缓存陈旧目录（同 composer 菜单，审查 S2）
      const catalog = await fetchModelCatalog();
      cs.catalog = catalog;
      state.modelCatalog = catalog;
      renderModelMenu(catalog, localStorage.getItem(KEY_MODEL_PROVIDER), menu);
      openPopover(menu, trigger);
    } catch (error) {
      if (error.message !== "forbidden") {
        hint.textContent = "拿不到模型清单，稍后再试。";
        hint.classList.add("is-error");
      }
    } finally {
      trigger.disabled = false;
    }
  });

  // 当前模型不在清单里（供应商被删 / 模型下线）：触发钮照常显示它，提示里说明，
  // 用户从菜单里选一个就换掉了（不再造一条原生 select 的占位 option）
  if (current) {
    const inCatalog = providers.some(
      (provider) =>
        provider.id === current.providerId &&
        provider.models.some((raw) => normalizeModelRow(raw)?.id === current.modelId),
    );
    if (!inCatalog) {
      label.title = `${current.providerId} · ${current.modelId}（当前，已不在清单）`;
      hint.textContent = "当前模型已不在清单里，打开上面选一个换掉。";
    }
  }
  // chooseModel 成功后会在菜单宿主上派发 modelchange（冒泡）：触发钮名字跟上去
  menu.addEventListener("modelchange", paintLabel);
  return card;
}

/**
 * 备选链编辑器（2026-11-07 抽出，抽屉与设置弹窗共用）。
 *
 * 用户口径：「调整人物的页面，和打开一个人后点击右上角那个设置页面，
 * 这两个应该是差不多的，都可以用 EP（API）接口」。
 * 原来两处形态完全不同：抽屉是下拉，弹窗要手打 `providerId|modelId|KEY_ENV_NAME`。
 * 现在统一成这一份：**从已有模型里选**（供应商 + 模型两个下拉），顺序可调，
 * keyEnv 由供应商记录带出（密钥纪律：值永不落档案，页面也不让填）。
 *
 * 回调口径：
 *   onSaved(next) —— 服务端接受后把新链交回调用方（弹窗用来同步抽屉的详情缓存）
 */
async function mountChainEditor(host, { partnerId, chain, onSaved }) {
  if (!host || !partnerId) return;
  let list = Array.isArray(chain) ? chain.slice() : [];
  const keys = new Map();

  host.innerHTML = `
    <div class="cs-chain" data-chain-rows></div>
    <p class="cs-hint" data-chain-hint></p>`;
  const rowsBox = host.querySelector("[data-chain-rows]");
  const hint = host.querySelector("[data-chain-hint]");
  const setHint = (text, isError = false) => {
    hint.textContent = text || "";
    hint.classList.toggle("is-error", isError && Boolean(text));
  };

  // 已有模型清单：优先用调用方已经拉过的目录，没有再自己拉一次（两处都不额外造数据源）
  let catalog = state.modelCatalog;
  if (!catalog || !menuProviders(catalog).length) {
    catalog = await fetchModelCatalog().catch(() => null);
  }
  const known = menuProviders(catalog || {});

  const paint = () => {
    rowsBox.replaceChildren();
    if (!list.length) {
      const empty = document.createElement("div");
      empty.className = "cs-chain-empty";
      empty.textContent = "还没有备选。主模型失败时直接报错，不会自动换。";
      rowsBox.append(empty);
    } else {
      list.forEach((item, index) => rowsBox.append(chainRow(item, index)));
    }
    const bar = document.createElement("div");
    bar.className = "cs-chain-add";
    const add = document.createElement("button");
    add.type = "button";
    add.className = "cs-chain-add-btn";
    add.disabled = list.length >= 5 || !known.length;
    add.append(csSvg(CS_ICONS.plus));
    const label = document.createElement("span");
    label.textContent = "加一条备选";
    add.append(label);
    add.addEventListener("click", () => void addOne());
    bar.append(add);
    if (list.length >= 5) {
      const limit = document.createElement("span");
      limit.className = "cs-hint";
      limit.textContent = "已到上限 5 条";
      bar.append(limit);
    }
    rowsBox.append(bar);
  };

  /* 一条备选 = 序号 + 一个「供应商 / 模型」分组下拉 + 上移下移删除。
     用分组下拉而不是并排两个 select：448px 里两个并排各自只剩 90px，
     模型 id（kimi/kimi-k3.1-pro-highspeed）会被截成一样的开头；
     分组下拉与主选那一处是同一个控件形状，符合「这俩应该是一样的设置」。 */
  function chainRow(item, index) {
    const row = document.createElement("div");
    row.className = "cs-chain-row";

    const order = document.createElement("span");
    order.className = "cs-chain-order";
    order.textContent = String(index + 1);
    row.append(order);

    const select = document.createElement("select");
    select.className = "cs-input cs-chain-pick";
    select.setAttribute("aria-label", `第 ${index + 1} 条备选`);
    for (const provider of known) {
      const group = document.createElement("optgroup");
      group.label = provider.name || provider.id;
      for (const raw of provider.models) {
        const model = normalizeModelRow(raw);
        if (!model) continue;
        const option = document.createElement("option");
        option.value = `${provider.id}|${model.id}`;
        option.textContent = model.id;
        if (provider.id === item.providerId && model.id === item.modelId) option.selected = true;
        group.append(option);
      }
      if (group.children.length) select.append(group);
    }
    // 链里引用的模型已被删掉 / 供应商已移除：补一条占位，别让下拉静默跳到第一家
    const value = `${item.providerId}|${item.modelId}`;
    if (!known.some((provider) => provider.id === item.providerId &&
      provider.models.some((raw) => normalizeModelRow(raw)?.id === item.modelId))) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = `${item.providerId} / ${item.modelId}（已不在清单）`;
      option.selected = true;
      select.prepend(option);
    }
    select.addEventListener("change", () => {
      const [providerId, modelId] = String(select.value).split("|");
      if (!providerId || !modelId) return;
      void patch(index, { providerId, modelId });
    });
    row.append(select);

    const actions = document.createElement("div");
    actions.className = "cs-chain-actions";
    const iconBtn = (title, paths, handler, disabled) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "cs-chain-btn";
      button.title = title;
      button.setAttribute("aria-label", title);
      button.disabled = disabled;
      button.append(csSvg(paths));
      button.addEventListener("click", handler);
      return button;
    };
    actions.append(
      iconBtn("上移", CS_ICONS.arrowUp, () => void move(index, -1), index === 0),
      iconBtn("下移", CS_ICONS.arrowDown, () => void move(index, 1), index === list.length - 1),
      iconBtn("删掉这条", CS_ICONS.x, () => void save(list.filter((_, at) => at !== index)), false),
    );
    row.append(actions);
    return row;
  }

  async function move(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= list.length) return;
    const next = list.slice();
    [next[index], next[target]] = [next[target], next[index]];
    await save(next);
  }

  async function patch(index, step) {
    const next = list.map((entry, at) => {
      if (at !== index) return entry;
      const providerId = step.providerId || entry.providerId;
      return {
        providerId,
        modelId: step.modelId || entry.modelId,
        // keyEnv 跟着供应商走；没读到就保留原值，保存前会明确拦下
        keyEnv: keys.get(providerId) || entry.keyEnv || "",
      };
    });
    await save(next);
  }

  async function addOne() {
    const used = new Set(list.map((entry) => `${entry.providerId}|${entry.modelId}`));
    let pick = null;
    for (const provider of known) {
      for (const raw of provider.models) {
        const model = normalizeModelRow(raw);
        if (!model || used.has(`${provider.id}|${model.id}`)) continue;
        pick = { providerId: provider.id, modelId: model.id };
        break;
      }
      if (pick) break;
    }
    if (!pick) {
      setHint("清单里的模型都已经在链里了。", true);
      return;
    }
    await save([...list, { ...pick, keyEnv: keys.get(pick.providerId) || "" }]);
  }

  async function save(next) {
    const missing = next.filter((item) => !item.keyEnv);
    if (missing.length) {
      setHint("有供应商没读到 keyEnv（供应商配置缺变量名），先到全部设置 → 模型里补上。", true);
      return;
    }
    setHint("保存中…");
    try {
      const response = await request(`/api/v1/partners/${encodeURIComponent(partnerId)}`, {
        method: "PATCH",
        body: JSON.stringify({ modelChain: next }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setHint(data.message || data.error || `没存成：HTTP ${response.status}`, true);
        return;
      }
      list = next.map((item) => ({ ...item }));
      setHint(next.length ? "" : "已清空：以后主模型失败就直接报错。");
      paint();
      onSaved?.(list);
    } catch (error) {
      if (error.message === "forbidden") return;
      setHint(`没存成：${error.message}`, true);
    }
  }

  paint();
  // keyEnv 要等供应商投影回来才有：回来后就地补一份并重画（链本身没变）
  void csLoadProviders().then((rows) => {
    if (!rows) return;
    for (const item of rows) keys.set(item.id, item.keyEnv || "");
    paint();
  });
}

/** 抽屉里的「备选模型」卡片：外层说明 + 共用编辑器 */
function csFallbackCard(providers) {
  const card = csCard("备选模型");
  const note = document.createElement("div");
  note.className = "cs-note";
  note.style.padding = "0 14px 10px";
  note.textContent = cs.target
    // 生效范围按代码实况写：链只在执事的试跑与例行任务轮次里走
    // （partner-runtime.runPartnerTurn → nextChainCandidate）；主对话的 chatStream 不读链。
    // 写成「主模型失败就自动换」是虚假承诺，用户会以为聊天也有兜底。
    ? "只在试跑与例行任务轮次里生效（主对话不换）：那一轮没应答且原因可切时，按顺序换下一条重跑。最多 5 条。"
    : "备选链属于执事，普通助手会话没有。到「全部设置 → 人设」里给某个执事配。";
  card.append(note);
  if (!cs.target) return card;
  const box = document.createElement("div");
  card.append(box);
  void mountChainEditor(box, {
    partnerId: cs.target,
    chain: partnerModelChain(),
    onSaved: (next) => {
      if (cs.detail) cs.detail.modelChain = next;
    },
  });
  return card;
}

export { csFallbackCard, csModelWho, csPrimaryCard, mountChainEditor, renderCsModelPage };
