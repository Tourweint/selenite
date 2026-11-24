/**
 * 项目相对路径的归一规则（2026-11-03 方案 §5.4）。
 *
 * 声明、租约、worktree 差异三处必须用同一套口径，否则「声明了但检出越权」
 * 会变成一笔糊涂账。只接受项目内的相对路径：绝对路径、盘符、`..` 一律拒绝。
 */
export function normalizeProjectPath(raw: string): string | null {
  const text = raw.trim().replace(/\\/g, "/");
  if (text === "") return null;
  if (text.startsWith("/") || /^[a-zA-Z]:/.test(text)) return null;
  const parts: string[] = [];
  for (const part of text.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") return null;
    parts.push(part);
  }
  return parts.length === 0 ? null : parts.join("/");
}

/**
 * 声明的写集是否覆盖一个实际变更路径。
 * 支持精确路径与目录通配（`docs/**` 覆盖 `docs/a.md`，但不覆盖 `docs` 本身）。
 */
export function writeCovers(declared: string, changed: string): boolean {
  // `**` 是“整项目”（2026-11-23 无计划单兜底用），租约按字面量 `"**"` 建锁，两个 `**` 任务之间会串行。
  if (declared === "**") return true;
  if (declared === changed) return true;
  if (declared.endsWith("/**")) {
    const prefix = declared.slice(0, -3).replace(/\/+$/, "");
    return prefix !== "" && (changed === prefix || changed.startsWith(`${prefix}/`));
  }
  return false;
}

export function coveredByAny(declared: string[], changed: string): boolean {
  return declared.some((pattern) => writeCovers(pattern, changed));
}

/** 租约按（项目, 相对路径）独占；比较时用归一后的路径。 */
export function leaseKey(projectId: string, relPath: string): string {
  return `${projectId}:${relPath}`;
}
