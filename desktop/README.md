# desktop —— lifediary 桌面壳

**壳不是宿主，是客户端。** 它只做两件事：确认服务在跑、把服务给的界面显示出来。
Agent、记忆、会话全在 `../ts/apps/server`（Node，`:39847`），这里不碰业务。

方案见 `../docs/设计方案/2026-11-03-桌面壳（MyGo）.md`。

## 现在是什么阶段

**P0**：窗口加载 `http://127.0.0.1:39847/`（服务自带的调试页），验证 WebView2 里能跑通。
前端还没内嵌，`mygo.config.ts` 也还没建——那些是 P1/P3。

已经就位的：

- 单实例（再启动一次会唤出已有窗口）
- 托盘：显示窗口 / 重新连接 / 退出
- **关窗 = 隐藏**，服务不停（手机还要连、提醒还要跑）
- 服务没起来时给一页说明，而不是 WebView 的默认错误页

## 前置

| | |
|---|---|
| Go | **1.27.3+**（MyGo v0.7.3 的 `go.mod` 硬要求，不是建议版本） |
| WebView2 | Windows 11 自带；Win10 需要装运行时 |
| 服务 | `cd ../ts && pnpm dev` |

国内拉不到 `proxy.golang.org`，先设代理：

```powershell
$env:GOPROXY='https://goproxy.cn,direct'
```

## 跑

```powershell
# 先把服务起来
cd ../ts; pnpm dev

# 再开壳
cd ../desktop
go run .
```

## 出 exe

```powershell
cd desktop
powershell -ExecutionPolicy Bypass -File .\build.ps1
```

脚本等价于：

```powershell
go build -ldflags="-H windowsgui -X main.version=$(git describe --tags --always)" -o lifediary-shell.exe .
```

`-H windowsgui` 不能省：不加的话它是控制台程序，双击会先弹一个黑框
（那正是"桌面上冒出个 node 进程"的来源）。加上之后是 GUI 子系统，双击直接出窗口。

版本号注入到托盘 tooltip（`Selenite <version> — 服务状态`）；`go run .` / 手工
`go build` 没有注入时是 `dev`。图标已由 `rsrc.syso` 嵌入，构建不重生成。

服务不用手动起：壳探不到 `/healthz` 会用隐藏进程把它拉起来，无控制台窗口。
设置 → 服务 → 运行时那张卡的「开机自启」开关写 HKCU Run（由 MyGo 维护，任务管理器
的「启动」页可关掉）；它只管壳，服务仍由壳拉起。

服务不在默认端口时：

```powershell
$env:LIFEDIARY_BASE_URL='http://127.0.0.1:9000'
```

## 已验证

- `go vet` / `go build` 通过，exe 约 13.5 MB
- 启动后 WebView2 子进程正常派生，窗口标题变成服务的页面标题（说明页面真的加载了服务，不是兜底页）
- 空闲内存约 79 MB（含 WebView2 进程组）

## 下一步

P1 把 `ts/apps/server/src/debug-page.ts` 换成一个真前端（Vite + `dist/` 由 `mygo.config.ts` 内嵌），
数据层收敛到唯一的 `src/api.ts`，走 HTTP + SSE，与浏览器共用同一份代码。
