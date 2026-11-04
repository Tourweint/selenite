# 跨平台两处小修（engines 收紧 + adb 兜底去机器化）

日期：2026-11-05
类型：小修（免方案；背景是 2026-11-05 的 Linux/macOS 可用性盘点）

## 缘起

盘点"中继落地后把 harness 搬 Linux/macOS"的可行性（结论已登记
`系统架构.md` §7 中继条目），发现两处一行级暗坑：

1. `ts/package.json` 的 `engines.node` 写 `>=20`，但全仓 SQLite（会话 / 记忆 /
   项目 / 日记 / 回执库）都走 Node 内置 `node:sqlite`，实际需要 **Node ≥22.13**
   （无 flag 可用的首个版本）。新机器照声明装 Node 20 会启动即崩且报错不显眼。
2. `src/worker-shell.ts` 的 adb 兜底路径写死 `C:/Users/<user>/...adb.exe` ——
   src 里唯一的机器特定路径。`ADB_PATH` 本就优先，坏的只是兜底值。

## 改动

- `ts/package.json`：`engines.node` `>=20` → `>=22.13`。
- `src/worker-shell.ts`：删机器特定常量 `DEFAULT_ADB_PATH`，换成
  `defaultAdbPath(env)` —— win32 猜 `%LOCALAPPDATA%/Android/Sdk/platform-tools/adb.exe`
  （Android Studio 默认位，不写死用户名），POSIX 交给 PATH 上的 `adb`；
  都找不到时仍是现有 `adb_unavailable` 语义（worker 不跑，不炸服务）。
- `接口文档.md` §6：补 `ADB_PATH` / `ADB_SERIAL` 两行（此前 env 表漏登）。

## 刻意不改

- chancellor 跨仓相对 import（搬家的真正断点）不动——收编成 workspace 包
  属独立小立项，等真搬家时再做。
- powershell 工具、qoder/codebuddy 雇员的 .exe 依赖不动（可选功能，新平台按需装）。

## 验证

- `pnpm typecheck`
- `pnpm --filter @lifediary/server test`（含 worker-shell.test.ts；测试全部显式传
  `ADB_PATH`，不依赖兜底值）
