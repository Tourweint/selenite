# 变更记录：电脑操作能力接入（agent-desktop 技能路线，零服务端代码）

日期：2026-11-10
上位：方案 `docs/设计方案/2026-11-10-方案（agent-desktop 电脑操作接入）.md`（用户拍板"肯定要做，先方案后执行"，方案当日评审、当日执行）。
状态：已落地。**无任何服务端代码改动**；改动面 = 真实技能目录（`~/.agents/skills/`，仓库外）+ 生产技能启停 state + 本文档 + `系统架构.md` §7。
影响面：
- `~/.agents/skills/agent-desktop/`（新增：官方 SKILL.md 整目录拷贝，description 折单行，见落地偏差）
- `ts/apps/server/.data/skills-state.json`（生产运行数据，已 gitignore：`agent-desktop: true`）
- `docs/基线文档/系统架构.md`（§7 登记四条边界 + 符号链接条目补对照）
- `docs/设计方案/2026-11-10-方案（agent-desktop 电脑操作接入）.md`（补状态头）

## 改了什么、为什么

1. **电脑操作以"官方技能手册 + 现有 bash 工具"接入本机 agent-desktop CLI（Vercel Labs，1.2.0）**。
   零服务端代码：agent 跑 `agent-desktop` 官方 CLI（OS 无障碍树路线，Windows=UIA），`snapshot` 读界面
   → `click @ref` → 再 snapshot 验证；手册 = 仓库 `skills/agent-desktop/`（SKILL.md + references/ 四分册）
   整目录拷到 `~/.agents/skills/agent-desktop/`（真实目录，非符号链接——**进设置页管理列表**，与 ego 软链不同）。
   平台差异不维护本地副本：手册教 agent 跑 `agent-desktop skills get platform`，二进制自带版本对应指南。
2. **生产服务开启该技能**：`PUT /api/v1/agent/skills/agent-desktop/enabled` → 200（Bearer AGENT_TOKEN，
   token 未落任何输出）；`.data/skills-state.json` 确认含 `agent-desktop: true`。
   L1 索引随下一个会话出现（索引按会话冻结，D5 口径）；已在跑的会话里 `skill()` 立即可取。
3. **CLI 安装（本机一次性）**：`npm i -g --allow-scripts=agent-desktop agent-desktop`。不进壳安装器、
   不进服务端启动逻辑（方案的"明确不做"第 7 条）。

## 落地偏差（与方案对照）

1. **V1 降级路径走通，且发现系统性缺口**：官方 SKILL.md 的 frontmatter 是 YAML `>` 多行 description，
   `skills.ts` 的最小解析器**刻意不做**多行块（代码注释明写）——原样拷贝则 valid=false、占名不进索引。
   处置：把**拷贝件**的 description 折成单行（YAML `>` 的语义本就是折行成空格，内容一字未改），
   reference 克隆原件未动。**实测本机 `~/.agents/skills` 另有 12 条技能同病**（autoglm-browser-agent、
   baoyu-translate、general-video、hyperframes 等）——已登记 `系统架构.md` §7，换解析器单独立项（免方案类）。
2. **V3 比预想更顺**：真实目录不触发 path-guard（只挡指向外部的符号链接），agent-desktop **进管理列表**
   （origin=agents / form=dir / writable=false / enabled 位随启停同步）——ego 的"设置页看不到"这次没有。
   V3 还踩了一次断言口径：关闭 = 从 state 名单**拿掉**（skill-state.ts:70"文件只存开着的"），
   不是落 `false`；修正断言后 12/12 全绿。
3. **V4 第一轮题目太弱（如实记）**："列出桌面上开着哪些应用"被 PowerShell `Get-Process` 答掉了
   （模型还先试了 macOS 的 osascript——训练惯性），技能没被选中，**但答案数据是真实的**。
   题目改成"读 ZCode 窗口里的界面内容"（只有无障碍树能解）后第二轮全绿——这个"什么题目才逼出技能"
   的观察对以后写任务书有用：**要让技能成为最短路径，而不是绕路风景**。
4. **V4 前修了两个脚本 bug（不影响被验对象）**：①工具帧字段读错层级（cast 撒谎）；②ChatRequest 的
   消息字段是 `content` 不是 `text`（shared schema 为准）。

## 验证

- **V1 技能链**：真代码 + 真用户目录 `createSkillStore(resolveSkillsDir().dirs)` → 124 条加载、
  agent-desktop 在索引、summary 取 frontmatter description、`manual()` 6105 字节全文可取。
  （第一轮 store 为空是验证脚本自己传错参数——`SkillSource` 对象数组当路径串传了，与被验对象无关。）
- **V2 CLI 基线**：`status`（platform=windows，权限 granted）/ `list-apps` / 对活窗口
  `snapshot --skeleton -i --compact` 拿到带 ref 的语义树（ZCode 2 refs；explorer 在首轮装机实测 24 refs）。
  已关窗口报 `APP_NOT_FOUND`（disposition.retry=safe）= 如实拒绝。
- **V3 管理面**：隔离实例（端口 8099，数据全落 scratch，跑完删除）真 HTTP 12/12：列表含条目、
  单条读原文、启停一圈、state 文件、列表 enabled 位同步。
- **V4 端到端真模型**：deepseek-v4.1-flash + 隔离库（scratch，跑完删除），28 次工具调用：
  `skill("agent-desktop")` 取手册 → `status` → `list-windows` → `snapshot --app ZCode.exe` →
  `snapshot --root @ref` 钻取 → 回报窗口内容**与真实侧栏逐条对得上**（任务条目、分区结构、按钮全真）。
  观察-行动-验证循环与手册纪律（ref 钻取、超时参数）实际用上。
- **回归**：`pnpm typecheck` / `pnpm probe` 不适用（未触碰 TS 代码）；skills-probe 用隔离假 home，
  测不到真 home 的新技能，不加跑（V1 已用真链路覆盖同一面）。

## 已知边界

四条已下沉 `系统架构.md` §7（以那里为准）：agent-desktop 能力与覆盖边界（自绘 UI 0 ref / UAC / 按住类）；
桌面内容不可信 + 隐私与日志口径；共桌与 `--headed` 光标占用；frontmatter 多行 YAML 解析缺口（12 条受影响）。

## 缓存前缀资产核对

工具描述与注册顺序零改动。技能索引是 L1 section（按会话冻结）：新会话索引多一行 agent-desktop，
已在跑的会话不受影响（D5 口径，接口 note 原文确认）。
