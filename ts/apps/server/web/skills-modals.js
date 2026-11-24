/**
 * 技能编辑 / 新建 / 删除弹窗
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { attr, esc } from "./markdown.js";
import { request } from "./net.js";
import { clearModalHint, setModalHint } from "./project-modal.js";
import { readSkill, splitSkillContent, summaryInputValue } from "./skills-list.js";
import { SKILL_NAME_RE, SKILL_NEXT_TURN_HINT, SKILL_ORIGIN_LABEL, loadSkills, skillAdvice, skillLastUsedText, skillSizeText, skillWhenText } from "./skills-settings.js";
import { closeModal, openModal, toast } from "./ui-atoms.js";

/**
 * 位置在弹窗里的短名：自加位置优先用用户填的显示名（「团队手册」），
 * 没填才退回来源名（主目录 / 自加位置 / 内置目录）。整行路径只放在详情行里。
 */
function skillDirLabel(dir, origin) {
  const source = (skillAdvice?.dirs || []).find((entry) => entry && entry.dir === dir);
  if (source?.label) return String(source.label);
  return SKILL_ORIGIN_LABEL[origin] || "主目录";
}

async function openEditSkillModal(name, item = null) {
  const sourceDir = String(item?.dir || "");
  const skill = await readSkill(name, sourceDir);
  if (skill === null) return;
  const originLabel = skillDirLabel(skill.dir || sourceDir, skill.origin);
  const editable = skill.form === "flat" && skill.origin !== "agents";
  const parts = splitSkillContent(skill.content);
  // 目录形态的正文是整份 SKILL.md（含 frontmatter），摘要只能信列表里的解析结果
  const summary = skill.form === "dir" ? String(item?.summary || "") : parts.summary;
  const bodyText = skill.form === "dir" ? skill.content : parts.body;
  const note = editable
    ? `摘要就是技能索引里露出的那一行（一句话）；正文从下一行开始，保存时自动接在摘要后面。${
        skill.writable
          ? `保存写进这个位置：${esc(originLabel)}。`
          : `这是内置手册：保存会在你的技能目录里建一份同名副本（以后用副本）。`
      }保存即写文件；${SKILL_NEXT_TURN_HINT}`
    : skill.form === "dir"
      ? `目录形态（${esc(name)}/SKILL.md）：这里只读——保存只会写扁平 ${esc(name)}.md，不是改这一份。要改请去原目录（${esc(originLabel)}）。`
      : `来自只读技能目录（${esc(originLabel)}）：要改请去原目录。`;
  // 卡片上撤掉的细节在这里补全（更新时间 / 大小 / 用量 / 来源）：点开才看，不再挤列表
  const detailBits = [];
  if (item) {
    detailBits.push(`更新于 ${skillWhenText(item.updatedAt)}`);
    detailBits.push(skillSizeText(item.size));
    if (Number.isFinite(item.usageCount)) {
      const used = Number(item.usageCount);
      const ago = skillLastUsedText(item.lastUsedAt);
      detailBits.push(used > 0 ? `用过 ${used} 次${ago ? `（上次 ${ago}）` : ""}` : "没用过");
    }
    detailBits.push(`来自 ${originLabel}${skill.writable ? "" : "（只读）"}`);
    if (skill.dir) detailBits.push(`位置 ${skill.dir}`);
  }
  const detailMeta = detailBits.join(" · ");
  openModal(
    `技能 · ${name}`,
    (modalBody) => {
      if (!editable) {
        // 只读：用文本块而不是 disabled 输入框——长摘要能整段换行显示，
        // 也不会被 openModal 的「聚焦并全选第一个输入框」卷到末尾。
        modalBody.innerHTML = `
          <p class="modal-desc">${note}</p>
          ${detailMeta ? `<p class="sk-detail-meta">${esc(detailMeta)}</p>` : ""}
          <div class="modal-field">
            <span>技能名（文件名，不可在这里改）</span>
            <div class="sk-readonly">${esc(name)}</div>
          </div>
          <div class="modal-field">
            <span>${skill.form === "dir" ? "一句话摘要（frontmatter description）" : "一句话摘要（第 1 行）"}</span>
            <div class="sk-ro-text">${esc(summary || "（没有摘要）")}</div>
          </div>
          <div class="modal-field">
            <span>${skill.form === "dir" ? "SKILL.md 原文（含 frontmatter）" : "正文（Markdown）"}</span>
            <pre class="sk-ro-pre">${esc(bodyText)}</pre>
          </div>
          <div class="modal-actions">
            <button class="ghost" type="button" data-modal-cancel>关闭</button>
          </div>`;
        modalBody.querySelector("[data-modal-cancel]")?.addEventListener("click", closeModal);
        return;
      }
      modalBody.innerHTML = `
        <p class="modal-desc">${note}</p>
        ${detailMeta ? `<p class="sk-detail-meta">${esc(detailMeta)}</p>` : ""}
        <div class="modal-field">
          <span>技能名（文件名，不可在这里改）</span>
          <div class="sk-readonly">${esc(name)}</div>
        </div>
        <div class="modal-field">
          <span>一句话摘要（第 1 行）</span>
          <input class="modal-input" id="sk-summary" type="text" spellcheck="false" />
        </div>
        <div class="modal-field">
          <span>正文（Markdown，≤64KB）</span>
          <textarea class="sk-ta" id="sk-content" rows="14" spellcheck="false"></textarea>
        </div>
        <p class="modal-hint" id="sk-hint"></p>
        <div class="modal-actions">
          <button class="ghost" type="button" data-modal-cancel>取消</button>
          <button class="modal-primary" id="sk-save" type="button">保存</button>
        </div>`;
      const summaryField = modalBody.querySelector("#sk-summary");
      const area = modalBody.querySelector("#sk-content");
      const hint = modalBody.querySelector("#sk-hint");
      const save = modalBody.querySelector("#sk-save");
      summaryField.value = summary;
      area.value = bodyText;
      modalBody.querySelector("[data-modal-cancel]")?.addEventListener("click", closeModal);
      summaryField.addEventListener("input", () => clearModalHint(hint));
      area.addEventListener("input", () => clearModalHint(hint));

      const submit = async () => {
        if (save.disabled) return;
        const nextSummary = summaryInputValue(summaryField.value);
        if (!nextSummary) {
          setModalHint(hint, "摘要不能为空——它就是技能索引里露出的那一行。");
          summaryField.focus();
          return;
        }
        if (!area.value.trim()) {
          setModalHint(hint, "正文不能为空。");
          area.focus();
          return;
        }
        save.disabled = true;
        setModalHint(hint, "保存中…", false);
        try {
          const response = await request(`/api/v1/agent/skills/${encodeURIComponent(name)}`, {
            method: "PUT",
            body: JSON.stringify({
              content: `${nextSummary}\n${area.value}`,
              // 只读来源（内置手册）不带 dir：落到主目录建副本，这是 9-S 的合并语义
              ...(skill.writable && skill.dir ? { dir: skill.dir } : {}),
            }),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) {
            setModalHint(hint, data.message || `没保存：HTTP ${response.status}`);
            return;
          }
          closeModal();
          toast("技能已保存");
          void loadSkills();
        } catch (error) {
          if (error.message === "forbidden") { closeModal(); return; }
          setModalHint(hint, `没保存：${error.message}`);
        } finally {
          save.disabled = false;
        }
      };
      save.addEventListener("click", () => void submit());
    },
    { className: "modal-wide" },
  );
}

/**
 * 新建技能（全局库）。
 * options.onCreated(name)：2026-11-15 个人页复用——建完自动只给当前执事打开。
 * options.existingHint：同名已存在时的提示（个人页指向「设置 → 注入 → 技能 / 让他自己写」）。
 */
function openCreateSkillModal(options = {}) {
  // 位置选择（2026-11-23）：只有一个可写位置时不画下拉（默认就写那里，别多一个控件）；
  // 有多个才让选，默认主目录——老习惯（不选位置）保持不变。
  const writableDirs = (skillAdvice.dirs || []).filter((source) => source.writable === true);
  const dirOf = (source) => source.label || SKILL_ORIGIN_LABEL[source.origin] || "主目录";
  const defaultDir = writableDirs.some((source) => source.dir === skillAdvice.dir)
    ? skillAdvice.dir
    : String(writableDirs[0]?.dir || "");
  const dirOptions = writableDirs
    .map(
      (source) =>
        `<option value="${attr(source.dir)}"${source.dir === defaultDir ? " selected" : ""}>${esc(dirOf(source))} — ${esc(source.dir)}</option>`,
    )
    .join("");
  openModal(
    "新建技能",
    (body) => {
      body.innerHTML = `
        <p class="modal-desc">技能名就是文件名（小写字母 / 数字 / 短横线 / 下划线）。摘要单独一行写；正文从下一行开始，保存时自动接在摘要后面。${SKILL_NEXT_TURN_HINT}</p>
        <div class="modal-field">
          <span>技能名</span>
          <input class="modal-input is-mono" id="sk-new-name" type="text" maxlength="64"
                 spellcheck="false" placeholder="例如 daily-brief" />
        </div>
        ${
          writableDirs.length > 1
            ? `<div class="modal-field">
          <span>保存到</span>
          <select class="modal-input" id="sk-new-dir">${dirOptions}</select>
        </div>`
            : ""
        }
        <div class="modal-field">
          <span>一句话摘要（第 1 行）</span>
          <input class="modal-input" id="sk-new-summary" type="text"
                 spellcheck="false" placeholder="一句话说清这份手册教什么" />
        </div>
        <div class="modal-field">
          <span>正文（Markdown，≤64KB）</span>
          <textarea class="sk-ta" id="sk-new-content" rows="12" spellcheck="false"
                    placeholder="从第二行起：完整手册…"></textarea>
        </div>
        <p class="modal-hint" id="sk-new-hint"></p>
        <div class="modal-actions">
          <button class="ghost" type="button" data-modal-cancel>取消</button>
          <button class="modal-primary" id="sk-new-go" type="button">新建</button>
        </div>`;
      const nameInput = body.querySelector("#sk-new-name");
      const dirSelect = body.querySelector("#sk-new-dir");
      const summaryInput = body.querySelector("#sk-new-summary");
      const area = body.querySelector("#sk-new-content");
      const hint = body.querySelector("#sk-new-hint");
      const go = body.querySelector("#sk-new-go");
      body.querySelector("[data-modal-cancel]")?.addEventListener("click", closeModal);

      const submit = async () => {
        if (go.disabled) return;
        const name = nameInput.value.trim();
        if (!SKILL_NAME_RE.test(name)) {
          setModalHint(hint, "技能名只能是小写字母 / 数字 / 短横线 / 下划线，1-64 字符。");
          nameInput.focus();
          return;
        }
        const summary = summaryInputValue(summaryInput.value);
        if (!summary) {
          setModalHint(hint, "摘要不能为空——它就是技能索引里露出的那一行。");
          summaryInput.focus();
          return;
        }
        if (!area.value.trim()) {
          setModalHint(hint, "正文不能为空。");
          area.focus();
          return;
        }
        go.disabled = true;
        setModalHint(hint, "创建中…", false);
        try {
          const targetDir = String(dirSelect?.value || "");
          // 先探一下同名：新建不该悄悄覆盖已有技能（要改请从列表点开）
          const samePlace = await request(
            `/api/v1/agent/skills/${encodeURIComponent(name)}${targetDir ? `?dir=${encodeURIComponent(targetDir)}` : ""}`,
            { cache: "no-store" },
          );
          if (samePlace.ok) {
            setModalHint(
              hint,
              options.existingHint || "这个位置里已有同名技能；要改它请关掉这里、从列表点开编辑。",
            );
            return;
          }
          // 写到自加位置时再多看一眼读取链：别处已有同名 → 先到先得会用那一份，这一条会白写
          if (targetDir && targetDir !== skillAdvice.dir) {
            const elsewhere = await request(`/api/v1/agent/skills/${encodeURIComponent(name)}`, {
              cache: "no-store",
            });
            if (elsewhere.ok) {
              const info = await elsewhere.json().catch(() => ({}));
              setModalHint(
                hint,
                options.existingHint ||
                  `技能库里已有同名技能（在 ${info.dir || "另一个位置"}）：先到先得会用那一份，这一条会被盖住。换个名字，或先删掉那一条。`,
              );
              return;
            }
          }
          const response = await request(`/api/v1/agent/skills/${encodeURIComponent(name)}`, {
            method: "PUT",
            body: JSON.stringify({
              content: `${summary}\n${area.value}`,
              ...(targetDir ? { dir: targetDir } : {}),
            }),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) {
            setModalHint(hint, data.message || `没建成：HTTP ${response.status}`);
            return;
          }
          closeModal();
          toast("技能已新建");
          void loadSkills();
          // 个人页：建到全局库后，再只给当前这个人开；回调失败不该吞掉"已建成"的事实
          try {
            const result = options.onCreated?.(name);
            if (result && typeof result.catch === "function") {
              result.catch((error) => console.warn("技能新建回调失败", error));
            }
          } catch (error) {
            console.warn("技能新建回调失败", error);
          }
        } catch (error) {
          if (error.message === "forbidden") { closeModal(); return; }
          setModalHint(hint, `没建成：${error.message}`);
        } finally {
          go.disabled = false;
        }
      };
      go.addEventListener("click", () => void submit());
      nameInput.addEventListener("input", () => clearModalHint(hint));
      summaryInput.addEventListener("input", () => clearModalHint(hint));
      area.addEventListener("input", () => clearModalHint(hint));
      nameInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") { event.preventDefault(); void submit(); }
      });
    },
    { className: "modal-wide" },
  );
}

function openDeleteSkillModal(name, dir = "") {
  openModal("删除技能", (body) => {
    body.innerHTML = `
      <p class="modal-desc">删除 <b>${esc(name)}</b> 后，这份手册不再加载。${SKILL_NEXT_TURN_HINT}</p>
      ${dir ? `<p class="sk-detail-meta">位置：${esc(dir)}（只删这一份）</p>` : ""}
      <p class="modal-hint" id="sk-del-hint"></p>
      <div class="modal-actions">
        <button class="ghost" type="button" data-modal-cancel>先留着</button>
        <button class="modal-danger" id="sk-del-go" type="button">确认删除</button>
      </div>`;
    const hint = body.querySelector("#sk-del-hint");
    const go = body.querySelector("#sk-del-go");
    body.querySelector("[data-modal-cancel]")?.addEventListener("click", closeModal);
    go.addEventListener("click", async () => {
      if (go.disabled) return;
      go.disabled = true;
      setModalHint(hint, "删除中…", false);
      try {
        const response = await request(
          `/api/v1/agent/skills/${encodeURIComponent(name)}${dir ? `?dir=${encodeURIComponent(dir)}` : ""}`,
          { method: "DELETE" },
        );
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          setModalHint(hint, data.message || `没删掉：HTTP ${response.status}`);
          return;
        }
        closeModal();
        toast("技能已删除");
        void loadSkills();
      } catch (error) {
        if (error.message === "forbidden") { closeModal(); return; }
        setModalHint(hint, `没删掉：${error.message}`);
      } finally {
        go.disabled = false;
      }
    });
  });
}

export { openCreateSkillModal, openDeleteSkillModal, openEditSkillModal };
