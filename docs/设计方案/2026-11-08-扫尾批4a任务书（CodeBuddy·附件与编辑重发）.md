# 任务书：扫尾批 4a——附件上传 + 编辑重发

> 派单人：总管（ZCode）。执行人：CodeBuddy。日期：2026-11-08。
> 上位方案：`docs/设计方案/2026-11-08-扫尾批4方案（附件·编辑重发·壳发布）.md`（**语义以它为准**）。
> 范围：`ts/packages/shared` + `ts/apps/server`（src + web）+ 基线文档。不碰 desktop/、不碰手机仓。

## 铁律

1. 不许 `git commit`；只改本任务书范围；契约语义以方案为界（parts 形状、8MB/4 图、fork 语义、两个回滚开关，一条都别改）。
2. 完成后跑：`pnpm typecheck`、`pnpm --filter @lifediary/server test`、shared 契约快照测试、http 探针全量、你新增的探针场景。

## 前置事实（总管已侦察）

- shared：`ChatMessageSchema.content = z.string().min(1)` 在 `shared/src/index.ts:23`；`ChatRequestSchema` :54-78；`TranscriptMessageSchema` :114-127；SSE `ChatEvent` :234-350（delta/thinking 纯文本，**本批不动**）。
- 内核：`submit({type:"input", content})` 的 content 原生收 `string | (TextContent|ImageContent)[]`（pi-ai types.d.ts:363-367，ImageContent=`{type:"image",data,mimeType}` base64）；服务端提交点 `agent.ts:1987-1996`；自定义条目写法参考 `sayInChat`（agent.ts:2228）。
- 路由取文本：`index.ts:688-689` 倒序找最后一条 user 的 string content；chat 路由 :626。
- fork：`Conversation.fork(at, options, context)`（durable types.d.ts:705，复制新会话）；`context(at)` 语义同 fork 起点预览（:696-698）。
- 前端：附件占位 `web/index.html:317`（只弹 toast）；composer 提交与 `/compact` 斜杠拦截在 app.js 同一入口；`openConversation()` 是会话切换唯一入口。

## 逐项

### 1. shared 契约（方案 §一）

- `content` 改 union：`z.union([z.string().min(1), z.array(PartSchema).min(1)])`，Part = text|image（字段名/形状按方案，`.strict()` 风格与文件内既有 schema 一致）；导出 `ContentPart` 类型。旧 string 全兼容（契约快照测试同步更新）。
- `TranscriptMessageSchema` 加可选 `images: [{mimeType, data}]`。
- 接口文档 §2.2（chat 请求）与回读节同步改口径 + 标注 2026-11-08。

### 2. 服务端

- chat 路由与 chatStream：content 数组 → 文本 parts 拼接（多 text 用 `\n` 连）作为 `text`、图片 parts 组装为 pi-ai parts 一并 submit（`content: 有图 ? parts : text`）；`contentText` 等 string 收窄假设逐处核对。
- 限制：单图 base64 解码后 ≤8MB、≤4 图，超限 400 带说明；纯图无文本允许。
- 回滚 `AGENT_ATTACHMENTS=false`：parts 请求 400（文案指向文本），string 不受影响。
- 编辑重发端点 `POST /agent/chat/:conversationId/edit`（方案 §二）：校验（消息存在/是 user/会话不在跑——running 409）→ `fork` 到该条目之前 → 新会话提交新文本（走 chatStream 全链路）→ `202 {ok:true, conversationId}`。回滚 `AGENT_EDIT_RESEND=false` 端点 404。
- 两个开关进接口文档 §6 表。

### 3. 前端（web/）

- composer：附件按钮接真（选择器 + 粘贴图片 + 拖拽），缩略图预览/可移除；发送时组装 parts（有图才用数组形态）。
- 回读渲染：user 消息 `images` 缩略图 + 点击大图（纯 CSS/原生 lightbox，风格随现有对话流）。
- 编辑重发：最后一条 user 消息 hover「编辑」→ 行内输入框 → 提交 → 用返回的新 conversationId 走 `openConversation()` 无缝切换。`AGENT_*` 开关关闭时不渲染入口（policy 端点已有开关投影就跟着投影，没有就在 /policy 或单独投影口加——实现时选最小改法并汇报）。
- style.css 与现有对话流视觉一致，不引第三方库。

### 4. 探针 + 测试

- shared 契约快照更新（union 新形状）。
- 探针场景（挂现有合适探针或新文件，env-before-import）：①带一条 base64 小图（1×1 png）的消息全链路：受理→落库→回读带 `images`→（faux）正常回；②超 4 图 / 超 8MB → 400；③`AGENT_ATTACHMENTS=false` → parts 400、string 照常；④编辑重发：老会话完好保留、新会话 id 返回、新会话 transcript 首条 user 是新文本且分叉点之前的历史完整；⑤running 时 edit → 409；⑥`AGENT_EDIT_RESEND=false` → 404。
- 单测：server 侧 content 拼装纯函数、限制校验纯函数。

## 明确不做

不碰 desktop/ 与手机仓；不动 SSE 帧结构；不做 blob 存储；不做手机端附件；不做"从这条重开"纯 fork 入口；不做 readTranscript 分页化。

## 汇报格式

1. 逐项：schema 最终形状、端点行为与方案偏差（如有）、前端入口落点。
2. 验证原文：typecheck / 单测数 / http 探针关键行 / 新探针场景 ✓ 列表。
3. 文档回写清单（shared 注释、接口文档、变更记录《2026-11-08-扫尾批4a》）。
4. 不确定点 / 与方案冲突处（发现语义对不上就停下写明，别自行改契约）。
