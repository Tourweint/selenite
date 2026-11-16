/**
 * 别家记忆文件的 frontmatter 解析（2026-11-16 从 memory-import-sources 抽出）：
 * 导入与拆分都要用同一份口径，别再各写一份。
 */

/** 剥 YAML frontmatter，返回（meta 键值对, 正文）。只在首行是 `---` 时剥；
 *  没有或残缺就整个当正文——别家的格式残缺不是咱们的错，能拿多少拿多少。
 *
 *  嵌套键记成 `metadata.type` 这样的点路径（ZCode 记忆的 type 藏在 metadata 下）；
 *  YAML 列表项（`- "x"` 行）和折叠续行不匹配键形态，天然忽略。 */
export function stripFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
	const lines = raw.split(/\r?\n/);
	if ((lines[0] ?? "").trim() !== "---") {
		return { meta: {}, body: raw };
	}
	const meta: Record<string, string> = {};
	let end = -1;
	let prefix = "";
	for (let i = 1; i < lines.length; i += 1) {
		const line = lines[i];
		if (line.trim() === "---") {
			end = i;
			break;
		}
		const m = /^(\s*)([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
		if (!m) continue;
		const [, indent, key, value] = m;
		if (indent) {
			if (prefix && value) meta[`${prefix}.${key.toLowerCase()}`] = value.trim().replace(/^["']|["']$/g, "");
		} else {
			prefix = key.toLowerCase();
			if (value) meta[prefix] = value.trim().replace(/^["']|["']$/g, "");
		}
	}
	if (end < 0) return { meta: {}, body: raw };
	return { meta, body: lines.slice(end + 1).join("\n") };
}
