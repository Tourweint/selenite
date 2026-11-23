# W 任务书：Worker 人设全局一份可编辑（CodeBuddy）
> 状态：已执行（任务书，2026-11-16）。落地明细见 docs/变更记录/ 同期批次记录；实施以代码为准，冲突以长期文档（接口文档.md / 系统架构.md）为准。


**给谁**：CodeBuddy（`--model hy4flash-free`）。
**仓库**：`<repo>`。**不要提交 git**。
**先读**：`AGENTS.md`、`docs/设计方案/2026-11-16-Worker人设与低频工具索引.md` §1。
**范围**：只做 §1（Worker 人设）。**不要做** §2（低频工具索引）——那是下一批。

## 一、目标

所有 Worker（普通任务助手）共用一份人设，设置 → 人设里能看到、能改；改完下一轮生效。
人设页里 worker 只保留「正文」一块，不复制执事那套模块。

## 二、服务端

### 1. 新增 `ts/apps/server/src/worker-persona.ts`

```ts
/** 默认正文（原 WORKER_PERSONA + 「任劳任怨」一条）。 */
export function workerPersonaDefault(): string
export function workerPersonaPath(env = process.env): string   // WORKER_PERSONA_PATH || ".data/worker-persona.md"
export function readWorkerPersona(env = process.env): string    // 文件优先；不存在/空/读失败 → 默认
export function writeWorkerPersona(text: string, env = process.env): void
  // trim 后空 = 删除文件（回默认）；否则原子写（临时文件 + rename）
export function workerPersonaEditEnabled(env = process.env): boolean
  // WORKER_PERSONA_EDIT 为 false/0/off → 关；缺省 = 开
export const WORKER_PERSONA_LIMIT = 8192;  // 字节
```

- 默认正文（**固定字节，顺序不要改**）：
  ```
  你是一个普通任务助手，负责把交到你手上的具体事情办完。交代的事一定办到底：不推、不挑、不抱怨；办不成要说清卡在哪一步、缺什么。说话直接、克制、就事论事，给结论也给依据；不冒充总管，也不代表任何执事。涉及真实文件、真实数据、真实日程或当前时间的事，必须先用工具去看，不许凭印象回答或编造；看不到就说明缺什么。没有预设的私人档案，也不主动建立执事身份。需要长期记住的事用 remember；想不起对方说过什么用 recall；要定时提醒用 set_reminder。
  ```
  （原 `WORKER_PERSONA` 是数组 join("")；这里保持同一段文字 + 插入「交代的事一定办到底…」一句，
  原来那三条工具提示照旧在末尾。**别改写成多段**。）
- 写盘沿用仓库既有原子写写法（参考 `partner-store.ts` 的 `atomicWrite` / `skill-state.ts` 的 tmp+rename）。

### 2. 改 `ts/apps/server/src/agent/assist.ts`

- `WORKER_PERSONA` 常量**保留**（旧引用与测试还在用），但正文改成与 `workerPersonaDefault()` 同一份文本：
  直接 `export const WORKER_PERSONA = workerPersonaDefault();`，不要在两处各写一遍。
- `personaProvider` 的 worker 分支从 `WORKER_PERSONA` 改成 `readWorkerPersona()`（每轮现读）。
  其它分支（chief / 执事）不动。

### 3. 改 `ts/apps/server/src/context-defaults.ts`

- worker 角色的 persona 字段用 `readWorkerPersona()`（现在用的是 `WORKER_PERSONA` 常量）。

### 4. 端点（`ts/apps/server/src/index.ts`）

放在 `/api/v1/agent/context-defaults` 附近：

- `GET /api/v1/agent/worker-persona` →
  `{ok:true, persona, isDefault, editable, limit, chars}`；
  `isDefault` = 文件不存在或内容与默认一致；`chars` = `persona.length`；`cache-control: no-store`。
- `PUT /api/v1/agent/worker-persona` body `{persona}`：
  - `persona` 不是字符串 → 400 `{error:"bad_request", message:"persona 必须是字符串"}`；
  - `Buffer.byteLength(trim后, "utf8") > 8192` → 400 带说明；
  - `workerPersonaEditEnabled() === false` → 400 `{error:"bad_request", message:"Worker 人设编辑未启用（WORKER_PERSONA_EDIT=false）"}`；
  - 空串 = 恢复默认（删文件）；
  - 成功返回同 GET 形状。
- 鉴权同其它 `/api/v1/*`（沿用现有中间件，不要另写）。

## 三、前端

### 1. 设置 → 人设列表（`web/partner-modals.js` 的 `renderPartnerList`）

- 在循环 `partners` **之前**，先插入一张固定卡：「普通助手」。
  - 结构沿用 `.card.pt-card`；头像位置用一个纯文字圆点或首字「普」（复用 `paintAvatar(el, null, "普通助手")`）；
  - 名字行：`普通助手` + `<span class="pill-tag">全部 Worker 共用</span>`；
  - `pt-meta` 一行小字：`所有普通助手会话共用这一份人设，改完下一轮生效`；
  - 整卡可点，`location.hash = "#/settings/partners/worker"`；`aria-label="编辑普通助手的人设"`；
  - 没有 ⋯ 菜单、没有暂停按钮、没有状态徽章。
- 招聘大厅逻辑不变（`hasButlers` 仍只看真实执事）。

### 2. 新页面 `web/worker-profile.js`

导出 `renderWorkerProfilePage()`：

- 骨架照 `partner-profile.js` 的最小版：
  ```
  <div class="pf">
    <button class="pf-back" id="wf-back">← 总管与执事</button>
    <header class="pf-hero"> <h1>普通助手</h1> <div class="pf-meta">全部 Worker 共用 · 下一轮生效</div> </header>
    <section class="pf-sec"> 人设正文 </section>
  </div>
  ```
- 正文卡：
  - `<textarea class="pf-soul" id="wf-text">`（预填 GET 的 `persona`），下方字数 `N 字`（跟随输入实时更新）；
  - 底部按钮：`撤销`（回读取值）、`恢复默认`（把默认正文填进 textarea，**不直接保存**，用户再点保存）、`保存`；
  - 保存 → `PUT {persona}`；成功 `toast("已保存，下一轮生效")`，按钮回 disabled；失败在提示行显示原因；
  - `editable === false` → textarea `readonly`、保存 / 恢复默认 disabled，提示一行「Worker 人设编辑已关闭（WORKER_PERSONA_EDIT=false）」；
  - 读取失败显示一句原因 + 「重试」按钮（重新 GET）。
- **不要再加**人格模块、纪律、负责项目、工具、技能、例行任务等任何块；
  底部加一句只读说明：`Worker 不参与执事的人格模块、记忆召回与工具勾选。`
- 顶部返回按钮：`location.hash = "#/settings/partners"`。

### 3. `web/settings-router.js`

`page === "partners"` 分支里：

```js
const profileId = currentPartnerProfileId();
if (profileId === "worker") {
  void renderWorkerProfilePage();
  replayPageEnter();
  return;
}
if (profileId) { ...原样... }
```

### 4. `web/settings-persona.js`（右侧「人设」抽屉里 worker 会话那条提示）

把
`这条是普通助手会话，它的身份由服务端固定，没有可改的人设。到「全部设置 → 人设」可以改总管和各个执事。`
改成
`这条是普通助手会话，所有人设共用一个普通助手：到「全部设置 → 人设 → 普通助手」可以改。`

### 5. 样式

- 复用现有 `pf-*` / `pt-card` 样式即可；确实需要新类（如 `.wf-note`）就加到 `web/style-22-partner-profile.css` 末尾，**只加最小几条**，不要改无关样式。

## 四、配置与文档

- `ts/apps/server/.env.example`：
  ```
  # Worker（普通任务助手）人设（2026-11-16）：全局一份，设置 → 人设 → 普通助手 可改。
  # WORKER_PERSONA_EDIT=true
  # WORKER_PERSONA_PATH=.data/worker-persona.md
  ```
- `docs/基线文档/接口-端点4-执事例行与自主轮.md`：表格里加两行 worker-persona 端点（GET/PUT，含字段与错误码）。
- `docs/基线文档/接口文档.md` §6：加 `WORKER_PERSONA_EDIT` / `WORKER_PERSONA_PATH`。
- `docs/基线文档/系统架构.md`：模块表加 `worker-persona.ts`（存储 / 默认值 / 回滚），
  并在人设页章节补一句「普通助手是全局一份，不按会话存」。
- 新建 `docs/变更记录/2026-11-16-Worker人设与低频工具索引.md`，先写 W 段
  （改了什么、为什么、验证结果、没做/不确定）；C 段留给下一批追加。

## 五、测试

- 新增 `ts/apps/server/src/worker-persona.test.ts`（临时目录，`WORKER_PERSONA_PATH` 指过去）：
  - 文件不存在 → 默认正文，`isDefault` 语义成立；
  - 写入后读回一致；空串写入 → 文件删除、读回默认；
  - 超 8192 字节 → 写入抛错 / 端点 400（端点那条放 `companion-api.test.ts` 或独立 http 断言）；
  - `WORKER_PERSONA_EDIT=false` → `workerPersonaEditEnabled()` 为 false。
- `ts/apps/server/src/agent/injection.test.ts` 的 worker persona 断言改成与 `readWorkerPersona()` 一致
  （若它断言的是常量文本，改为 `assert.equal(sysText(...), WORKER_PERSONA)` 仍成立，因为两者同一份）。
- 端点测试加进 `companion-api.test.ts` 或 `index` 相关的既有测试文件（哪个已挂 agent 路由就用哪个）：
  GET 默认 / PUT 保存 / 空串恢复 / 超限 400 / 开关关 400。
- `ts/apps/server/package.json` 的 `test` 清单加 `src/worker-persona.test.ts`。
- 前端 `node --check web/worker-profile.js web/partner-modals.js web/settings-router.js web/settings-persona.js`。

## 六、验证命令

```bash
cd ts && pnpm typecheck
cd ts/apps/server && pnpm exec tsx --test src/worker-persona.test.ts src/agent/injection.test.ts src/context-defaults.test.ts src/companion-api.test.ts
node --check web/worker-profile.js && node --check web/partner-modals.js && node --check web/settings-router.js && node --check web/settings-persona.js
```
不要跑全量 `pnpm test`；不要启动 / 重启 39847 活服务；不要碰真实 `.data`（测试全部临时目录）。

## 七、完成标准

- 只改上面点名的文件 + 新建 `worker-persona.ts` / `worker-persona.test.ts` / `worker-profile.js` / 变更记录；
- `pnpm typecheck` 通过，上面四个测试文件通过；
- 报告：改了哪些文件、端点形状、默认正文最终文本、验证输出、没做/不确定的点；
- **不要 git add / commit / push**。
