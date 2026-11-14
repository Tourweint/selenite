/**
 * 设置 → 会话 · 上下文压缩（2026-11-14）
 *
 * 最终形态（用户两次拍板）：**只留「按百分比」和「按 token」两档，默认按百分比 70%**。
 * 保留原文 / 后台提前不上界面——那不是能凭直觉调的量，一律吃内核默认。
 *
 * 数据面走既有 flags 端点（`GET /api/v1/agent/flags`、`PUT /api/v1/agent/flags/:key`），
 * 键全 hot：改完下一轮就按新档压（消费处是 Harness settings 访问器，每次使用现算）。
 *
 * 口径（与 `ts/apps/server/src/compaction-settings.ts` 一一对应，别在这里另立一套）：
 *   - 两个档都是「上下文用到多少就压一次，压完继续跑这一轮」：
 *     窗口 100K、按 token 填 70 = 到 70K 压一次；按百分比填 70 = 到 70K 压一次；
 *   - K = 1024 token；百分比按每个模型自己的窗口换算成它自己的触发点。
 *
 * 这里**不再**放常驻的"读不到开关"提示：读失败只影响回显，静默按默认显示，
 * 写失败走 toast——常驻一行错误既不自愈也关不掉，那是纯噪音。
 */

import { request } from "./net.js";
import { mountSegmented, rowMarkup, sectionMarkup, switchMarkup, syncSegmented } from "./settings-atoms.js";
import { toast } from "./ui-atoms.js";

const COMPACT_KEYS = {
  enabled: "AGENT_COMPACT_ENABLED",
  mode: "AGENT_COMPACT_TRIGGER_MODE",
  percent: "AGENT_COMPACT_TRIGGER_PERCENT",
  triggerK: "AGENT_COMPACT_TRIGGER_K",
};

/** 与服务端 `compaction-settings.ts` 的 DEFAULT_PERCENT 必须一致 */
const COMPACT_DEFAULT_PERCENT = 70;

/** 一节 = 标题在卡片外、卡片里三行（开关 / 怎么算 / 到多少压） */
function compactionSectionMarkup() {
  return sectionMarkup(
    "上下文压缩",
    `<div class="card">
      ${rowMarkup(
        "自动压缩",
        "上下文到了下面这个点，先压成摘要再接着跑这一轮；关掉后只能手动 /compact。",
        switchMarkup(true, { label: "自动压缩", attrs: "data-compact-enabled" }),
      )}
      <div class="divider"></div>
      ${rowMarkup(
        "按什么算",
        "百分比按每个模型自己的窗口换算（100K 的窗口填 70 = 70K 时压）；按 token 是写死的绝对量，对所有模型一样。",
        `<div class="segmented slide" role="radiogroup" aria-label="压缩触发点" data-compact-mode>
           <button type="button" data-value="percent" aria-checked="true">按百分比</button>
           <button type="button" data-value="token" aria-checked="false">按 token</button>
         </div>`,
      )}
      <div class="divider"></div>
      ${rowMarkup(
        "到多少压一次",
        "压完接着跑这一轮，不是压完就停。按 token 填得超过窗口时会夹到「窗口减 1K」，等于几乎每轮都压。",
        `<div class="compact-start">
           <label class="compact-start-row" data-compact-unit="percent">
             <input class="set-input compact-num" id="compact-percent" type="number" min="5" max="95" step="1"
                    placeholder="70" aria-label="压缩触发百分比" />
             <span class="compact-suffix">% 窗口</span>
           </label>
           <label class="compact-start-row" data-compact-unit="token" hidden>
             <input class="set-input compact-num" id="compact-trigger-k" type="number" min="1" step="1"
                    placeholder="例如 70" aria-label="压缩触发的 token 数（千）" />
             <span class="compact-suffix">K token</span>
           </label>
         </div>`,
      )}
    </div>`,
    "data-compact-sec",
  );
}

/** 只显示当前档的那一个输入框（两选一，别把用不上的晾在旁边当摆设） */
function syncCompactUnits(root, mode) {
  const live = mode === "tokens" ? "token" : "percent";
  for (const unit of root.querySelectorAll("[data-compact-unit]")) {
    unit.hidden = unit.dataset.compactUnit !== live;
  }
}

async function loadCompactionSettings(root = document) {
  const box = root.querySelector("[data-compact-sec]");
  if (!box) return;
  const switchEl = box.querySelector("[data-compact-enabled]");
  const modeEl = box.querySelector("[data-compact-mode]");
  const percentEl = box.querySelector("#compact-percent");
  const triggerEl = box.querySelector("#compact-trigger-k");
  if (!modeEl) return;

  const values = {};
  try {
    const response = await request("/api/v1/agent/flags", { cache: "no-store" });
    if (response.ok) {
      const data = await response.json().catch(() => ({}));
      for (const flag of Array.isArray(data.flags) ? data.flags : []) {
        if (!flag?.key) continue;
        if (Object.values(COMPACT_KEYS).includes(flag.key)) values[flag.key] = String(flag.value ?? "");
      }
    }
  } catch (error) {
    // 403 = 没令牌：网关页已经在报，这里不要再叠一层。其余失败静默按默认显示。
    if (error.message === "forbidden") return;
  }

  if (switchEl) {
    switchEl.setAttribute("aria-checked", String((values[COMPACT_KEYS.enabled] || "true") !== "false"));
  }
  const modeRaw = values[COMPACT_KEYS.mode] || "percent";
  const mode = modeRaw === "tokens" ? "tokens" : "percent";
  // 按钮上是给人看的写法（token），存的是枚举（tokens）
  const buttonValue = mode === "tokens" ? "token" : "percent";
  for (const button of modeEl.querySelectorAll("button")) {
    button.setAttribute("aria-checked", String(button.dataset.value === buttonValue));
  }
  mountSegmented(modeEl);
  syncSegmented(modeEl);
  syncCompactUnits(box, mode);

  if (percentEl instanceof HTMLInputElement) {
    const raw = Number(values[COMPACT_KEYS.percent]);
    const percent = Number.isFinite(raw) && raw > 0 ? Math.round(raw) : COMPACT_DEFAULT_PERCENT;
    percentEl.value = String(percent);
    percentEl.defaultValue = String(percent);
  }
  if (triggerEl instanceof HTMLInputElement) {
    triggerEl.value = values[COMPACT_KEYS.triggerK] || "";
    triggerEl.defaultValue = triggerEl.value;
  }
}

/** 数值写盘：空值 = 删掉覆盖、回落默认（服务端 `setFlag` 对数值型开关认空串） */
async function saveCompactNumber(input, key, { min, max }) {
  const previous = input.defaultValue;
  const raw = input.value.trim();
  if (!raw) {
    input.value = "";
    input.defaultValue = "";
    try {
      const response = await request(`/api/v1/agent/flags/${encodeURIComponent(key)}`, {
        method: "PUT",
        body: JSON.stringify({ value: "" }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        toast(data.message || `没存成：HTTP ${response.status}`);
        input.value = previous;
        input.defaultValue = previous;
        return;
      }
      toast("已恢复默认，下一轮生效");
    } catch (error) {
      if (error.message !== "forbidden") toast(`没存成：${error.message}`);
      input.value = previous;
      input.defaultValue = previous;
    }
    return;
  }
  let value = Math.round(Number(raw));
  if (!Number.isFinite(value)) value = Number(previous) || min;
  if (max !== undefined) value = Math.min(max, value);
  value = Math.max(min, value);
  input.value = String(value);
  try {
    const response = await request(`/api/v1/agent/flags/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify({ value: String(value) }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      toast(data.message || `没存成：HTTP ${response.status}`);
      input.value = previous;
      return;
    }
    input.defaultValue = String(value);
    toast(data.hot === false ? "已保存，重启服务后生效" : "已保存，下一轮生效");
  } catch (error) {
    if (error.message !== "forbidden") toast(`没存成：${error.message}`);
    input.value = previous;
  }
}

/** 挂事件 + 回填；设置页每次进「会话」都会重新渲染，事件只在这一份 DOM 上绑 */
function wireCompactionSection(root = document) {
  const box = root.querySelector("[data-compact-sec]");
  if (!box) return;
  const modeEl = box.querySelector("[data-compact-mode]");
  const switchEl = box.querySelector("[data-compact-enabled]");

  switchEl?.addEventListener("click", async () => {
    const next = switchEl.getAttribute("aria-checked") !== "true";
    switchEl.setAttribute("aria-checked", String(next));
    try {
      const response = await request(`/api/v1/agent/flags/${COMPACT_KEYS.enabled}`, {
        method: "PUT",
        body: JSON.stringify({ value: String(next) }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || `HTTP ${response.status}`);
      toast(data.hot === false ? "已保存，重启服务后生效" : "已保存，下一轮生效");
    } catch (error) {
      switchEl.setAttribute("aria-checked", String(!next));
      if (error.message !== "forbidden") toast(`没存成：${error.message}`);
    }
  });

  if (modeEl) {
    mountSegmented(modeEl);
    for (const button of modeEl.querySelectorAll("button")) {
      button.addEventListener("click", async () => {
        if (button.getAttribute("aria-checked") === "true") return;
        const value = button.dataset.value;
        for (const other of modeEl.querySelectorAll("button")) {
          other.setAttribute("aria-checked", String(other === button));
        }
        syncSegmented(modeEl);
        syncCompactUnits(box, value === "token" ? "tokens" : "percent");
        try {
          // 按钮的 data-value 是给人看的（token），存进服务端的是枚举（tokens）
          const stored = value === "token" ? "tokens" : "percent";
          const response = await request(`/api/v1/agent/flags/${COMPACT_KEYS.mode}`, {
            method: "PUT",
            body: JSON.stringify({ value: stored }),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.message || `HTTP ${response.status}`);
          toast(data.hot === false ? "已保存，重启服务后生效" : "已保存，下一轮生效");
        } catch (error) {
          if (error.message !== "forbidden") toast(`没存成：${error.message}`);
          void loadCompactionSettings(document);
        }
      });
    }
  }

  const percentEl = box.querySelector("#compact-percent");
  if (percentEl instanceof HTMLInputElement) {
    percentEl.addEventListener("change", () =>
      void saveCompactNumber(percentEl, COMPACT_KEYS.percent, { min: 5, max: 95 }),
    );
  }
  const triggerEl = box.querySelector("#compact-trigger-k");
  if (triggerEl instanceof HTMLInputElement) {
    triggerEl.addEventListener("change", () =>
      void saveCompactNumber(triggerEl, COMPACT_KEYS.triggerK, { min: 1 }),
    );
  }

  void loadCompactionSettings(document);
}

export { COMPACT_KEYS, compactionSectionMarkup, wireCompactionSection };
