# 任务书：批 9b——壳启动闪窗调查与修复（desktop/）
> 状态：已执行（任务书，2026-11-08）。落地明细见 docs/变更记录/ 同期批次记录；实施以代码为准，冲突以长期文档（接口文档.md / 系统架构.md）为准。


> 派单方：总管。执行人：CodeBuddy。日期：2026-11-08。仓库：lifediary-harness `desktop/`。
> 用户症状：打开壳时**经常**闪出一个窗口，几十毫秒级。"经常"而非"必现"——与"服务没在跑才 spawn"的条件吻合（壳是运行时唯一持有者：服务不在时启动 node、停止时 taskkill）。

## 主怀疑（按优先级调查）

1. **控制台子进程闪窗**：`runtime.go:179` `exec.Command("node", "--import", "tsx", "src/index.ts")`（node 是控制台程序，GUI 父进程下 Windows 给它新开控制台窗 → 闪）；`taskkill /T /F`（runtime.go:228）；`netstat`（pidOnPort）。全部 grep `exec.Command` 逐点列清单。
2. 次要怀疑：WebView2 主窗口先显示后加载的白闪（看 main.go 窗口 Show 时机与页面加载事件的先后；若是这种，修法不同——别混）。
3. 排除法证据：核对每个 exec 点的 `SysProcAttr` 现状（大概率全空）。

## 修法

- 建 `desktop/hidden-exec.go`（或并入现有 util）：`func startHidden(cmd *exec.Cmd) error` 统一挂 Windows `SysProcAttr{HideWindow: true, CreationFlags: 0x08000000 /*CREATE_NO_WINDOW*/}`（构建标签 `//go:build windows`；非 Windows 直接 Start）。
- **全部 exec 点改走它**（node 拉起、taskkill、netstat、任何现在或将来新增的）——grep 出的清单逐个过，一个不留。
- stdout/stderr 维持现状（不重定向；服务端错误已有 server-errors.log）。taskkill/netstat 的输出捕获逻辑不变。

## 验证（闪窗只有几十 ms，截图不可靠——按证据链验收）

1. `go vet ./... && go build ./...` 过。
2. grep 清单核对：报告里列**每一个** exec.Command 调用点（文件:行 + 是否已挂 hidden）——零遗漏。
3. 人工观感验证留给用户，但执行者做一次**可判定的代理验证**：写一个最小 Go 测试（或临时 main）验证 startHidden 启动 `cmd /c echo hi` 时无窗口句柄产出（`FindWindow` 扫描前后对比），能做就做，做不了如实说明改用代码审计口径。

## 铁律

不许 `git commit`；只碰 desktop/；`LIFEDIARY_SHELL_*` 行为不变；变更记录《2026-11-08-扫尾批9b（开窗闪窗修复）.md》。

## 汇报格式

1. exec 点全清单（文件:行、用途、是否挂 hidden）。
2. 主怀疑结论（是控制台闪窗还是 WebView 白闪还是别的——给证据）。
3. go vet/build 结果、代理验证结果（或如实说明做不了）。
4. 不确定点。
