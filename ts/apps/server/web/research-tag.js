/**
 * 项目「研究」标记（2026-11-20）。
 *
 * 纯前端：只在本机浏览器的 localStorage 记一组项目 id，用来在项目行 / 项目卡上多显示
 * 一枚「研究」小标签。**不写服务端、不进契约、模型看不见**；换浏览器或清缓存会丢，
 * 也不同步手机。项目本身仍是普通项目，选中 / 文件 / 归档 / 删除行为一字不变。
 *
 * 开关入口：侧栏项目行右键菜单、设置 → 项目卡 ⋯ 菜单。
 */

const KEY = "lifediary.researchProjects";

function readIds() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((id) => typeof id === "string" && id) : [];
  } catch {
    return [];
  }
}

function writeIds(ids) {
  try {
    localStorage.setItem(KEY, JSON.stringify([...new Set(ids)]));
  } catch {
    /* 隐私模式 / 配额满：标记是个纯装饰，写不进去就算了 */
  }
}

/** 这个项目有没有加「研究」标记。 */
function isResearchProject(projectId) {
  const id = String(projectId || "");
  return Boolean(id) && readIds().includes(id);
}

/** 开 / 关标记，返回切换后的状态（true = 现在带标记）。 */
function toggleResearchProject(projectId) {
  const id = String(projectId || "");
  if (!id) return false;
  const ids = readIds();
  const on = ids.includes(id);
  writeIds(on ? ids.filter((item) => item !== id) : [...ids, id]);
  return !on;
}

/** 项目行 / 卡片上的小标签（调用方自己决定插在哪）。 */
function researchTagNode() {
  const tag = document.createElement("span");
  tag.className = "proj-tag is-research";
  tag.textContent = "研究";
  tag.title = "只是本机界面上的标记，不影响项目本身（右键项目行可取消）";
  return tag;
}

export { isResearchProject, researchTagNode, toggleResearchProject };
