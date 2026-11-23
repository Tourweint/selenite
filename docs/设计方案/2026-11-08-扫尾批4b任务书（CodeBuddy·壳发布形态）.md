# 任务书：扫尾批 4b——服务端单文件构建 · 壳构建脚本与版本号 · 开机自启
> 状态：已执行（任务书，2026-11-08）。落地明细见 docs/变更记录/ 同期批次记录；实施以代码为准，冲突以长期文档（接口文档.md / 系统架构.md）为准。


> 派单人：总管（ZCode）。执行人：CodeBuddy。日期：2026-11-08。
> 上位方案：`docs/设计方案/2026-11-08-扫尾批4方案（附件·编辑重发·壳发布）.md` §三（语义以它为准；SEA 与全局快捷键本批不做）。
> 范围：`ts/apps/server`（build 脚本）+ `desktop/`。不碰手机仓、不碰 web/ 前端逻辑（只复制资源）。

## 铁律

1. 不许 `git commit`；只改本任务书范围；**开发态零回归**——不装 dist 时 `tsx src/index.ts` 与全部探针行为一字不变。
2. 完成后跑：`pnpm typecheck`、`pnpm --filter @lifediary/server test`、`pnpm probe`、`go vet ./... && go build ./...`、你新增的 dist 冒烟。

## 前置事实（总管已侦察）

- 服务端：无任何 bundle 步骤（scripts 全是 `tsx`，devDeps 只有 tsx/typescript；esbuild 在传递依赖里）；源码 ESM + `.ts` 相对导入 + `import.meta.url`。
- 资源读盘三处：`web.ts:15`（`new URL("../web/", import.meta.url)`，每请求 readFile）、skills（agent.ts:444 `../skills`）、prompts（tasks.ts:22 `../prompts/`）；存储走 Node 内置 sqlite（无原生模块，对打包友好）。
- 壳：`go build -ldflags="-H windowsgui" -o lifediary-shell.exe .`（README:45）；`rsrc.syso` 已在（图标已嵌）；无版本变量；`runtime.go:179` spawn `node --import tsx src/index.ts`（cwd=serverDir()）；`serverDir()`（main.go:103）按 `LIFEDIARY_SERVER_DIR` → exe 旁 → 源码树顺序找 `src/index.ts`。
- mygo 现成：`App.SetOpenAtLogin(bool)`（login.go:36，Windows 实现=HKCU Run + StartupApproved）、`OpenAtLogin()`、`WasOpenedAtLogin()`。

## 逐项

### 1. 服务端 dist 构建（方案 §三a）

- `ts/apps/server/package.json` 加 `"build"`：esbuild 打 ESM bundle → `dist/index.js`（目标 node 当前版本、ESM、保持 `import.meta.url` 语义——esbuild 下它指向 bundle 文件位置）；`dist/` 里按相对位放 `web/`、`skills/`、`prompts/`（直接复制目录；`node_modules` 不复制——bundle 已含运行时代码，node:sqlite 是内置）。构建脚本放 `apps/server/scripts/build.mjs`（esbuild JS API，别引配置文件魔法）。
- **源码零改动**为硬要求：web.ts/skills/prompts 的 `import.meta.url` 解析在"源码态指向 `<server>/src/../web`、dist 态指向 `<server>/dist/../web`"两种布局下都必须成立（esbuild 输出 `dist/index.js`，资源放 `dist/web|skills|prompts` 即可满足 `../web/` 相对位——动手前画一遍相对路径确认，别改 `new URL()` 字符串）。
- 冒烟探针 `scripts/dist-probe.ts`（或并入 build 流程）：build → `node dist/index.js`（独立 PORT 与 `.data` 目录，env-before-import）→ `/healthz` ✓ → 建会话发一轮（faux）✓ → web 首页 200 ✓ → skills 可列出 ✓。加进 package.json script `dist:probe`。
- 回滚：不 build 就没有 dist，一切照旧；**不改动任何既有探针的启动方式**。

### 2. 壳构建脚本 + 版本号（§三b）

- `desktop/build.ps1`：`go build -ldflags "-H windowsgui -X main.version=<版本>" -o lifediary-shell.exe .`；版本取 `git describe --tags --always`（在 desktop 仓根执行失败时退 "dev"）。README 补一节"出 exe"。
- `main.go` 加 `var version = "dev"`（ldflags 注入）；托盘 tooltip 与设置→服务页既有版本展示处（有就带上，没有就在 tooltip 带 `Selenite <version>`）。**不加新 UI 面**。

### 3. 开机自启（§三c）

- 设置→服务页（运行时起停那张卡附近）加"开机自启"开关；壳侧已有 bindings 面就挂在 Shell 组：新 mygo 绑定 `SetOpenAtLogin(v)` + 状态读 `OpenAtLogin()`；页面开关经既有 Shell 绑定模式（参照运行时起停四态那张卡的接线）。
- 语义：开关只管壳（自启的是壳，服务由壳拉起）；`LIFEDIARY_SHELL_BINDINGS=off` 时该开关不渲染（与整组 Shell 同退）。
- 文档：接口文档/系统架构相应行注记（一行）；变更记录《2026-11-08-扫尾批4b（dist构建与壳发布形态）.md》。

## 明确不做

SEA、全局快捷键、WebView2 离线分发、CI、图标重生成、前端逻辑改动、改 spawn 方式（仍 `node --import tsx`；dist 的接入留给下一轮评估——**本批 dist 只要求"能起、能服务"**，壳还没切到 dist，别自作主张改 serverDir 查找顺序）。

## 汇报格式

1. 逐项：esbuild 配置要点（import.meta.url 怎么保真的、复制了哪些资源）、build.ps1 参数、自启接线（绑定点/开关落点）。
2. 验证原文：typecheck / 单测 / `pnpm probe` / dist:probe 关键行 / go vet+build / `node dist/index.js` 冒烟。
3. 文档回写清单。4. 不确定点。
