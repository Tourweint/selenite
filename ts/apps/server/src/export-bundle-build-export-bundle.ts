/**
 * export-bundle-build-export-bundle
 *
 * 2026-11-14 从 export-bundle.ts 的 L867–L899 整段切出；正文原文搬运，未改一行实现。
 * 内含：buildExportBundle
 */

import { COLLECTORS, ExportTooLargeError } from "./export-bundle-collect-conversations.ts";
import { EXPORT_MAX_BYTES, EXPORT_PART_LABELS, composeBundle, formatBytes, shortError } from "./export-bundle-compose-bundle.ts";
import type { BundleBuildResult, BundlePart, ExportPartId } from "./export-bundle-compose-bundle.ts";

export async function buildExportBundle(options: {
	parts: readonly ExportPartId[];
	images: boolean;
	now?: Date;
}): Promise<BundleBuildResult> {
	const at = options.now ?? new Date();
	const parts: BundlePart[] = [];

	for (const id of options.parts) {
		try {
			parts.push(await COLLECTORS[id](options.images));
		} catch (error) {
			parts.push({
				id,
				label: EXPORT_PART_LABELS[id],
				status: "failed",
				files: [],
				counts: {},
				notes: [],
				error: shortError(error),
			});
		}
	}

	const result = composeBundle(parts, at);
	if (result.bytes > EXPORT_MAX_BYTES) {
		throw new ExportTooLargeError(
			`导出内容约 ${formatBytes(result.bytes)}，超过上限 ${formatBytes(EXPORT_MAX_BYTES)}；` +
				"可以关掉图片再试（parts 里去掉会话也行）",
		);
	}
	return result;
}
