import { Type } from "@earendil-works/pi-ai";
import { join } from "node:path";
import {
	CHIEF_PARTNER_ID,
	COMPANIONS_ENABLED,
	effectivePartnerIdOfSession,
	/** 派发权闸（2026-11-06）：开关关 → 不注入执事身份，派单等同旧领域。 */
	ministerDispatchAllowed,
	partnerIdentityForDomain,
	partnersStore,
} from "./partners.ts";
// 执事的建/停/列核心（批次D D3）：与 companion-api 端点共用，工具只做校验与文案包装。
import {
	createMinisterPartner,
	defaultMinisterContext,
	listMinisterPartners,
	setMinisterDispatchAuthority,
	stopMinisterPartner,
	type MinisterContext,
} from "./partner-manage.ts";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { scopeKey, type MemoryEngine, type MemoryKind, type MemoryScope } from "@lifediary/memory";
// 派活能力（chancellor）。相对路径是刻意的：chancellor 是独立仓库，
// 跑的是 .ts 源码，装进 node_modules 后 node 不会给里面的 .ts 剥类型
// （ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING），所以不能走 file: 依赖。
// 只有这一处引用它，挪仓库时改这一行。
import { runChancellor } from "../../../../../chancellor/src/index.ts";
import {
	DOMAIN_PATTERN,
	listManagers,
	validateDomain,
} from "../../../../../chancellor/src/manager/registry.ts";
import {
	chancellorWorkRoot,
	emitDelegation,
	startDelegation,
	type DelegationReport,
} from "./delegation.ts";
import {
	autoRequestId,
	DelegationReceipts,
	requestFingerprint,
} from "./delegation-receipts.ts";
import {
	ProjectError,
	resolveDelegationProject,
	type ProjectRef,
	type ProjectsStore,
} from "./projects.ts";
// 派活路由（2026-11-07 消息即引导与执事直派）：执事在自己领域内不再绕回分管宰相。
import {
	resolveDelegateRouting,
	routingToRequestFields,
} from "./delegate-routing.ts";
// 设备矩阵（2026-11-05 阶段二）：远程分支晚绑定取中继客户端。
// relay-matrix → agent → tools 的环是运行期安全的（agent 绑定只在函数体内解引用）。
import {
	currentRelayClient,
	deviceAutoDispatchEnabled,
	deviceMatrixEnabled,
} from "./relay-config.ts";
import { RelayInvokeError } from "./relay-client.ts";
import { dispatchRemoteDelegation } from "./relay-matrix.ts";
import { ReminderTask } from "./reminder.ts";
import type { SkillStore } from "./skills.ts";

/**
 * 我们自己的工具。
 *
 * 读/写/改/跑命令这四个不再自己写 —— durable 的 `CodingTools` 已经有一版
 * 更完整的（走执行环境、输出分页、图片处理、edit 的差异化写入），
 * 而且它的路径语义跟沙箱/远程环境是一致的。自己重写只会更差。
 *
 * 所以这里是：**记住**、**回忆**、**提醒**（个人 Agent 区别于编码 Agent 的部分）
 * 加一个 **skill**（2026-10-31 方案 D5：技能正文按需取，不进 system）。
 */

const MEMORY_KINDS: MemoryKind[] = ["fact", "episode", "preference", "entity"];

/**
 * 调用方会话所属执事的领域（2026-11-07 执事直派）。
 *
 * 只认链接表里真实的执事档案：总管（`chief`）与主人会话没有领域，
 * 返回 null —— 路由据此走"原样分管"。查库失败也返回 null（宁可按旧行为），
 * 不让一次读失败把派单挡下来。
 */
function callerDomainOf(conversationId: number): string | null {
	if (!COMPANIONS_ENABLED) return null;
	try {
		const partnerId = partnersStore().partnerIdOfSession(conversationId);
		if (!partnerId) return null;
		return partnersStore().get(partnerId)?.domain ?? null;
	} catch {
		return null;
	}
}

/**
 * 本机 delegate 才反查执事身份（批次D D2）。
 * 执事能力关闭 / 执事库不可用时返回 null —— 请求不带身份，兼容旧领域，不让派单因查库失败而挂掉。
 * 远程锚点会话（relay-matrix）不装配这个缝，因此「不做跨电脑执事」在装配层就成立。
 */
function localIdentityHit(domain: string): { name: string; soul: string } | null {
	if (!COMPANIONS_ENABLED) return null;
	try {
		// 派发权闸（2026-11-06）：开关关（或 env 总闸关）时不命中，请求不带 managerIdentity，
		// chancellor 以默认路径（总管直派）办单——等同旧领域，不拒单。
		if (!ministerDispatchAllowed(partnersStore(), domain)) return null;
		return partnerIdentityForDomain(partnersStore(), domain);
	} catch {
		return null;
	}
}

export interface ToolDeps {
	/** 记忆引擎；为 null 时 remember / recall 会明确报错而不是静默失败 */
	memory: MemoryEngine | null;
	/** 内部会话 id → 记忆作用域 */
	scopeOf: (conversationId: number) => MemoryScope;
	/** 技能库；为 null 时 skill 工具不上（技能目录不存在/为空，索引也不会渲染） */
	skills?: SkillStore | null;
	/**
	 * 派活能力；为 false 时 delegate 工具不上。
	 *
	 * 2026-11-02：默认开。装上 chancellor 之后主 agent 才有"把活派出去"的手。
	 * 关掉它（`CHANCELLOR_ENABLED=false`）时工具清单回到 8 个，行为与改动前完全一致。
	 */
	delegate?: boolean;
	/** 测试用：替换真正跑 chancellor 的入口；生产不传，直接用 runChancellor。 */
	delegateRun?: typeof runChancellor;
	/**
	 * 任务单跑完后回灌会话（2026-11-03）。
	 *
	 * 工具不直接碰会话对象：由 `agent.ts` 传入，内部走 `sayInChat`。
	 * 会话忙时 durable 会把这条写入排到本轮结束，不打断当前对话。
	 */
	reportDelegation?: (conversationId: number, report: DelegationReport) => void;
	/**
	 * 项目/工作区登记表（2026-11-03 方案 §5.5）。
	 * 派新活必须先过这里：没有已登记且仍在工作区内的项目一律返回 `needs_project`，
	 * 不建目录、不写文件、不建任务单。
	 */
	projects?: ProjectsStore | null;
	/**
	 * 执事能力（2026-11-05 批次B B2）：为 true 时 `partner_skill_write` 上架。
	 * agent.ts 传 `COMPANIONS_ENABLED`——开关关掉时工具不注册，行为与改动前一致（回滚开关）。
	 */
	partners?: boolean;
	/**
	 * 执事管理工具的存储 / chancellor 工作根（批次D D3）。测试注入临时目录，
	 * 不碰真实 .data/；不传用全局 partnersStore() + chancellorWorkRoot()。
	 */
	ministerContext?: () => MinisterContext;
	/** 派单回执表；不传用默认 `.data/delegations.sqlite`。测试可注入临时库。 */
	receipts?: DelegationReceipts | null;
}

let sharedReceipts: DelegationReceipts | null = null;

function receiptsOf(deps: ToolDeps): DelegationReceipts {
	if (deps.receipts) return deps.receipts;
	if (!sharedReceipts) sharedReceipts = new DelegationReceipts();
	return sharedReceipts;
}

/** 读布尔 env；只有明确写 false/0 才关，避免拼错一个值把功能误关掉。 */
function envFlag(name: string, fallback: boolean): boolean {
	const raw = process.env[name]?.trim().toLowerCase();
	if (!raw) return fallback;
	return raw !== "false" && raw !== "0";
}

function text(value: string) {
	return { output: [{ type: "text" as const, text: value }] };
}

export function createTools(deps: ToolDeps) {
	const { memory, scopeOf } = deps;

	const requireMemory = (): MemoryEngine => {
		if (!memory) throw new Error("记忆库未启用（MEMORY_ENABLED=false 或初始化失败）");
		return memory;
	};

	const remember = defineTool({
		name: "remember",
		description:
			"把一件事写进长期记忆，以后每次对话都可能被想起来。" +
			"适合：对方的偏好、家人朋友宠物、长期目标、重要经历。" +
			"不适合：一次性的琐事、马上就会变的信息。",
		parameters: Type.Object({
			content: Type.String({ description: "要记住的内容，一句话，用第三人称或原话" }),
			kind: Type.Optional(
				Type.Unsafe<MemoryKind>({
					type: "string",
					enum: MEMORY_KINDS,
					description: "fact=事实 / episode=经历过的事 / preference=偏好 / entity=人事物",
				}),
			),
			importance: Type.Optional(
				Type.Number({ description: "重要程度 0..1，默认 0.7", minimum: 0, maximum: 1 }),
			),
		}),
		execute: async (args, api) => {
			const engine = requireMemory();
			// 群会话不进个人记忆（2026-11-06 群组方案 §2.2）：群里听到的事写进执事私人记忆
			// 就是串台。模型侧明说原因，别让它对着一个会失败的接口反复重试。
			if (partnersStore().isGroupSession(api.conversationId)) {
				return text("群聊里的内容不进个人记忆；需要记住的事请主人在私聊里说。");
			}
			const record = engine.remember({
				kind: args.kind ?? "fact",
				scope: scopeOf(api.conversationId),
				content: args.content,
				importance: args.importance,
				// 人自己说的（或当面转述的），可信度最高
				veracity: "stated",
				source: "user",
			});
			return text(`已记住：${record.content}`);
		},
	});

	const recall = defineTool({
		name: "recall",
		description:
			"在长期记忆里检索。和对方有关的事想不起来了，先用它查，不要猜。" +
			"当前对话的上下文里通常已经带了相关记忆，只有在不够用时才调用。",
		parameters: Type.Object({
			query: Type.String({ description: "要查什么，用关键词或一句话" }),
			limit: Type.Optional(Type.Number({ description: "最多返回几条，默认 5" })),
		}),
		execute: async (args, api) => {
			const engine = requireMemory();
			// 群会话不参与记忆引擎（群组方案 §2.2，v1 最简形态）：群聊查记忆也跳过
			if (partnersStore().isGroupSession(api.conversationId)) {
				return text("群聊不走个人记忆；答案以群里的聊天记录为准。");
			}
			const hits = engine.recall({
				text: args.query,
				scopes: ["global", scopeKey(scopeOf(api.conversationId))],
				limit: Math.max(1, Math.min(20, Math.floor(args.limit ?? 5))),
			});
			if (hits.length === 0) return text("没有找到相关记忆。");
			return text(
				hits
					.map((hit) => `- [${hit.record.kind}] ${hit.record.content}（${hit.record.createdAt.slice(0, 10)}）`)
					.join("\n"),
			);
		},
	});

	const remind = defineTool({
		name: "set_reminder",
		description:
			"定一个到点提醒。时间写 ISO 8601（带时区），例如 2026-10-29T08:00:00+08:00。" +
			"提醒会落库，进程重启也不会丢。",
		parameters: Type.Object({
			text: Type.String({ description: "到点要提醒的内容" }),
			at: Type.String({ description: "触发时间，ISO 8601" }),
		}),
		execute: async (args, api, context) => {
			const at = Date.parse(args.at);
			if (Number.isNaN(at)) throw new Error(`时间格式看不懂：${args.at}`);
			if (at <= api.now()) throw new Error(`这个时间已经过去了：${args.at}`);

			await api.commit(
				(tx) =>
					tx.createTask(
						ReminderTask,
						{ text: args.text, at },
						{ ownership: { kind: "conversation" } },
					),
				context,
			);
			return text(`好，${new Date(at).toLocaleString("zh-CN")} 提醒你：${args.text}`);
		},
	});

	// 按会话记最后一张单：resume 只可能发生在同一轮对话里。
	// 不落库——进程重启后会话已断，老单本来也接不上，落库只会多出迁移/过期/清理的常态成本。
	const lastTicketByConversation = new Map<number, string>();
	// 续跑被拒时可能改派新单：记住这轮用的项目，改派后仍然落在同一个项目里。
	const lastProjectByConversation = new Map<number, ProjectRef>();
	const run = deps.delegateRun ?? runChancellor;
	/** 回滚开关：`DELEGATION_PROJECT_REQUIRED=false` 回到 2026-11-02 的无项目行为。 */
	const projectRequired = envFlag("DELEGATION_PROJECT_REQUIRED", true);

	const proposeProject = defineTool({
		name: "propose_project",
		description:
			"在用户已选定工作区的前提下，提出新建一个项目根目录。" +
			"它只提交待用户确认的请求，**不会创建目录、也不会登记项目**；用户在项目设置里确认后才真正建目录。" +
			"只有用户明确要新建一个项目（新的根目录）时才调用；项目内部的子目录不需要、也不应该新建项目。",
		parameters: Type.Object({
			name: Type.String({ description: "项目名，给用户看的短名，例如 手机端 / 桌面壳 / 文档站" }),
			path: Type.String({
				description: "工作区内的相对路径，例如 projects/新的小工具；不要写绝对路径，不要包含 ..",
			}),
		}),
		execute: async (args) => {
			if (!deps.projects) {
				return text(
					JSON.stringify({ ok: false, error: "needs_project", message: "项目登记表不可用" }),
				);
			}
			try {
				const proposal = deps.projects.proposeProject(args.name, args.path);
				return text(
					JSON.stringify({
						ok: true,
						proposalId: proposal.id,
						name: proposal.name,
						path: proposal.relativePath,
						message:
							"已提交待确认：用户在项目设置里确认后才会创建目录并登记。" +
							"确认之前不要派工到它，也不要自己建这个目录。",
					}),
				);
			} catch (error) {
				const code = error instanceof ProjectError ? error.code : "failed";
				const message = error instanceof Error ? error.message : String(error);
				return text(JSON.stringify({ ok: false, error: code, message }));
			}
		},
	});

	// 派活（2026-11-02）：主 agent 的"手"。它自己不动手，把活交给外面的工人，
	// 只拿回一句话。工具的 description 里"不适合"那半句比"适合"更重要——
	// 写宽了，主 agent 会把一次 read 就能答的事也派出去，每次都起 worker，比不用还贵。
	const domainList = (): string => {
		try {
			const domains = listManagers(chancellorWorkRoot())
				.map((entry) => entry.domain)
				.filter((domain) => DOMAIN_PATTERN.test(domain));
			return domains.length > 0 ? domains.join(" / ") : "（暂无，可用小写英文新建）";
		} catch {
			return "（当前领域清单不可读）";
		}
	};
	const delegate = defineTool({
		name: "delegate",
		description:
			"把一件需要多步动手的活派给外面的工人（领域负责人/执行者）去做。" +
			"适合：要改多个文件、要跑命令、要查证之后再动手的任务；" +
			"**以及在手机上操作 App**——打开某个 App、点按钮、输入文字、翻页、看屏幕上显示了什么。" +
			"不适合：回答问题、闲聊、一次 read 就能答的事、需要边做边问对方的事。" +
			"**派出去后会立即返回任务单号，不会占住这一轮对话；后台跑完会有一条汇报写进会话。**" +
			"所以返回后直接告诉用户「已派发，完成后会汇报」即可，不要等结果、不要反复查询、不要重复派。" +
			"填 `domain` 把活交给对应领域的负责人。**领域名必须是小写 ASCII**（小写字母、数字、连字符，如 `frontend` / `desktop-shell`）；" +
			`当前已有领域：${domainList()}。不填则按旧路径直接派 worker。` +
			"**派新活时必须带 `project`（已登记的项目名或 id）**；没有可用项目时会返回 " +
			"`{\"error\":\"needs_project\"}` 并列出已有项目——先问用户要建哪个项目，" +
			"用 `propose_project` 提交、等用户在设置里确认，再派。" +
			"如果上一轮派出去的活卡住了、你问了用户一个问题、用户刚回答了你，用 `resume: true` 接着原单跑：" +
			"`requirement` 里只写用户的那句回答（比如「验证码 1234」），不要重述整个任务，" +
			"**更不要重新派**——重派会让对方从头再做一遍。" +
			"对方在回答你上一轮的问题时，他这句话本身就是要交回去的内容：直接拿它调 resume，" +
			"不要再反问一遍，也不要自己替它把剩下的事做完。" +
			"会话里没有可续的单时会按新活派，并在结果里告诉你。" +
			"**注意（只讲文件路径，不是能力限制）**：工人写文件时用相对路径（如 `summary.md`），" +
			"不要指定工作目录之外的绝对路径；产物最后落在 chancellor 的 runs/<ticket>/ 下，不在你指定的绝对位置。" +
			"工人在手机上干活时，它看到的是手机屏幕、点的是手机上的按钮——**它碰不到你电脑上的文件**；" +
			"反过来，它交回来的是一句话，不是手机里的截图或文件。",
		parameters: Type.Object({
			requirement: Type.String({
				description:
					"要做的事，一句话说清，并且带上「怎么算做完了」。" +
					"resume 时只写用户的那句回答，不要重述任务。" +
					"要写文件时给相对路径；要读的文件给绝对路径没问题。",
			}),
			project: Type.Optional(
				Type.String({
					description:
						"已登记的项目名或 id。派新活时必填；续跑（resume）时可以省略，沿用原单的项目。" +
						"不知道有哪些项目时，先不带，工具会返回 needs_project 和项目清单。",
				}),
			),
			domain: Type.Optional(
				Type.String({
					description:
						"领域负责人的领域名，**必须是小写 ASCII**（小写字母、数字、连字符，如 `frontend` / `desktop-shell`）。" +
						`当前已有领域：${domainList()}。` +
						"填了就把活交给该领域负责人；不填则直接派 worker（兼容旧行为）。",
				}),
			),
			targetDevice: Type.Optional(
				Type.String({
					description:
						"把活派给**另一台电脑**的 harness 执行（设备矩阵）。填中结名册里的设备 id。" +
						"`\"auto\"` = 电脑自己挑一台（DEVICE_AUTO_DISPATCH 开启时）：**优先主机**（用户在设置里指定的那台），" +
						"主机满载或离线才按忙碌度外流到别的机器；挑不出就在本机执行并说明原因；不填仍是本机执行。" +
						"设备描述（如「存储机」）与主机位可在 /relay/overview 看到，供点名参考，不参与自动挑选。" +
						"填了就跑远程分支：本机的项目登记表不参与，`project` 由目标机判；" +
						"目标离线会直接失败（不排队）。",
				}),
			),
			resume: Type.Optional(
				Type.Boolean({
					description:
						"接着上一张单跑（上次派出去的活卡住了、你问了用户、用户刚回答时用）。不填 = 新派一件。",
				}),
			),
			requestId: Type.Optional(
				Type.String({
					description:
						"幂等键。同一次派活在重试/重启后要用同一个 id，工具会返回原任务单号，" +
						"不会重复起一张单。不填时服务端按会话 + 需求自动生成。",
				}),
			),
		}),
		execute: async (args, api, context) => {
			// 派活的进度和「需要你」要能实时到客户端，否则那几分钟界面是死的。
			// 这里把 chancellor 的事件翻译成两种：正在办第几件、需要你回答什么。
			const conversationId = Number(api.conversationId);
			const requestedDomain = (args.domain ?? "").trim();
			// 派活路由（2026-11-07）：执事在自己领域内直派，不再绕回分管宰相；
			// 跨领域明确拒绝，不静默改道。总管 / 主人会话维持原语义。
			const routing = resolveDelegateRouting(
				{
					partnerId: effectivePartnerIdOfSession(partnersStore(), conversationId),
					domain: callerDomainOf(conversationId),
				},
				requestedDomain,
			);
			if (routing.kind === "rejected") return text(routing.reason);
			const requestFields = routingToRequestFields(routing);
			const domain = requestFields.domain;
			// 远程分支（2026-11-05 阶段二）：点名另一台电脑执行。
			// 本机的项目前置不参与（project 语义归目标机）；离线直接失败不排队。
			const targetDevice = (args.targetDevice ?? "").trim();
			// 自动挑机落回本机时，给最终的派活回话加一行前缀（方案 §2.4：挑不出必须可见）
			let fallbackNotice = "";
			if (targetDevice) {
				// "auto" 是第三态：开关关着就按非法参数拒绝，不让它悄悄降级成本机
				if (targetDevice === "auto" && !deviceAutoDispatchEnabled()) {
					return text(
						JSON.stringify({
							ok: false,
							error: "auto_disabled",
							message: "自动挑机未开启（DEVICE_AUTO_DISPATCH）",
						}),
					);
				}
				const client = currentRelayClient();
				if (!deviceMatrixEnabled() || !client) {
					return text("设备矩阵未开启（DEVICE_MATRIX_ENABLED=off 或中继未连接），targetDevice 不可用。");
				}
				if (args.resume === true) {
					return text("远端单的续跑（resume）暂不支持：请直接重派一张新单到该设备。");
				}
				try {
					const result = await dispatchRemoteDelegation(client, {
						targetDeviceId: targetDevice,
						requirement: args.requirement,
						project: args.project?.trim() || undefined,
						domain: domain || undefined,
						originInternalId: conversationId,
					});
					if ("fallbackToLocal" in result) {
						// 挑不出不是失败：本机照常走下面的本地派活路径，只把原因带到回话里。
						fallbackNotice = `自动挑机未成（${result.reason}），已在本机执行。\n`;
					} else {
						// 主机位与设备描述是"点名参考"：给模型/用户看活去了哪台、那台是干什么的
						// （描述只给人看，决策器不读——2026-11-05 主机优先制）。
						const tags = [
							result.pickedHome ? "主机" : "",
							result.deviceDescription ?? "",
						].filter(Boolean);
						return text(
							`已交由设备「${result.deviceName}」${tags.length > 0 ? `（${tags.join("，")}）` : ""}执行（远端请求 ${result.requestId.slice(0, 8)}）。` +
								"它在后台跑，完成后我会把汇报写进本会话。不要重复派、不要轮询。",
						);
					}
				} catch (error) {
					const code = error instanceof RelayInvokeError ? error.code : "internal";
					const message = error instanceof Error ? error.message.slice(0, 200) : "派发失败";
					return text(JSON.stringify({ ok: false, error: code, message }));
				}
			}
			// 非法领域名（尤其是中文）直接回可用清单，不建单、不让模型猜。
			if (domain) {
				try {
					validateDomain(domain, chancellorWorkRoot());
				} catch (error) {
					return text(error instanceof Error ? error.message : String(error));
				}
			}
			const asyncMode = envFlag("DELEGATION_ASYNC", true);
			const autoReport = asyncMode && envFlag("DELEGATION_AUTO_REPORT", true);
			const resumeTicketId =
				args.resume === true ? lastTicketByConversation.get(conversationId) : undefined;
			if (args.resume === true) {
				console.log(
					`[delegate resume] 会话 ${conversationId} 续跑 ${resumeTicketId ?? "(无)"}` +
						`，回答=${JSON.stringify(args.requirement.slice(0, 120))}`,
				);
			}

			// 项目前置（方案 §5.5）：派新活必须过登记表；续跑沿用原单 / 上一轮的项目。
			// 没有项目时**不建单、不建目录、不写文件**，只把清单交回给模型。
			let project: ProjectRef | undefined;
			if (projectRequired) {
				if (args.project?.trim()) {
					const gate = resolveDelegationProject(args.project, deps.projects ?? null);
					if (!gate.ok) return text(gate.text);
					project = gate.project;
				} else if (resumeTicketId === undefined) {
					const gate = resolveDelegationProject(undefined, deps.projects ?? null);
					if (!gate.ok) return text(gate.text);
					project = gate.project;
				} else {
					// 老会话重启后可能记不住项目；续跑本身不需要新项目。
					project = lastProjectByConversation.get(conversationId);
				}
			}

			// 幂等回执（方案 §5.1）：新派先落回执再入队；续跑沿用原单，不建新回执。
			const receipts = resumeTicketId === undefined ? receiptsOf(deps) : null;
			const explicitRequestId = (args.requestId ?? "").trim();
			const requestId = receipts
				? explicitRequestId || autoRequestId(conversationId, args.requirement)
				: "";
			const fingerprint = requestId
				? requestFingerprint({
						conversationId,
						requirement: args.requirement,
						domain,
						projectId: project?.id ?? "",
					})
				: "";
			if (receipts && requestId) {
				const begun = receipts.begin(requestId, fingerprint, {
					explicit: Boolean(explicitRequestId),
					workRoot: chancellorWorkRoot(),
				});
				if (begun.kind === "conflict") {
					// 同一 requestId 但内容不同：不报冲突、不让模型换号重派，直接把原单交回。
					const existing = begun.receipt?.ticketId ?? "";
					if (existing) lastTicketByConversation.set(conversationId, existing);
					return text(
						`该请求号已受理过，返回原单${existing ? ` ${existing}` : "（原单还在受理中）"}，没有重复派。` +
							"后台跑完会汇报。",
					);
				}
				if (begun.kind === "uncertain") {
					return text(
						JSON.stringify({
							ok: false,
							error: "uncertain",
							ticketId: begun.receipt?.ticketId ?? "",
							message:
								"这张单在受理时中断过，结果未知。先确认它是否已经在跑，不要盲目重派。",
						}),
					);
				}
				if (begun.kind === "existing") {
					const existing = begun.receipt?.ticketId ?? "";
					if (existing) lastTicketByConversation.set(conversationId, existing);
					return text(
						`这次派活已经受理过，沿用原任务单 ${existing || "(受理中)"}，没有重复派。` +
							"后台跑完会汇报。",
					);
				}
			}

			// 立即受理：同步拿到任务单号，后台跑完再发事件/回灌。
			const { ticketId, outcome, fellBack } = startDelegation(
				{
					conversationId,
					domain,
					requirement: args.requirement,
					resumeTicketId,
					project,
					...(requestId ? { requestId } : {}),
					// 执事在自己领域内直派（2026-11-07）：不带 managers 就是既有分管路径
					...(requestFields.managers === false ? { managers: false as const } : {}),
				},
				{
					run: (request, options) =>
						run(
							{ ...request, workRoot: chancellorWorkRoot() },
							{
								...options,
								// 后台执行不能挂本轮对话的 abortSignal：用户这一轮结束不该杀掉任务。
								...(asyncMode ? {} : { signal: context.abortSignal }),
							},
						),
					emit: emitDelegation,
					report: deps.reportDelegation,
					autoReport,
					// 只有本机 delegate 按 domain 反查执事身份；远程锚点会话不装配这个缝。
					identityHitFor: localIdentityHit,
					log: (line) => console.warn(line),
				},
			);
			if (ticketId) lastTicketByConversation.set(conversationId, ticketId);
			if (project) lastProjectByConversation.set(conversationId, project);
			if (receipts && requestId) {
				if (ticketId) receipts.accept(requestId, ticketId, conversationId);
				// 失败时回执要跟着落：拿到单号记 failed，没拿到记 uncertain（不自动重派）。
				void outcome
					.then((result) => {
						if (result.ticketId) receipts.accept(requestId, result.ticketId, conversationId);
					})
					.catch(() => receipts.markFailed(requestId));
			}

			// 想续跑但没有老单（空会话 / 重启后），也算走了"没单可续"。
			const noTicket = fellBack || (args.resume === true && resumeTicketId === undefined);

			// 回滚路径（DELEGATION_ASYNC=false）：保持 2026-11-02 的同步行为。
			if (!asyncMode) {
				try {
					const result = await outcome;
					lastTicketByConversation.set(conversationId, result.ticketId);
					const line = result.line || "派出去的活没有返回结论。";
					if (noTicket) return text(`${fallbackNotice}${line}\n（没有可续的单，已按新活派）`);
					if (resumeTicketId) {
						return text(`${fallbackNotice}${line}\n（已把用户的回答交回原单，它在接着做。）`);
					}
					return text(fallbackNotice + line);
				} catch {
					return text(`${fallbackNotice}派单失败，请稍后再试。`);
				}
			}

			if (noTicket) {
				return text(
					`${fallbackNotice}已按新活派：任务单 ${ticketId || "(受理中)"}` +
						`${domain ? `（领域：${domain}）` : ""}。它在后台执行，完成后我会汇报。`,
				);
			}
			if (resumeTicketId) {
				return text(
					`${fallbackNotice}已把回答交回原单 ${ticketId}，它继续在后台跑，完成后我会汇报。`,
				);
			}
			return text(
				`${fallbackNotice}已受理：任务单 ${ticketId || "(受理中)"}${domain ? `（领域：${domain}）` : ""}。` +
					"它在后台执行，完成后我会汇报；不要等，也不要重复派。",
			);
		},
	});

	const tools: ToolRegistration[] = [remember, recall, remind];

	if (deps.skills) {
		const skills = deps.skills;
		tools.push(
			defineTool({
				name: "skill",
				description:
					"取一份技能手册（完整流程）。会话的 skills 索引里列出了可用技能；" +
					"要按某个流程引导对方时，先调它拿到手册，再照着做。",
				parameters: Type.Object({
					name: Type.String({ description: "技能名，必须是索引里列出的名字" }),
				}),
				execute: async (args) => {
					const manual = skills.manual(args.name);
					if (!manual) {
						return text(
							`没有叫「${args.name}」的技能。可用：${skills.names().join("、") || "（无）"}`,
						);
					}
					return text(manual);
				},
			}),
		);
	}

	if (deps.delegate !== false) tools.push(delegate, proposeProject);

	// 执事技能写入（2026-11-05 批次B B2；批次D D1 扩到主对话=总管）。
	// 写的是 partner-homes/<id>/skills/<slug>.md（64KB 上限、原子写都在 partners.ts）。
	// 执事会话写该执事的技能；主对话（owner 会话）解析为 chief → 写总管技能库；
	// CHIEF_PARTNER=false 时 owner 会话照旧返回"不属于任何执事"（回滚到改动前）。
	//
	// 执事管理 partner_manage（批次D D3）与 partner_skill_write 一起挂在执事能力开时。
	// deps.partners 缺省回落 COMPANIONS_ENABLED：agent.ts 装配时不显式传 partners，
	// 主对话（总管）也能用；COMPANIONS_ENABLED=false 两件都不注册 = 一行回滚。
	const partnersOn = deps.partners ?? COMPANIONS_ENABLED;
	const ministerContext = deps.ministerContext ?? defaultMinisterContext;
	if (partnersOn) {
		tools.push(
			defineTool({
				name: "partner_skill_write",
				description:
					"把一份技能手册写进当前执事的技能库（skills/<slug>.md，首行 = 索引用的一句话摘要）。" +
					"执事会话写各自的技能库，主对话写总管技能库；写盘即生效，下一轮进身份提示词的技能索引。",
				parameters: Type.Object({
					slug: Type.String({
						description: "技能名，小写字母/数字/短横线，1-64 字符，如 daily-brief",
					}),
					content: Type.String({ description: "技能手册全文（Markdown）；第一行是索引用摘要" }),
				}),
				execute: async (args, context) => {
					// effectivePartnerIdOfSession：执事会话 → 真实 uuid；主对话 → "chief"（CHIEF 开时）。
					// 用 chief 感知的解析而非裸 partnerIdOfSession，是为了让主对话也能写总管技能；
					// 裸函数仍被 autonomy/routines 当"是否主人会话"用，语义不能改。
					const partnerId = effectivePartnerIdOfSession(
						partnersStore(),
						Number(context.conversationId),
					);
					if (!partnerId) {
						return text("这个会话不属于任何执事，不能写执事技能。");
					}
					if (!/^[a-z0-9][a-z0-9-_]{0,63}$/.test(args.slug)) {
						return text("slug 只能是小写字母/数字/短横线，1-64 字符。");
					}
					if (!args.content.trim() || !args.content.trim().split("\n")[0]?.trim()) {
						return text("技能手册第一行是索引摘要，不能为空。");
					}
					try {
						partnersStore().atomicWrite(
							join(partnersStore().skillsDirOf(partnerId), `${args.slug}.md`),
							args.content,
						);
						return text(`技能 ${args.slug} 已写入执事技能库，下一轮进索引。`);
					} catch (error) {
						const detail = error instanceof Error ? error.message : String(error);
						return text(`写入失败：${detail}`);
					}
				},
			}),
		);
	}

	// 执事管理（批次D D3）：总管建 / 停 / 列执事。核心逻辑在 partner-manage.ts，
	// 与 companion-api 端点共用；这里只做参数校验、权限闸与模型友好的文案包装。
	if (partnersOn) {
		tools.push(
			defineTool({
				name: "partner_manage",
				description:
					"总管管理执事（chancellor 分管宰相）：create 建一个、stop 停一个、list 列出全部、set_dispatch 切某个执事的派发权（是否作为分管负责人接单，默认关）。" +
					"只有总管 / 主对话能用；执事自己的执事会话不能管理执事。" +
					"create 的 domain 是之后派活用的领域名，必须是小写 ASCII（小写字母、数字、连字符，如 frontend / desktop-shell），" +
					"name 是展示名（中文随意）。建好后用 delegate(domain=<domain>) 把活派给它。",
				parameters: Type.Object({
					action: Type.Unsafe<"create" | "stop" | "list" | "set_dispatch">({
						type: "string",
						enum: ["create", "stop", "list", "set_dispatch"],
						description: "create=建执事 / stop=停执事 / list=列出执事 / set_dispatch=切派发权",
					}),
					name: Type.Optional(Type.String({ description: "create 必填，展示名，≤40 字" })),
					domain: Type.Optional(
						Type.String({ description: "create 必填，小写 ASCII 领域名（之后派活路由用）" }),
					),
					soul: Type.Optional(Type.String({ description: "create 可选，一句话身份；缺省用默认播种" })),
				enabled: Type.Optional(
					Type.Boolean({ description: "set_dispatch 必填：true=开派发权 / false=关" }),
				),
					partnerId: Type.Optional(
						Type.String({ description: "stop/set_dispatch 必填（执事 id）；list 可选按 id 过滤" }),
					),
				}),
				execute: async (args, api) => {
					const ctx = ministerContext();
					const conversationId = Number(api.conversationId);
					// 只有总管 / 主对话能管理执事：effectivePartnerIdOfSession 落到非 chief 的真实
					// uuid（某执事的专线会话）一律拒；owner 会话解析为 chief / null，放行。
					const effective = effectivePartnerIdOfSession(ctx.store, conversationId);
					if (effective !== null && effective !== CHIEF_PARTNER_ID) {
						return text("只有总管可以管理执事");
					}
					if (args.action === "create") {
						const name = (args.name ?? "").trim();
						const domain = (args.domain ?? "").trim();
						if (!name) return text("name 必填且不超过 40 字");
						if (!domain) return text("domain 必填：小写 ASCII 领域名，之后派活用");
						if (args.soul && args.soul.length > 4000) {
							return text("soul 太长，一句话身份即可");
						}
						const result = createMinisterPartner({ name, domain, soul: args.soul }, ctx);
						if (!result.ok) return text(result.error);
						return text(
							`执事 ${result.value.name} 已就位，domain=${result.value.domain}，之后派活用 domain`,
						);
					}
					if (args.action === "stop") {
						const partnerId = (args.partnerId ?? "").trim();
						if (!partnerId) return text("stop 需要 partnerId（执事 id）");
						if (partnerId === CHIEF_PARTNER_ID) {
							return text("不能停总管自己：总管是主对话本体，不在可停用的执事里。");
						}
						const partner = ctx.store.get(partnerId);
						if (!partner || !partner.domain) {
							return text(`找不到 id 为 ${partnerId} 的执事（只能停带 domain 的执事）。`);
						}
						const result = stopMinisterPartner(partnerId, ctx);
						if (!result.ok) return text("执事不存在或已被停用。");
						return text(
							`执事 ${partner.name}（domain=${partner.domain}）已停用并归档，之后派活不要再指向它。`,
						);
					}
					if (args.action === "list") {
						const rows = listMinisterPartners(ctx, (args.partnerId ?? "").trim() || undefined);
						if (rows.length === 0) return text("（暂无执事；用 create 建一个）");
						return text(
							rows.map(
								(row) =>
									`${row.name} · ${row.domain} · ${row.status} · 派发权${row.dispatchAuthority ? "开" : "关"}`,
							).join("\n"),
						);
					}
					if (args.action === "set_dispatch") {
						const dispatchId = (args.partnerId ?? "").trim();
						if (!dispatchId) return text("set_dispatch 需要 partnerId（执事 id）");
						if (typeof args.enabled !== "boolean") {
							return text("set_dispatch 需要 enabled（true=开 / false=关）");
						}
						const result = setMinisterDispatchAuthority(dispatchId, args.enabled, ctx);
						if (!result.ok) return text(result.error);
						return text(
							`执事 ${result.value.name}（domain=${result.value.domain}）的派发权已${args.enabled ? "打开：之后 delegate(domain=…) 会以它的名义派分管" : "关闭：之后 delegate(domain=…) 不再经过它，等同无分管领域"}。`,
						);
					}
					return text("action 只能是 create / stop / list / set_dispatch");
				},
			}),
		);
	}

	return tools;
}
