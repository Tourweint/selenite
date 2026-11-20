/**
 * 产物读取工具（2026-11-19 从 review.ts 拆出）。
 *
 * 验收层删除后，这些函数只剩一个用途：把**上游任务**的 artifacts 内容
 * （≤2KB）作为依赖材料注入下游任务（`buildDependencies`）。它们不判成败。
 */

import fs from "node:fs";
import path from "node:path";
import { isInside } from "./store.ts";

export type MechanicalResult = { ok: true } | { ok: false; reason: string };

const CONTENT_LIMIT = 2048;
const PROCESS_FILES = new Set(["report.md", "task.md"]);

/** artifacts 里混进的 REPORT.md / TASK.md 是过程文件，静默剔除。 */
export function filterArtifacts(artifacts: string[]): string[] {
  return artifacts.filter((artifact) => {
    const base = artifact.split(/[\\/]/).pop()?.toLowerCase() ?? "";
    return !PROCESS_FILES.has(base);
  });
}

export interface ArtifactExcerpt {
  path: string;
  size: number;
  kind: "text" | "truncated" | "binary" | "unreadable";
  content?: string;
}

/** 读 artifacts 的内容：≤2KB 全文，>2KB 前 2KB，二进制只留路径。 */
export function collectArtifactContents(
  dir: string,
  artifacts: string[],
): ArtifactExcerpt[] {
  return artifacts.map((artifact) => {
    let buf: Buffer;
    try {
      buf = fs.readFileSync(path.resolve(dir, artifact));
    } catch {
      return { path: artifact, size: 0, kind: "unreadable" as const };
    }
    const size = buf.length;
    const text = buf.toString("utf8");
    if (buf.includes(0) || text.includes("\uFFFD")) {
      return { path: artifact, size, kind: "binary" as const };
    }
    if (size > CONTENT_LIMIT) {
      let head = buf.subarray(0, CONTENT_LIMIT).toString("utf8");
      if (head.endsWith("\uFFFD")) head = head.slice(0, -1);
      return { path: artifact, size, kind: "truncated" as const, content: head };
    }
    return { path: artifact, size, kind: "text" as const, content: text };
  });
}

/** 把产物摘录排成 markdown；heading 默认三级，依赖注入时用四级。 */
export function formatArtifactContents(
  items: ArtifactExcerpt[],
  heading = "###",
): string {
  if (items.length === 0) return "（artifacts 为空，没有随附产物内容）";
  return items
    .map((item) => {
      if (item.kind === "binary") {
        return `${heading} ${item.path}（${item.size} 字节，未附内容：二进制或无法按 UTF-8 解码）`;
      }
      if (item.kind === "unreadable") {
        return `${heading} ${item.path}（读取失败，未附内容）`;
      }
      if (item.kind === "truncated") {
        return `${heading} ${item.path}（${item.size} 字节，只附前 2 KB）\n<artifact>\n${
          item.content ?? ""
        }\n</artifact>\n（已截断，共 ${item.size} 字节）`;
      }
      return `${heading} ${item.path}（${item.size} 字节）\n<artifact>\n${item.content ?? ""}\n</artifact>`;
    })
    .join("\n\n");
}

/** 注入下游前核对 artifact 路径安全；路径对不上就不注入内容。 */
export function checkArtifacts(dir: string, artifacts: string[]): MechanicalResult {
  let dirReal: string;
  try {
    dirReal = fs.realpathSync(dir);
  } catch {
    return { ok: false, reason: "task 目录不存在" };
  }

  for (const artifact of artifacts) {
    const problem = artifactProblem(dir, dirReal, artifact);
    if (problem) return { ok: false, reason: problem };
  }
  return { ok: true };
}

function artifactProblem(dir: string, dirReal: string, artifact: string): string | null {
  const rel = artifact.trim();
  if (!rel) return "清单里有空路径";
  if (path.isAbsolute(rel)) return `用了绝对路径，越界：${rel}`;
  const target = path.resolve(dir, rel);
  if (!isInside(dir, target)) return `路径越界：${rel}`;
  if (!fs.existsSync(target)) return `产物不存在：${rel}`;
  let real: string;
  try {
    real = fs.realpathSync(target);
  } catch {
    return `路径无法解析：${rel}`;
  }
  if (real !== dirReal && !isInside(dirReal, real)) return `真实路径越界：${rel}`;
  return null;
}
