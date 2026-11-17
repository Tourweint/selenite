# @lifediary/chancellor

派活侧执行器模块：`delegate` 工具的落点——拆单、派工、外雇执行器（native / Qoder /
CodeBuddy / Claude Code / Codex / OpenCode）、验收裁判、工单存储与回执。

2026-11-18 从独立私有仓 vendor 进本仓（开源拍板：只发一个仓库）。`apps/server`
静态 import 本包；`CHANCELLOR_ENABLED=false` 时 delegate / propose_project 不上架
（回滚开关不是功能开关）。

注意：

- 本包不 import harness 任何实现（依赖单向：`shared` ← `memory` ← `server` → 本包）。
- 外部执行器二进制路径一律走 env（`CHANCELLOR_QODER_BIN` 等），不写死本机路径。
- 旧私有仓 `<chancellor>` 封存为参考，开发在本包进行。
