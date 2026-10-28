# vendor/pi —— pi 的源码内嵌

这里是从 [`pi-mono`](https://github.com/earendil-works/pi) 复制进来的两个包：

| 目录 | 包名 | 作用 |
|---|---|---|
| `ai/` | `@earendil-works/pi-ai` | 统一多 provider LLM API（流式、工具调用、OAuth） |
| `agent/` | `@earendil-works/pi-agent-core` | Agent 循环、harness、上下文压缩、会话存储、技能 |

来源版本：**0.78.1**（`<reference>\pi-main`，MIT，作者 Mario Zechner）。

## 为什么是复制源码，而不是 `npm i`

参考 `oh-my-pi`（pi 最成熟的衍生项目）的做法：它把 pi 的全部包复制进自己的 monorepo、
改名为 `@oh-my-pi/*`、版本重编号（18.x），然后在上面加自己的模块（`mnemopi` 记忆、
`snapcompact` 压缩、`catalog`、`stats`…）。**它是改代码，不是上层扩展。**

我们采用同样的路线，但改动更保守：**先不改逻辑，只改分发方式**。

理由：
1. 个人 Agent 一定要动内核（记忆注入、工具集替换、权限闸门），只在外面套一层会被 pi 的假设卡住；
2. pi 上游自动关闭新贡献者的 PR，你改的东西永远进不了主干，只能自己维护；
3. 但全盘 fork 又要承担同步成本，所以用"最小改动"起步。

## 相对上游的唯一改动（升级时要重新施加）

1. `package.json` 的 `main` / `types` / `exports` 全部指向 `src/**`（上游指向 `dist/`）。
   目的是**免构建**：`tsx` 直接跑 TS 源码，省掉 tsgo 构建链路。
2. `agent/package.json` 里 `@earendil-works/pi-ai` 的依赖从 `^0.78.1` 改成 `workspace:*`，
   否则 pnpm 会去 registry 装一份，改的是 vendored 代码、跑的却是远端包。

除此之外**没有任何源码改动**。业务改动一律写在新包里（`packages/personal-*`），
通过适配层接到 pi 上——这样"上游 vs 我们的"边界永远清楚。

## 升级流程

```bash
# 1. 拉新版本源码，覆盖过来
# 2. 重新施加上面两条改动
# 3. pnpm -r typecheck + smoke
# 4. 看 pi 的 CHANGELOG 有无破坏性变更（当前 0.x，随时可能变）
```
