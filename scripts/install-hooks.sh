#!/usr/bin/env bash
# 一键安装 git 钩子（2026-11-17）：把 core.hooksPath 指向仓库内版本化的 .githooks。
# 所有会话共用同一个 .git，装一次全覆盖；换 clone 后重新跑一次即可。
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
git config core.hooksPath .githooks
chmod +x .githooks/pre-commit
echo "git 钩子已安装：core.hooksPath=$(git config --get core.hooksPath)"
echo "提交前会跑契约形状快照；--no-verify 可跳过。详见 .githooks/pre-commit"
