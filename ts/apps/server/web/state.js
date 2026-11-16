/**
 * 会话级前端状态（state）
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { KEY_CONV } from "./dom.js";
import { readToken } from "./net.js";

const state = {
  token: readToken(),
  conversationId: localStorage.getItem(KEY_CONV) || "",
  /* 会话种类（2026-11-06 C 批）：chief|worker|partner。没有落盘会话时，首屏就是一个
     普通 worker 空会话；有落盘会话时先空着，等 /messages 回读再认（不靠 id 猜）。 */
  chatKind: localStorage.getItem(KEY_CONV) ? "" : "worker",
  // 服务连通（/healthz）与总管档案状态：两者共同决定绿色在线点，sending 不再参与
  serviceOk: false,
  chiefStatus: "active",
  // 执事缓存：头像 / 名字 / 状态都从这里取，避免每处再拉一遍
  partners: [],
  // 导航令牌：快速切会话时让旧的 open 响应作废，不允许把页面抢回去
  navToken: 0,
  // 路由世代：每次真实路由切换 +1（含浏览器后退）；旧 open 即使回到同一 hash 也失效
  routeGen: 0,
  // go() 自己写入的 hash：下一次 hashchange 认领它，不再当成用户导航
  selfNavHash: "",
  // 正在 open 的执事（防双击；同一个执事并发只发一次）
  partnerOpening: new Set(),
  // 任务专线会话（2026-11-15 侧栏按创建者分组）：/agent/chats 的增量 tasks 键；
  // 回滚开关关着 / 老服务端没有该键时为空数组 → 侧栏回旧版平铺
  taskChats: [],
  sending: false,
  stopRequested: false,
  stick: true,
  // 待发图片（2026-11-08 扫尾批 4a）：{mimeType, data(裸 base64)}，只存内存，切换会话/发出即清
  pendingImages: [],
  // 待发文件（2026-11-13 附件走路径）：{path, name, mimeType?, bytes?}，只存路径不存内容
  pendingFiles: [],
  // 能力投影（GET /agent/policy 的 attachments / fileAttachments / editResend / approvalMode）：
  // 关着时入口不渲染；审批形态决定审批卡显示倒计时还是「等待处理」
  capabilities: { attachments: true, fileAttachments: true, editResend: true, approvalMode: "async" },
  chats: [],
  // 已归档会话计数（GET /agent/chats 的 archived）；会话列表本身不返回它们
  archived: 0,
  query: "",
  // 任务中心：一次拉列表（最多 200 张），看板/详情/徽标都从这里派生
  tickets: [],
  ticketsFetchedAt: 0,
  ticketsLoading: false,
  // 取消/重试开关（扫尾批 1 A1）：来自 GET /tickets 的 cancelEnabled；关时不渲染按钮。
  ticketsCancelEnabled: false,
  domainFilter: "",
  projectFilter: "",
  sort: "recent",
  // 「已完结」折叠区是否展开：只记会话内存，刷新即回到收合态
  tasksArchiveOpen: false,
  // 「更早的直派」折叠组是否展开（L3）：同样只记会话内存，默认收起
  tasksDirectOpen: false,
  // 派活行内「子单 N」展开态：Set of 派活行（父单）id，同样只记会话内存
  tasksChildrenOpen: new Set(),
  // 多副本组展开态（批 19 §五）：Set of groupId（= requestId），只记会话内存
  tasksFanoutOpen: new Set(),
  // 外部打手过滤（L3）：空 = 不过滤；等于某个 employee 时只留含该执行者的对话卡
  tasksEmployeeFilter: "",
  // 运行时开关投影：null = 还没拉过；Map(key → flag 行)。只拉一次 GET /api/v1/agent/flags。
  flagsCache: null,
  // 对话流逐字浮现（2026-11-13）：null = 开关还没回来，按默认开跑；false 走旧的整块渲染。
  chatRevealFlag: null,
  // 任务中心重做开关（2026-11-13 批 1）：null = 还没问过；true/false = 已定。
  tasksRedesignFlag: null,
  // 对话历史分页开关（2026-11-13）：null = 还没问过；false 走旧的一次拉 200 条。
  chatPagingFlag: null,
  // 历史翻页状态（2026-11-13 按天分组·上滑加载）：只对当前会话有效，切会话即重置。
  // started=false 时滚动监听不触发；cursor=null 且 hasMore=false 表示已经到最早。
  history: { started: false, cursor: null, hasMore: false, loading: false, pages: 0, top: null },
  // 「等你回话」按派活人分组后，每个人「还有更早的」展开态：
  // Set of person key（`c:chief` / `p:<partnerId>`），只记会话内存（刷新回默认收起）
  tasksNeedsOlderOpen: new Set(),
  // 打手手风琴展开态：Set of employee id，只记会话内存
  tasksHitterOpen: new Set(),
  // 是否已经替用户默认展开过一次第一个在跑的打手（之后用户的开关说了算）
  tasksHitterSettled: false,
  // 今日回顾当前看的那天（本地 YYYY-MM-DD）；空 = 还没进过页面
  reviewDay: "",
  // 项目筛选的选项来自 GET /api/v1/projects；接口不在时用任务单里的项目名兜底
  projects: [],
  projectsFetchedAt: 0,
  // SSE 断点重放（2026-11-04 seq 方案）：当前会话已收到的最大事件序号。
  // 切会话/刷新即归零——那两种路径本来就走 /messages 全量回读，不需要补帧。
  maxSeq: 0,
  // 模型投影（批次五）：GET /agent/model 的最近一次结果，只做展示，不当缓存用
  modelCatalog: null,
  // 设置页供应商投影（批次五）：GET /agent/providers
  providers: [],
  // 搜索源投影（2026-11-12 多供应商）：GET /agent/search-provider
  searchSources: [],
  searchVendors: [],
  // 模型页右栏当前状态（G1；2026-11-09 随供应商双栏从服务页拆到模型页）：
  // templates=模板选择 / form=编辑现有 / new=新建表单 / empty
  providerView: { mode: "empty", providerId: "", templateId: "" },
  // 套餐选择（2026-11-13）：模板 id + 选中的套餐 id；换模板时重置到第一档
  providerPlanTemplate: "",
  providerPlanId: "",
  // 密钥填写形态：api=界面直填（PUT /secret）；env=后端没有该接口时退回变量名手输
  providerSecretMode: "api",
  // 供应商表单里的模型草稿（2026-11-05）：{ id, contextWindow, maxTokens, thinkingLevels }
  // 只在前端编辑，点「保存」才随供应商一起落盘。
  providerModels: [],
  // 侧栏项目面板（2026-11-06 起是总览，不再切「当前项目」）：
  // 项目列表每次打开现拉（同模型菜单口径），不在这里缓存。
  switcher: { workspace: null, subCount: 0, unavailable: false },
};

export { state };
