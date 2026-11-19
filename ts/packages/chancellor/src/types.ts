export type TicketStatus =
  | "received"
  | "planning"
  | "planned"
  | "dispatching"
  | "reviewing"
  | "done"
  | "needs_you"
  | "idle"
  | "failed"
  | "aborted";

/** 对外 5 态：按「在等谁」分，不按内部进度。 */
export type TicketOutcomeStatus = "done" | "needs_you" | "failed" | "idle" | "aborted";

/** 内部 stage：第一个匹配生效；只落在 ticket.json 里，不对外。 */
export type TicketStage =
  | "person/answer"
  | "person/blocked"
  | "review"
  | "idle"
  | "failed"
  | "done"
  | "aborted";

export type TaskStatus =
  | "pending"
  | "running"
  | "reported"
  | "passed"
  | "failed"
  | "blocked"
  | "waiting"
  | "dropped";

export type WorkerStatus = "ready" | "waiting" | "blocked" | "failed" | "dropped" | "progress";

/** worker 要人做的事：给信息、拍板、或动手（登录/付款等）。 */
export type AttentionKind = "need_input" | "need_decision" | "need_action";

export interface WorkerAttention {
  question: string;
  kind: AttentionKind;
}

/**
 * worker 跑动中的决策上报（2026-11-19 批2：worker→总管→用户上报链）。
 * 形状与 escalate 工具参数同构；序列化 / 解析在 escalation-payload.ts，
 * 这里放类型是因为 ChancellorEvent / EmployeeTask 都要引用它。
 */
export interface WorkerEscalation {
  escalationId: string;
  question: string;
  context: string;
  options?: string[];
  urgency: "low" | "normal" | "high";
}

export type Verdict = "pass" | "fail" | "blocked";

/**
 * 一个声明路径的指纹（2026-11-04）：`size + mtimeMs` 先筛，疑似变化才算 sha1。
 * 目录过大退化到粗判时没有 `hash`，只剩元数据。
 */
export interface FileFingerprint {
  size: number;
  mtimeMs: number;
  hash?: string;
}

/** 执行前的声明路径快照；key 是相对项目根的 posix 路径，缺失即「不存在」。 */
export type PathSnapshot = Record<string, FileFingerprint>;

/**
 * 干活的是谁：原生 pi-durable 实例、外部 CLI（qoder / CodeBuddy / Claude Code /
 * Codex / OpenCode）、MCP 服务器、手机，或分管宰相。
 */
export type EmployeeKind =
  | "native"
  | "mercenary"
  | "codebuddy"
  | "qoder-intl"
  | "qoder-cn"
  | "claude-code"
  | "codex"
  | "opencode"
  | "mcp"
  | "phone"
  | "manager";

/** 真正动手的雇员；分管宰相只派活，不算 worker 雇员。 */
export type WorkerKind = Exclude<EmployeeKind, "manager">;

/** 外部 CLI 的权限档；各适配器映射到自己的参数。 */
export type EmployeePermission = "read" | "edit" | "full";

/**
 * 一次派单的雇员参数（2026-11-16 多 CLI 适配）。
 * 模型留空 = 不传参数，跟随 CLI 自己的配置；权限缺省 = full。
 * CodeBuddy / Qoder 只读 model，权限固定全权。
 */
export interface EmployeeProfile {
  model?: string;
  permission?: EmployeePermission;
}

/** 雇员的产物形态；规划器据此写 done_when，验收仍只认任务目录。 */
export interface EmployeeCapabilities {
  /** 产物落在哪：任务目录 / 外部设备（手机）。 */
  artifacts: "taskDir" | "device";
  /** 能不能写文件到任务目录。 */
  canWriteFiles: boolean;
  /** 一句话，直接进规划器提示词；能写文件的雇员不给。 */
  note?: string;
  /**
   * 是否支持带会话号续接（外部 CLI 的 `-r <session_id>`，2026-11-08 扫尾批 8f）。
   * 只是能力声明：怎么续由雇员自己的 `resume` 实现决定；不支持的一律重派新单。
   */
  resumeWithSession?: boolean;
}

export interface PlannedTask {
  title: string;
  slug: string;
  instruction: string;
  done_when: string;
  /** 只能依赖 seq 更小的任务；省略等价于空数组。 */
  dependsOn: number[];
  /**
   * 本任务会写入项目的相对路径（2026-11-03 方案 §5.4）。
   * 不声明 = 只读任务；一旦检出未声明的写入即判失败。
   */
  writes: string[];
}

export interface DroppedDep {
  seq: number;
  value: unknown;
  reason: string;
}

export interface DependencyReport {
  seq: number;
  slug: string;
  dirName: string;
  reportRaw: string;
  /** 上游 artifacts 的文本内容（已按 2 KB 截断，二进制只留路径）。 */
  artifactsText: string;
  /**
   * 上游已验收落盘的实际产物（相对项目根，posix）；与验收快照同源。
   * 只给路径不给内容：下游用 read 工具自己看。空数组 = 不注入这一段。
   */
  artifactPaths: string[];
}

/** 已登记项目的最小引用；由总管（harness）校验并下发，chancellor 只记录与透传。 */
export interface ProjectRef {
  id: string;
  name: string;
  /** realpath 归一后的项目根；任务落点 */
  rootPath: string;
  vcs?: "git" | "none";
  /** 项目登记时的基线提交；worktree 从这里拉副本，合并也以它为基线。 */
  head?: string | null;
  /** 总管给这个项目留的数据目录（租约、worktree）；chancellor 只往里写。 */
  dataDir?: string;
}

export interface TicketOptions {
  dry: boolean;
  maxTasks: number;
  workRoot: string;
  /** 总管明确给的领域；没有就按 v0.3 直接派 worker。 */
  domain?: string;
  /** 这张单落在哪个项目里（2026-11-03 方案 §5.5）。 */
  project?: ProjectRef;
  /**
   * 建单时的雇员参数快照（2026-11-16 多 CLI 适配）。
   * 续跑 / 崩溃恢复沿用原单快照，改默认只影响新单。
   */
  employeeProfile?: EmployeeProfile;
  /**
   * 这张单在哪个目录里干活（2026-11-17 跨仓契约，宿主已校验绝对路径 + 落在登记根内）。
   * 不传 = 项目主文件夹；gitIsolated 走 worktree 时本字段不生效。
   */
  workDir?: string;
}

export interface Ticket {
  id: string;
  prompt: string;
  status: TicketStatus;
  created_at: string;
  updated_at: string;
  options: TicketOptions;
  /** 这单用的雇员；v0.3 之前的老 ticket.json 没有这个字段。 */
  employee?: EmployeeKind;
  error?: string;
  /** 内部 stage；v1.0 之前的老 ticket.json 没有这个字段。 */
  stage?: TicketStage;
  /** 收单幂等 key；没带 key 的老 ticket.json 没有这个字段。 */
  idempotencyKey?: string;
  /** 父任务单；子任务全部终态前，父单不得进完成、不得汇报。 */
  parentTicketId?: string;
  /**
   * 来源宿主的对话标识（2026-11-05，跨仓契约）。只透传：本单原样落盘，
   * 子单从父单继承，chancellor 不解读格式与语义。老 ticket.json 没有这个字段。
   */
  originConversationId?: string | null;
  /**
   * 最近一次动作（事件里那句话，2026-11-04）：落盘给看板与重启后的详情用。
   * 事件本身仍走 SSE，这两个出口同源。
   */
  lastAction?: string;
  /** 最近一次活动时间（ISO）；状态变化与进度落盘都会刷新，用于判断「还活着」。 */
  lastHeartbeat?: string;
  /** 最近卡在哪个文件租约上；任务重新开始或状态变化后仍保留最后一次。 */
  waitingOn?: string;
  /**
   * 计划附件（2026-11-09 保证实现纵深 §2）：这条要求拆成的可核对动作序列。
   * 宿主校验后透传（≤12 条、每条 ≤200 字）；没有就是旧行为。
   * 只落 ticket.json 并进规划器提示词，不参与验收判定。
   */
  steps?: string[];
  /**
   * 返工轮次（2026-11-09 §1.2）：这张单已经自动修过第几轮（0/缺省 = 没返工）。
   * 与生命周期无关，只记事实；宿主与看板据此展示。
   */
  repairRound?: number;
}

export interface Task {
  ticket_id: string;
  seq: number;
  slug: string;
  title: string;
  dir: string;
  status: TaskStatus;
  /** 老库迁移后可能是 null；新任务一定写。 */
  employee: EmployeeKind | null;
  updated_at: string;
}

export interface WorkerReport {
  status: WorkerStatus;
  summary: string;
  artifacts: string[];
  /** 只有 blocked 时用来结构化说明「我在等你什么」。 */
  attention?: WorkerAttention;
  raw: string;
}

export interface QoderResult {
  ok: boolean;
  result: string;
  sessionId: string | null;
  isError: boolean;
  /** permission_denials 的条数；0 才算真干成了。 */
  permissionDenials: number;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  stderrTail: string;
  error: string | null;
}

/** CodeBuddy 的结果；与 QoderResult 同一套字段（拒绝数必须为空）。 */
export interface CodeBuddyResult {
  ok: boolean;
  result: string;
  sessionId: string | null;
  isError: boolean;
  /** permission_denials 的条数；0 才算真干成了。 */
  permissionDenials: number;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  stderrTail: string;
  error: string | null;
}

/**
 * 外部 CLI 的统一结果（2026-11-16 多 CLI 适配）。
 * Claude 走 `type=result`，Codex / OpenCode 走 JSONL；字段够 EmployeeOutcome 用即可。
 */
export interface ExternalCliResult {
  ok: boolean;
  result: string;
  sessionId: string | null;
  isError: boolean;
  /** permission_denials 的条数；0 才算真干成了。 */
  permissionDenials: number;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  stderrTail: string;
  error: string | null;
}

export interface TaskRun {
  ticketId: string;
  seq: number;
  task: PlannedTask;
  dir: string;
  dirName: string;
  employee: EmployeeKind;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  processOk: boolean;
  processError: string | null;
  sessionId: string | null;
  reportExists: boolean;
  report: WorkerReport | null;
  reportError: string | null;
  stderrTail: string;
  /** 实际执行的工作目录（worktree 或项目根）；老数据没有。 */
  workDir?: string;
  /** 执行后项目工作区里实际变更的声明路径（相对项目根，posix）；验收以此为准。 */
  changedPaths?: string[];
  /** 执行前快照；从磁盘续跑时由 snapshot-before.json 读回，供严格前后对比。 */
  snapshotBefore?: PathSnapshot;
  /** 执行前/后快照是否因目录过大退化成了 mtime+size 粗判。 */
  snapshotCoarse?: boolean;
  /** 隔离/合并阶段判失败的原因；有值即视为 processOk=false。 */
  failure?: string | null;
}

export type ReviewStage = "process" | "report" | "artifacts" | "llm";

/** 分管宰相这一轮的结论；落在 plan.json 的 manager 块里。 */
export interface ManagerRunRecord {
  domain: string;
  line: string | null;
  exit_code: number | null;
  timed_out: boolean;
  aborted: boolean;
  conversation_id: number | null;
  /** 本次是否复用了已有会话；null = 进程没打出这行日志。 */
  reused: boolean | null;
  /** 复用时的历史消息数。 */
  history: number | null;
  error: string | null;
}

export interface Review {
  ticket_id: string;
  seq: number;
  slug: string;
  verdict: Verdict;
  reason: string;
  stage: ReviewStage;
  /** 不影响判定、但需要让人看到的校对提示（比如 artifacts 对不上）。 */
  warnings?: string[];
}

export interface PlanAttempt {
  attempt: number;
  ok: boolean;
  error: string | null;
}

export interface PlanResult {
  ok: boolean;
  tasks: PlannedTask[];
  droppedDeps: DroppedDep[];
  attempts: PlanAttempt[];
  error: string | null;
  raw: string;
}

// ---- 对外挂载契约（src/index.ts 的公开接口） ----

export interface ChancellorRequest {
  /** 正常收单时必填；resume 时可以省略。 */
  requirement?: string;
  maxTasks?: number;
  dry?: boolean;
  workRoot?: string;
  /** 有领域且 managers 不为 false 时交给分管宰相；否则完全走 v0.3。 */
  domain?: string;
  /**
   * 已登记项目（总管校验后下发）。
   * 没有项目时总管就不该派单；chancellor 只把它记进 ticket，并透传给负责人和子任务。
   */
  project?: ProjectRef;
  /** 硬开关：false 时忽略 domain，绝不建分管（递归在此断掉）。 */
  managers?: boolean;
  /** 可选收单幂等 key：同一个 key 只产生一张单；不带时每次新建。 */
  idempotencyKey?: string;
  /** 这张单是哪个父单派出来的；子单会被父单的完成闸门收口。 */
  parentTicketId?: string;
  /** 接着一张停在 needs_you 的单往下跑；不会新建 ticket。 */
  resumeTicketId?: string;
  /** resume 时给人回答的内容；交给 task 自己的 resume 实现。 */
  answer?: string;
  /**
   * 宿主注入的宰相身份（批次D D2，跨仓契约）。chancellor **只透传不解读**：
   * name / soul 两个字符串原文塞进分管宰相的提示词，不解析、不落库、不改语义。
   * soul 由宿主侧按 UTF-8 字节截断到 ≤4KB；单次派单取伙伴的当前版本快照正文，
   * 这一轮内不变。没有值时分管提示词与改动前完全一致（兼容旧领域）。
   */
  managerIdentity?: { name: string; soul: string };
  /**
   * 发起这次派活的宿主对话标识（2026-11-05，跨仓契约）。chancellor **只透传不解读**：
   * 原文落进 ticket.json，子单创建时从父单继承；不解析格式、不查库、不改语义。
   * 没有值时与改动前完全一致（兼容旧 ticket.json）。
   */
  originConversationId?: string;
  /**
   * 计划附件（2026-11-09 保证实现纵深 §2）：宿主校验后的可核对动作序列。
   * 原样落进 ticket.json.steps，并交给规划器；不传 = 旧行为。
   */
  steps?: string[];
  /**
   * 用哪个 worker 雇员（2026-11-16 多 CLI 适配）。不传 = 全局 `CHANCELLOR_EMPLOYEE`。
   * 只影响新单；续跑按 ticket.employee 原样走。
   */
  employee?: WorkerKind;
  /**
   * 这次派单的模型 / 权限参数（2026-11-16）。不传 = 各 CLI 的 env 缺省。
   * 新单落进 ticket.options.employeeProfile，续跑与崩溃恢复沿用快照。
   */
  employeeProfile?: EmployeeProfile;
  /**
   * 这张单在哪个目录里干活（2026-11-17）。宿主已校验：绝对路径、落在登记根内。
   * 只影响新单；不传 = 项目主文件夹；gitIsolated 时仍以 worktree 为准。
   */
  workDir?: string;
  /**
   * 质检方式（2026-11-19 批2，派活设置「质检方式」透传）：true = worker 自报完成后
   * 不走内部一次请求验收，改派一单质检 worker（templates/qa.md，走既有派单器）。
   * 只影响新单；false / 不传 = 内部请求（现状）。续跑沿用现状。
   */
  qaWorker?: boolean;
}

export type ChancellorEventType =
  | "ticket"
  | "manager"
  | "planned"
  | "task-start"
  | "task-done"
  | "task-waiting"
  | "reviewing"
  | "goal"
  | "finished"
  /** worker 跑动中的决策上报（2026-11-19 批2）：escalation 专用类型。 */
  | "escalation";

export interface ChancellorEvent {
  type: ChancellorEventType;
  ticketId: string;
  seq?: number;
  slug?: string;
  message?: string;
  /** 只有 planned 事件带：这次拆出几件活。宿主拿它显示「正在办 · 2/3」。 */
  total?: number;
  /** 任务在等哪个文件租约（task-waiting 事件带）。 */
  waitingOn?: string;
  /** 只有 escalation 事件带：上报的原始载荷（2026-11-19 批2，宿主照搬进对外事件）。 */
  escalation?: WorkerEscalation;
}

export interface ChancellorTaskResult {
  seq: number;
  slug: string;
  title: string;
  status: "passed" | "failed" | "blocked" | "waiting" | "dropped";
  reason: string;
  dir: string;
  /** worker 卡住时提的具体问题；宿主拿它出「需要你」卡片，不用从 reason 里猜。 */
  attention?: WorkerAttention;
}

export interface PlannedTaskInfo {
  seq: number;
  slug: string;
  title: string;
  done_when: string;
  dependsOn: number[];
}

export interface TicketResult {
  ticketId: string;
  status: TicketOutcomeStatus;
  line: string;
  tasks: ChancellorTaskResult[];
  /** 整单第一个还没人回答的问题；没有就是 undefined。宿主据此出卡片。 */
  attention?: WorkerAttention;
  /** 只有 --dry 时有值：拆出但尚未执行的任务。 */
  plannedTasks?: PlannedTaskInfo[];
  /**
   * 返工轮次（2026-11-09 §1.5）：这张单最终是第几轮修复的结论（0/缺省 = 没返工）。
   * 宿主只透出，不改判定。
   */
  repairRound?: number;
}

/** 达成 / 有结论但没达成 / 核对器没给出结论。 */
export type GoalOutcome =
  | { satisfied: true; reason: string }
  | { satisfied: false; reason: string }
  | { satisfied: false; inconclusive: true; reason: string };

export interface GoalCheckResult {
  satisfied: boolean;
  reason: string;
  aborted: boolean;
  /** true 表示核对器输出异常、没给出结论，不是「没达成」。 */
  inconclusive: boolean;
}

/** 裁判四态（2026-11-10 批 14 §2.3）：与 opencode /goal 对齐后裁剪。 */
export type JudgeVerdictKind = "done" | "continue" | "blocked" | "wait";

/**
 * 裁判看到的任务材料（2026-11-10 批 14 §2.2）。
 *
 * **执行者自报不是证据**：`reportSummary` 只作为"它说它做了"的参考，
 * 裁判必须自己用工具查到东西才能给 done。`changedPaths` 由验收快照给出，
 * 是落盘事实（`changedDetected=false` 表示老数据没检测）。
 */
export interface JudgeTaskMaterial {
  seq: number;
  slug: string;
  title: string;
  doneWhen: string;
  writes: string[];
  changedPaths: string[];
  changedDetected: boolean;
  reportStatus: string | null;
  reportSummary: string | null;
  reportError: string | null;
  employee: string;
}

/** 交给宿主侧裁判（read-only 子会话）的全部输入。 */
export interface JudgeInput {
  ticketId: string;
  /** 用户原话；宿主侧用 `<untrusted_objective>` 包裹后再进提示词。 */
  prompt: string;
  /** 计划附件（可核对动作序列）；没有就是空数组。 */
  steps: string[];
  /** 读哪里：项目根（合并后的状态）；无项目时是任务单目录。 */
  cwd: string;
  /** 验收为什么判没通过（review 原话 / 目标核对原话）。 */
  failureReason: string;
  tasks: JudgeTaskMaterial[];
  reviews: Array<{ seq: number; slug: string; verdict: string; reason: string }>;
  /** 一次裁判最多几次工具调用（宿主结构性执行，chancellor 只透传）。 */
  maxTools: number;
}

/**
 * 裁判结论。`ok=false` 表示裁判没给出可用结论（调用失败 / 输出坏了 / 被中止）——
 * 这时**不改结局**，按原有失败路径走。裁判是补强，不是新的单点故障。
 */
export interface JudgeOutcome {
  ok: boolean;
  verdict?: JudgeVerdictKind;
  evidence: string[];
  reason: string;
  toolsUsed: number;
  aborted?: boolean;
  error?: string;
}

export type JudgeFn = (input: JudgeInput, signal?: AbortSignal) => Promise<JudgeOutcome>;

/** judge.json 里的一次裁判记录（事实源：人可复核为什么改判）。 */
export interface JudgeCallRecord {
  round: number;
  /** 实际生效的四态；`error` = 没给出结论（也记一笔，便于看裁判是否在报错）。 */
  verdict: JudgeVerdictKind | "error";
  /** 裁判原始四态（降级 / 连续同因改判前）。 */
  raw_verdict: JudgeVerdictKind | "error";
  reason: string;
  evidence: string[];
  tools_used: number;
  warnings: string[];
  error?: string;
  created_at: string;
}

export interface JudgeFile {
  ticket: string;
  calls: JudgeCallRecord[];
}

export interface ChancellorOptions {
  onEvent?: (event: ChancellorEvent) => void;
  signal?: AbortSignal;
  /**
   * 证据裁判（2026-11-10 批 14）：验收判 fail 时由宿主起一个 read-only 子会话，
   * 自己读工作区后给四态结论。不传 = 没有裁判（与旧行为一致）；传了也要
   * `DELEGATION_JUDGE=true` 才会被调用。chancellor 不 import 宿主，只用这个缝。
   */
  judge?: JudgeFn;
}

export type EventSink = (event: ChancellorEvent) => void;
