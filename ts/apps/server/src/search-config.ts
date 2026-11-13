/**
 * 搜索源配置（2026-11-12 多供应商）。
 *
 * 落点：`.data/search.json`，只存「用哪些源、按什么顺序、各自的地址覆盖」；
 * key **不在这里**——与供应商密钥同一份 `.data/provider-keys.json`，按
 * `SearchVendor.keyEnv` 取 env。这样 .env 手写与界面直填两条路仍然共存。
 *
 * 兼容旧形态：
 *   - 没有 search.json 时，从 env 里的 key 反推源（DEEPSEEK_SEARCH_API_KEY 继续有效）；
 *   - 有 search.json 时以文件为准（即使某个 key 还在 env 里，也不偷偷加回来）。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	SEARCH_VENDORS,
	searchVendorOf,
	type SearchVendor,
} from "./search-vendors.ts";

export interface SearchSource {
	vendor: string;
	/** 覆盖供应商默认地址；空 / 缺省 = 用 vendor.baseUrl */
	baseUrl?: string;
}

export interface SearchSourceState extends SearchSource {
	vendorInfo: SearchVendor;
	keyEnv: string;
	hasKey: boolean;
	baseUrl: string;
	/** 真能问：有地址（需要时）+ 有 key（需要时） */
	usable: boolean;
}

interface SearchConfigDocument {
	schemaVersion: 1;
	sources: SearchSource[];
}

const MAX_SOURCES = 20;

export function searchConfigPath(): string {
	return process.env.SEARCH_CONFIG_PATH?.trim() || ".data/search.json";
}

/** 多源回滚开关：`false`/`0`/`off` = 只认 DeepSeek 一条旧路（search.json 里的其他源不读不写）。 */
export function multiVendorSearchEnabled(): boolean {
	const value = process.env.SEARCH_MULTI_VENDOR?.trim().toLowerCase();
	return !(value === "false" || value === "0" || value === "off");
}

function validBaseUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			(url.protocol === "http:" || url.protocol === "https:") &&
			!url.username &&
			!url.password
		);
	} catch {
		return false;
	}
}

function normalizeSource(raw: unknown): SearchSource | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const row = raw as Record<string, unknown>;
	const vendor = typeof row.vendor === "string" ? row.vendor.trim() : "";
	if (!searchVendorOf(vendor)) return null;
	const baseUrl = typeof row.baseUrl === "string" ? row.baseUrl.trim() : "";
	if (baseUrl && !validBaseUrl(baseUrl)) return null;
	return { vendor, ...(baseUrl ? { baseUrl } : {}) };
}

function parseDocument(text: string): SearchConfigDocument {
	const raw = JSON.parse(text) as unknown;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("搜索源配置不是对象");
	}
	const row = raw as Record<string, unknown>;
	if (row.schemaVersion !== 1 || !Array.isArray(row.sources)) {
		throw new Error("搜索源配置缺少 schemaVersion / sources");
	}
	const sources: SearchSource[] = [];
	const seen = new Set<string>();
	for (const item of row.sources) {
		const source = normalizeSource(item);
		if (!source || seen.has(source.vendor)) continue;
		seen.add(source.vendor);
		sources.push(source);
		if (sources.length >= MAX_SOURCES) break;
	}
	return { schemaVersion: 1, sources };
}

/** strict=true 给写路径：文件坏了就抛，绝不拿空表覆盖。 */
function readDocument(strict: boolean): { exists: boolean; sources: SearchSource[] } {
	const path = searchConfigPath();
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { exists: false, sources: [] };
		if (strict) throw new Error("搜索源配置不可读");
		console.warn("[search] 搜索源配置不可读，已按未配置处理");
		return { exists: true, sources: [] };
	}
	try {
		const document = parseDocument(text);
		return { exists: true, sources: document.sources };
	} catch {
		if (strict) throw new Error("搜索源配置内容不合法");
		console.warn("[search] 搜索源配置内容不合法，已按未配置处理");
		return { exists: true, sources: [] };
	}
}

function writeDocument(sources: SearchSource[]): void {
	const path = searchConfigPath();
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.tmp-${process.pid}`;
	const document: SearchConfigDocument = { schemaVersion: 1, sources };
	writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
	renameSync(temp, path);
}

/** env 里手写的 key 反推源（仅在没有 search.json 时用；顺序 = 目录顺序）。 */
function sourcesFromEnv(): SearchSource[] {
	const sources: SearchSource[] = [];
	for (const vendor of SEARCH_VENDORS) {
		if (vendor.id === "searxng") {
			const url = process.env.SEARXNG_URL?.trim() ?? "";
			if (url && validBaseUrl(url)) sources.push({ vendor: vendor.id, baseUrl: url });
			continue;
		}
		if (process.env[vendor.keyEnv]?.trim()) sources.push({ vendor: vendor.id });
	}
	return sources;
}

/** 生效的源清单：文件优先；没有文件才看 env。回滚开关关时只留 deepseek 一条。 */
export function effectiveSearchSources(): SearchSource[] {
	const file = readDocument(false);
	const sources = file.exists ? file.sources : sourcesFromEnv();
	if (!multiVendorSearchEnabled()) return sources.filter((source) => source.vendor === "deepseek").slice(0, 1);
	return sources;
}

function keyOf(vendor: SearchVendor): string {
	return process.env[vendor.keyEnv]?.trim() ?? "";
}

/** 地址覆盖优先级：源里写的 > 旧 DeepSeek 探针变量 / SearXNG env > 供应商默认。 */
export function baseUrlOf(source: SearchSource, vendor: SearchVendor): string {
	const own = source.baseUrl?.trim() ?? "";
	if (own) return own.replace(/\/+$/, "");
	if (vendor.id === "deepseek") {
		const legacy = process.env.SEARCH_BASE_URL?.trim();
		if (legacy) return legacy.replace(/\/+$/, "");
	}
	if (vendor.id === "searxng") {
		const legacy = process.env.SEARXNG_URL?.trim();
		if (legacy) return legacy.replace(/\/+$/, "");
	}
	return vendor.baseUrl.replace(/\/+$/, "");
}

export function sourceState(source: SearchSource): SearchSourceState | null {
	const vendorInfo = searchVendorOf(source.vendor);
	if (!vendorInfo) return null;
	const keyEnv = vendorInfo.keyEnv;
	const hasKey = Boolean(keyOf(vendorInfo));
	const baseUrl = baseUrlOf(source, vendorInfo);
	const usable = Boolean(baseUrl) && (hasKey || vendorInfo.keyOptional === true);
	return { ...source, vendorInfo, keyEnv, hasKey, baseUrl, usable };
}

/** 设置页要的全部源（含不可用的，行上要提示缺 Key / 缺地址）。 */
export function searchSourceStates(): SearchSourceState[] {
	return effectiveSearchSources()
		.map(sourceState)
		.filter((state): state is SearchSourceState => Boolean(state));
}

/** 真能问的源，按配置顺序。 */
export function usableSearchSources(): SearchSourceState[] {
	return searchSourceStates().filter((state) => state.usable);
}

export type SearchConfigResult =
	| { ok: true; source: SearchSource }
	| { ok: false; status: 400 | 500; error: string; message: string };

/**
 * 新增 / 更新一个源。
 * `baseUrl` 三态：`undefined` = 不动已有；`""` = 清掉覆盖；非空 = 换成它。
 */
export function upsertSearchSource(
	vendorId: string,
	baseUrl: string | undefined,
): SearchConfigResult {
	const vendor = searchVendorOf(vendorId);
	if (!vendor) {
		return { ok: false, status: 400, error: "unknown_vendor", message: "没有这个搜索源" };
	}
	if (!multiVendorSearchEnabled() && vendorId !== "deepseek") {
		return { ok: false, status: 400, error: "multi_vendor_disabled", message: "SEARCH_MULTI_VENDOR=false：只启用 DeepSeek 搜索" };
	}
	if (baseUrl !== undefined && baseUrl !== "" && !validBaseUrl(baseUrl)) {
		return { ok: false, status: 400, error: "bad_base_url", message: "地址要写完整的 http:// 或 https://" };
	}
	let file: { exists: boolean; sources: SearchSource[] };
	try {
		file = readDocument(true);
	} catch {
		return { ok: false, status: 500, error: "search_config_unreadable", message: "搜索源配置读取失败" };
	}
	const sources = file.exists ? [...file.sources] : sourcesFromEnv();
	const index = sources.findIndex((source) => source.vendor === vendorId);
	const previous = index >= 0 ? sources[index] : undefined;
	const next: SearchSource = { vendor: vendorId };
	// 先保留旧地址，再按三态覆盖
	const previousUrl = previous?.baseUrl?.trim() ?? "";
	const nextUrl = baseUrl === undefined ? previousUrl : baseUrl.trim();
	if (nextUrl) next.baseUrl = nextUrl;
	if (vendor.needsUrl && !nextUrl) {
		return { ok: false, status: 400, error: "missing_url", message: "这个搜索源需要地址" };
	}
	if (index >= 0) sources[index] = next;
	else sources.push(next);
	try {
		writeDocument(sources);
	} catch {
		return { ok: false, status: 500, error: "search_config_write_failed", message: "搜索源配置保存失败" };
	}
	return { ok: true, source: next };
}

export type SearchConfigRemoveResult =
	| { ok: true; removed: boolean }
	| { ok: false; status: 500; error: string; message: string };

export function removeSearchSource(vendorId: string): SearchConfigRemoveResult {
	let file: { exists: boolean; sources: SearchSource[] };
	try {
		file = readDocument(true);
	} catch {
		return { ok: false, status: 500, error: "search_config_unreadable", message: "搜索源配置读取失败" };
	}
	// 没有文件时源是从 env 反推的：删除也要落盘，否则下次启动又冒出来。
	const current = file.exists ? file.sources : sourcesFromEnv();
	const next = current.filter((source) => source.vendor !== vendorId);
	try {
		writeDocument(next);
	} catch {
		return { ok: false, status: 500, error: "search_config_write_failed", message: "搜索源配置保存失败" };
	}
	return { ok: true, removed: next.length !== current.length };
}

export type SearchConfigOrderResult =
	| { ok: true }
	| { ok: false; status: 400 | 500; error: string; message: string };

/** 重排：只认现有源；没列到的按原顺序接在后面。 */
export function reorderSearchSources(vendorIds: string[]): SearchConfigOrderResult {
	if (!Array.isArray(vendorIds) || vendorIds.some((id) => typeof id !== "string")) {
		return { ok: false, status: 400, error: "bad_request", message: "vendors 需要是字符串数组" };
	}
	// 回滚形态只有一条源，重排是空操作（不写文件，免得把别的源洗掉）。
	if (!multiVendorSearchEnabled()) return { ok: true };
	let file: { exists: boolean; sources: SearchSource[] };
	try {
		file = readDocument(true);
	} catch {
		return { ok: false, status: 500, error: "search_config_unreadable", message: "搜索源配置读取失败" };
	}
	// 没有文件时先按 env 反推一份再重排，保证第一次拖动就落盘。
	const base = file.exists ? file.sources : sourcesFromEnv();
	const byVendor = new Map(base.map((source) => [source.vendor, source]));
	const next: SearchSource[] = [];
	for (const id of vendorIds) {
		const source = byVendor.get(id);
		if (!source) continue;
		next.push(source);
		byVendor.delete(id);
	}
	for (const source of base) if (byVendor.has(source.vendor)) next.push(source);
	try {
		writeDocument(next);
	} catch {
		return { ok: false, status: 500, error: "search_config_write_failed", message: "搜索源配置保存失败" };
	}
	return { ok: true };
}
