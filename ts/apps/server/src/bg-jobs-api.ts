import type { Hono } from "hono";
import {
	BG_INDEX_LIMIT,
	bashBackgroundEnabled,
	bashJobsDir,
	killBgJob,
	listBgJobs,
	pruneBgIndex,
	readBgJobLog,
} from "./bash-background.ts";

/**
 * bash 后台任务的管理面（2026-11-10 批 21 §二）。
 *
 * 批 11 只做了"超时转后台 + 结果回灌"：任务转过去以后，人只能去 `.data/bg-jobs`
 * 里翻文件。这里补三个端点（列表 / 日志尾部 / kill），**纯增量**。
 *
 * 口径：
 *   - 开关沿用 `AGENT_BASH_BG_TIMEOUT`：关着时整组路由不挂（404 = 未启用）；
 *   - 日志正文只在响应体里出现，服务端日志只记条数（与 bash 输出同待遇）；
 *   - kill 只认本进程起的、仍在跑的任务（`killBgJob` 的归属判断）。
 */
export interface BgJobsApiOptions {
	/** 开关读取（测试用；缺省读 env） */
	enabled?: () => boolean;
	/** 落点目录（测试用；缺省 `AGENT_BG_JOBS_DIR` / `.data/bg-jobs`） */
	dir?: () => string;
}

export function mountBgJobs(app: Hono, options: BgJobsApiOptions = {}): void {
	const enabled = options.enabled ?? (() => bashBackgroundEnabled());
	if (!enabled()) return;
	const dir = options.dir ?? (() => bashJobsDir());

	// 启动裁剪（§2.3）：只删索引条目，不删日志文件。失败不挡服务启动。
	try {
		const dropped = pruneBgIndex(dir());
		if (dropped > 0) console.log(`[bg-job] 启动裁剪索引 ${dropped} 条（日志保留）`);
	} catch (error) {
		console.warn(
			`[bg-job] 启动裁剪失败: ${error instanceof Error ? error.message.slice(0, 120) : "unknown"}`,
		);
	}

	app.get("/api/v1/agent/bg-jobs", (c) => {
		try {
			return c.json({ ok: true, jobs: listBgJobs(dir()), limit: BG_INDEX_LIMIT });
		} catch (error) {
			console.warn(
				`[bg-job] 列表读取失败: ${error instanceof Error ? error.message.slice(0, 120) : "unknown"}`,
			);
			return c.json({ ok: false, error: "index_unavailable" }, 503);
		}
	});

	app.get("/api/v1/agent/bg-jobs/:id/log", (c) => {
		const id = c.req.param("id").trim();
		const tail = readBgJobLog(id, dir());
		if (!tail.found) return c.json({ ok: false, error: "unknown_job" }, 404);
		return c.json({ ok: true, id, lines: tail.totalLines, log: tail.log });
	});

	app.post("/api/v1/agent/bg-jobs/:id/kill", (c) => {
		const id = c.req.param("id").trim();
		const result = killBgJob(id, dir());
		if (result === "killed") return c.json({ ok: true, id, status: "killed" });
		if (result === "unknown") return c.json({ ok: false, error: "unknown_job" }, 404);
		return c.json(
			{
				ok: false,
				error: result === "not_owned" ? "not_owned_process" : "not_running",
				message:
					result === "not_owned"
						? "这个任务不是本进程起的（可能来自上一次服务运行），不能杀"
						: "任务已经结束，不用杀",
			},
			409,
		);
	});
}
