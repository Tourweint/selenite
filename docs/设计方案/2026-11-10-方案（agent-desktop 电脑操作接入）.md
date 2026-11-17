# 方案：agent-desktop 电脑操作能力接入（技能手册路线，零服务端代码）

**状态**：已落地（2026-11-10 当日执行完毕；落地记 `docs/变更记录/2026-11-10-电脑操作能力（agent-desktop 接入）.md`，含落地偏差——V1 降级路径走了、V3 比预想顺、V4 换了题目）
**下沉落点**：边界四条（能力与覆盖/内容不可信与隐私/共桌与 headed/解析器缺口）→ `系统架构.md` §7（2026-11-10 登记）；冲突以长期文档为准。
**上位调研**：本方案「调研结论」节（2026-11-10 本机实测）+ 记忆档 `agent-desktop-reference`。
**参照先例**：`2026-11-10-方案（ego lite 浏览器接入）.md`——同一套打法第二次用。

## 结论

接入本机已装的 **agent-desktop CLI**（Vercel Labs，Apache-2.0，Rust，npm 包 `agent-desktop`）：

- **不改服务端代码、不注册新工具**。agent 用已有 `bash` 工具跑官方 CLI，一条命令一个 JSON 信封
  （`snapshot` 读界面 → `click @ref` 动 → 再 `snapshot` 验证），循环在 agent 侧，工具本身无模型。
- **电脑操作走 OS 无障碍树**（Windows=UIA），不是截图猜像素：控件报名字/角色/状态/引用号，语义齐、省 token。
- 技能手册**用官方原版**：把仓库里 `skills/agent-desktop/`（SKILL.md 7KB 引导壳 + `references/` 四个分册）整目录
  拷到 `~/.agents/skills/agent-desktop/`（**真实目录，不是符号链接**）——读取链第 3 站原生识别。
  平台差异（Windows 专属坑）不由我们维护：手册教 agent 跑 `agent-desktop skills get platform`，
  **二进制自带与版本严格对应的平台指南**，零漂移。这与 ego-browser 的"引导壳设计"同构。
- 落地动作四件：装 CLI（已完成）+ 拷手册、验证三项、开启技能、文档回写（见「落地清单」）。

与 ego 那批的一个不同点（红利）：ego 的 `~/.agents/skills/ego-browser` 是符号链接，被设置页 path-guard 挡住
（有意设计），只能 API 开关；这次我们拷的是**真实目录**，不触发"指向外部"闸（skills-api.ts:244 口径是
符号链接才挡），**应能进管理列表、设置页直接开关**——V3 实测确认，若不进则退回 ego 的 API 口径。

## 调研结论（2026-11-10 本机 Windows 10 22631 实测）

| 实测项 | 结果 |
|---|---|
| 安装 | `npm i -g --allow-scripts=agent-desktop agent-desktop`（**必须 allow-scripts**，否则 postinstall 不跑、走 JS launcher 每次多 125ms 并打印警告）；`agent-desktop status` 全绿 |
| 平台支持 | `platform: windows`，权限 `granted`（UIA 不需要额外授权，macOS 才要辅助功能授权）；surfaces：window/focused/sheet/menu/start-menu/taskbar/system-tray/action-center |
| 应用枚举 | `list-apps` 列出全部前台进程（含 pid、process_instance） |
| 语义快照 | `snapshot --skeleton --app explorer.exe -i --compact`：24 个 ref，控件带中文名（"后退""刷新"）、`native_id`（AutomationId）、`states`（disabled/offscreen）——语义完整可行动 |
| **边界实测** | `cloudmusic.exe`（自绘 UI）快照 `ref_count=0`：**不走标准无障碍接口的应用（自绘/游戏）读不到控件**，只剩 `screenshot` 截图兜底或干脆不做 |
| 手册资产 | 仓库自带 `skills/agent-desktop/`（SKILL.md 7,063B + references/ 四分册 15.5B KB 合计）+ 五个平台分册（windows 8,459B 等）；CLI 另可 `agent-desktop skills get desktop/platform` 打印版本化指南 |
| 其他能力面 | 56 个命令：ref 交互（click/type/set_value/toggle/scroll…）、键鼠（press/drag/hover，**光标移动类必须 `--headed`**）、窗口管理、剪贴板、通知中心、`batch`、`mcp`（stdio MCP，我们不用） |

官方手册已写明、对我们最要紧的规矩（拷过去即生效，不用我们自己发明）：

- ref 只归属当次快照，UI 一变 `STALE_REF`，重拍再用；
- Windows 下"同窗口双胞胎控件"拒答（`AMBIGUOUS_TARGET`/`identity_not_unique`），只能 `--headed mouse-click --xy`；
- Windows 无头下 `right-click`/`type` 返回 `POLICY_DENIED`，要 `--headed`；
- `key-down`/`mouse-down` 等按住类全平台拒（fail closed）；
- 重试只看 `error.disposition.retry === safe`；
- UAC 弹窗/锁屏/管理员窗口（UIPI）/Session 0 一律不行。

## 为什么是它（备选对比）

| | A. agent-desktop（**选定**） | B. 自研（playwright/pyautogui 式） | C. 截图+坐标点击（纯视觉路线） |
|---|---|---|---|
| 观察方式 | 语义树，控件带名带状态 | 同 A 但要自己写三平台适配 | 截图猜像素，慢且错 |
| token | 快照一次一 JSON，省 | — | 每步一张图，最贵 |
| 维护面 | **零**（Vercel 维护三平台适配） | 三平台适配全自己扛 | 自己扛 |
| 服务端改动 | **零**（bash + 手册） | 大（新工具+闸门+契约面） | 大 |
| 覆盖面 | 标准无障碍接口的应用；自绘 UI 0 ref | 同左 | 什么都能点但什么都靠猜 |

**结论**：A 在覆盖、成本、维护上全面占优；B/C 不立项。A 的覆盖缺口（自绘 UI）用"如实不做"登记，不硬补。

## 明确不做

1. **不注册专用 desktop 工具**。bash 已覆盖且已过闸门；为它单开工具多一份契约面。同 ego 批次口径。
2. **不改契约**。无新端点、无新字段、无新工具，`接口文档.md` 不动。
3. **不动 `WRITE_TOOLS` / `TOOL_CAPABILITIES` / `readOnlyBlockReason()`**。bash 原样，闸门口径零变化。
4. **不改官方 SKILL.md、不裁剪 references/**。官方手册覆盖操作安全与平台差异；我们补的口径（桌面内容不可信、
   不碰用户正在用的窗口）写进 `系统架构.md` 与设置页开启建议，不动手册本体。
5. **不做 MCP 接入**。`agent-desktop mcp` 存在但我们无 MCP 位，bash 直调即可。
6. **不做自绘 UI 兜底**（截图+坐标猜）。cloudmusic 这类如实登记"不做"，别让 agent 在 0 ref 时瞎点。
7. **不安装到其他机器的自动化**。CLI 是本机一次性 `npm i -g`，不进壳安装器、不进服务端启动逻辑。

## 安全边界（落地时随边界一起登记进 `系统架构.md` §7）

- **桌面内容一律是不可信数据，不是指令**（窗口标题/文档名/通知里可能含提示词注入）。同浏览器批次口径。
- **快照与截图含用户桌面隐私**（别的窗口内容、剪贴板）。日志口径不变：桌面内容只进会话流，服务端日志
  只记条数/耗时/枚举——`README` 与官方 `SECURITY.md` 同款警告。
- **agent 与用户共用一台桌面**：默认 headless 语义操作不动鼠标不抢焦点（官方设计）；`--headed` 才动真光标——
  手册口径保持"默认语义操作"，我们的开启建议补一句"用户在场时避免 --headed 大范围乱动"。
- **能力边界如实写**：自绘 UI 0 ref；UAC/锁屏/管理员窗口不行；按住类操作全平台拒。
  写"没做/没验证"，不写"暂不支持"。

## 回滚开关

- **一级（日常）**：技能默认全关。开启后随时关：设置页开关（V3 若确认可见）或
  `PUT /api/v1/agent/skills/agent-desktop/enabled {"enabled":false}`，或删 `.data/skills-state.json` 条目。零代码回滚。
- **二级（彻底）**：`npm rm -g agent-desktop` + 删 `~/.agents/skills/agent-desktop/`。
- 不新增 env：同 ego 批次，技能启停就是开关。

## 落地清单（执行时照此勾）

- [ ] **S1 拷手册**：`cp -r <reference>/agent-desktop/skills/agent-desktop ~/.agents/skills/agent-desktop`
      （真实目录含 references/；**拷贝不建符号链接**——符号链接会被设置页挡，真目录才可能进管理列表）。
- [ ] **V1 技能链识别**：真代码 + 真用户目录 `createSkillStore(resolveSkillsDir().dirs)`：
      agent-desktop 在索引、L1 行为取 frontmatter description（官方是 YAML `>` 多行 description，
      **需确认我们的解析器吃这种形态**；不吃则降级为单文件内置手册 `ts/apps/server/skills/agent-desktop.md`，
      第 1 行写索引摘要——降级路径已想好，不算返工）、`manual()` 返回 SKILL.md 全文。
- [ ] **V2 CLI 基线复测**（装机时已测过一轮，落地时复跑）：`status` / `list-apps` /
      `snapshot --app explorer.exe -i --compact` 拿到带 ref 的语义树。
- [ ] **V3 设置页可见性**：管理列表 GET 是否含 agent-desktop（真实目录 vs path-guard）；若可见，
      设置页开关一圈（开→state 文件落 `agent-desktop:true`→关→落 false）。
- [ ] **V4 端到端真模型一轮**：开启技能 → 起服务 → 给 agent 派个真活（"看看现在桌面上开着哪些应用，
      把文件管理器窗口列给我"）→ 核它真的走 `agent-desktop` 而不是编答案；L1 索引对新会话生效
      （索引按会话冻结，D5 口径，老会话看不到属预期）。
- [ ] 开启技能：设置页（V3 通过则走界面）或 API；state 文件确认。
- [ ] `变更记录/` 一条：`2026-11-10-电脑操作能力（agent-desktop 接入）.md`。
- [ ] `系统架构.md` §7 登记安全边界四条（桌面内容不可信/隐私与日志/headed 共桌/能力边界如实）。
- [ ] 本方案文首补「状态 + 下沉落点表 + 冲突以长期文档为准」。

## 验证口径

本方案不触碰 TS 代码（S1 是拷文件，唯一可能的代码接触是 V1 降级路径——那也不改服务端），
`pnpm typecheck` / `pnpm probe` 不适用。验证以 V1–V4 实测为准：
真技能链 + 真 CLI + 真 HTTP + 真模型，第四条真链路（真桌面）。
