# TS 侧大文件拆分：session / projects / partners / lifecycle / delegation

> 后端五个 >1000 行的 TS 文件按声明边界整段切成 1–6 个分区，入口文件退成纯 re-export；其余超限文件逐个写清"为什么切不开"。

## 结论

| 文件 | 拆前 | 拆后 |
|---|---|---|
| `src/agent/session.ts` | 2457 行 | 17 行纯桶 + 6 个分区（174 / 344 / 399 / 438 / 536 / 223 行） |
| `src/projects.ts` | 1650 行 | 10 行纯桶 + 4 个分区（96 / 292 / 408 / 820 行） |
| `src/partners.ts` | 1585 行 | 10 行纯桶 + 5 个分区（42 / 61 / 172 / 185 / 1071 行） |
| `src/agent/lifecycle.ts` | 1360 行 | 7 行纯桶 + 2 个分区（940 / 167 行） |
| `src/delegation-api.ts` | 1243 行 | 13 行纯桶 + 6 个分区（80 / 103 / 121 / 205 / 261 / 428 行） |
| `packages/shared/src/index.ts` | 1335 行 | **没拆**（见下"被守卫拦下的那一个"） |

对外导入路径全部不变：入口文件保留原名、只做 `export … from "./分区"`。

## 切法（一条规则）

**保持原文件的声明顺序，按连续行区间整段搬**，不做"按主题重组"。理由与 CSS 那轮相同：顺序一动，esm 求值顺序、模块级状态初始化顺序就跟着变，`tsc` 一点都看不出来，只有运行时才炸。

具体做法由 `ts-partition2.js`（工具目录，不在仓库里）执行，四道断言任何一道不过就直接退出：

1. **不许跨边界**：某条顶层声明起止跨了两个分区 → 报行号，改边界。（session 撞过一次 L1180–1186，delegation 撞过一次 L339–366。）
2. **const 依赖不许成环**：函数声明是提升的，跨分区互相调用安全；`const`/`class` 一旦成环就是求值期 TDZ。shared 那轮正是靠它抓到 `chat-events ↔ relay-schemas` 一处环。
3. **模块级 `let` 不许跨分区赋值**：esm 导入绑定只读，`import { x } from …; x = 1` 直接编译不过。这条把 lifecycle 和 provider 的边界钉死了（见下）。
4. **目标文件不许已存在**：踩过一次——分区名 `session-search.ts` 撞上仓库里已有的真模块，把人家的文件覆盖了；现在同名就拒绝写。

另外两个导入处理的坑，已修在脚本里：

- 原文件已 `export` 的声明不能再补一遍 `export {}`（`Cannot redeclare`）。只对**原本没 export** 的私有声明补。
- `import fs from "node:fs"` 这类默认导入必须按原形态重建，第一版拼成了 `import { fs }`，`tsc` 立刻报 `no exported member 'fs'`。

## 被守卫拦下的那一个：shared 契约包

`packages/shared/src/index.ts` 确实拆成功过（7 个分区，入口 23 行纯桶，`tsc` 与快照测试都绿），但 `apps/server/src/arch-guard.test.ts` 里有一条硬断言：

> 依赖方向：shared 契约单文件不许有相对 / @lifediary 导入

这条不是随手写的——文件头注释写明"服务端用 tsx、App 用 Metro，两边对相对导入的扩展名解析规则不完全一致，单文件最不容易出岔子"。拆开就意味着一堆包内相对导入要过 Metro，风险落在最不该出事的那一端（手机端启动）。

所以**已回滚**，`index.ts` 回到 1335 行的单文件；原提交用 `git checkout` 还原、8 个分区文件删除。这 1335 行是全仓库唯一"超 1000 行但不该拆"的文件，判据是仓库自己的守卫测试，不是我的取舍。

顺带：`failure-streak.test.ts` 也有一条读源码的接线守卫，断言 `lifecycle.ts` 里 `tool-error` / `timeout` / `rejected` 三处真的接上了。拆分后这些代码在 `lifecycle-harness.ts`，已把断言改指到新文件，并注明拆分日期与原因——守卫生效，指向更新。

## 为什么 lifecycle 只切成 2 份（940 行）

`lifecycle.ts` 的模块级可变状态（`opening` / `opened` / `closing` / `lifediaryExt` / `researchExt`）被三拨人写：`openHarness`（装配）、维护窗口（`beginHarnessMaintenance` / `endHarnessMaintenance`）、关闭路径（`closeHarnessForMaintenance` / `abortRun`）。这些函数分散在文件首、中、尾。

`lifediaryExt` / `researchExt` 还是**对外导出的活绑定**（`session-open.ts` 直接 `import { lifediaryExt }` 判空）。收拢成对象属性就要改外部读点，属于行为级改动。

结果：从文件首到 `openHarness` 结束这一大段只能整段留在一起（940 行），把不碰这些状态的"思考档与回话"（167 行）切出去。940 行超 500 软上限，在 1000 硬上限内。

## 明细

| 分区 | 内容 |
|---|---|
| `session-open.ts` | 聊天模式 / 压缩启停 / 模型同步 / 开聊 / 会话类型 / 编辑分叉 |
| `session-stream.ts` | `ChatStreamEvent` / `ChatStreamInput` / `chatStream` / `stopChat`（单函数 349 行，未拆内部） |
| `session-transcript.ts` | 续写 / 转写折叠 / 用量统计 / 提醒 |
| `session-meta.ts` | 索引条目 / `ChatMeta` 读写 / 改名 / 归档护栏 / 孤儿清理 |
| `session-index.ts` | 标题 / 项目归属 / 记忆视图 / 统计 / 列表与导出 |
| `session-evidence.ts` | 归档列表 / 检索 / 证据命中（名字避开仓库已有的 `session-search.ts`） |
| `project-types.ts` | 常量 / 类型 / 路径比较与根目录校验 |
| `project-rows.ts` | 行映射（VCS 探测、提案与根目录行转换） |
| `project-store.ts` | `ProjectsStore`（820 行单类） |
| `project-api.ts` | 单例 / 默认工作区 / 根目录解析 / 错误映射 / 端点挂载 |
| `partner-contract.ts` | 契约开关 / 契约小节与默认决策 / 库路径 |
| `partner-types.ts` | 行类型（伙伴 / 版本 / 会话挂接 / 例行 / 群） |
| `partner-store.ts` | `PartnersStore`（1071 行单类） |
| `partner-rows.ts` | 解析与映射（人格 / 作用域 / 行转对象） |
| `partner-api.ts` | 派活主控权限 / 领域身份 / 人格种子 |
| `lifecycle-harness.ts` | harness 开闭缓存 / 维护窗口 / 伙伴中继 / `openHarness` / 生命周期小节 |
| `lifecycle-thinking.ts` | 粘滞思考档 / 工具触发切换 / 会话内发言 / 派活回报 |
| `delegation-gates.ts` | 取消与群发开关 / 票据门 / 门位投影 |
| `delegation-checks.ts` | 验收检查（前缀正则 / 状态 / 投影） |
| `delegation-jobs.ts` | 票据后台任务 / 取消投影 / 死信库 |
| `delegation-summary.ts` | 票据摘要（会话映射 / 标题 / 主伙伴名 / 群发汇总） |
| `delegation-mount.ts` | `mountDelegationApi`（428 行） |
| `delegation-actions.ts` | 取消与重试 / 重试运行时 / 在飞票据判定 |

## 验证

| 项 | 结果 |
|---|---|
| `apps/server` `tsc --noEmit` | 每步 0 错（拆分前基线也是 0 错） |
| `src/*.test.ts` + `src/agent/*.test.ts` | 851 个用例，841 过 / 3 红 / 6 cancelled / 1 skip |
| 其中两处红 | `arch-guard`（shared 单文件断言，已回滚修好）、`failure-streak`（源码守卫指向旧文件，已改指） |
| 6 个 cancelled | 全在 `bash-background.test.ts`，报 `Promise resolution is still pending but the event loop has already resolved`；该测试起真实子进程，在 Windows + tsx 下会提前收尾，与本次拆分无关（它不 import 任何被拆的文件） |
| 分领域复跑 | `src/agent` 67/67；projects 相关 58/58；partners 相关 228/228；delegation 相关 288/288 |

`tsc` 抓不到运行时 TDZ 与循环导入，所以每个文件拆完都在真运行时跑过对应测试集，不只看类型。

## 还没拆的（逐个写理由，不是没看）

| 文件 | 行数 | 为什么没拆 |
|---|---|---|
| `apps/server/scripts/http-probe.ts` | 3769 | 探测脚本，48 条顶层语句里 7 条是无名表达式语句（按顺序发请求、打印）。拆开等于把执行顺序交给导入图，得先重构成"main 函数"才能切 |
| `apps/server/src/index.ts` | 2226 | 83 条顶层 `app.get/post(...)` 注册。Hono 按注册顺序匹配路由，重排会静默改变哪条路由先命中；要拆必须把每组路由包成 `registerXxx()` 并按原顺序调用，属行为级重构 |
| `apps/server/src/provider.ts` | 1927 | 模块级 `let`（`document` / `revision` / `builtRevision` / `warnedSignature` / `singleton` …）被 5 个簇共同写（构建、探测、任务、保存各写一部分）。纯搬迁必过不了"跨分区写 let"这道断言 |
| `apps/server/src/tools.ts` | 1926 | 主体是**单个 1455 行函数**（`createTools` 那一段），没有声明边界可切；剩下 471 行也不够拆。拆它只能动函数内部 |
| `packages/memory/scripts/selftest.ts` | 1649 | 自检脚本，138 条顶层语句里 90 条是无名表达式（一路断言下去），顺序即语义 |
| `packages/shared/src/index.ts` | 1335 | 仓库守卫明确规定必须单文件（见上一节） |
| `apps/server/scripts/sidebar-probe.ts` | 1262 | 同 http-probe，脚本流程顺序敏感 |
| `apps/server/src/partner-store.ts` | 1071 | `PartnersStore` 单个类的本体，方法全吃 `this.db`；拆出方法要连调用点一起改 |
| `apps/server/scripts/approval-probe.ts` | 1029 | 同上，脚本 |

超过 500 但没超 1000 的还有：`project-store.ts`（820）、`lifecycle-harness.ts`（940）、`partner-store.ts`（1071 已列）、以及一批 500–900 行的 `src/*.ts`（`export-bundle.ts` 900、`delegation.ts` 896、`routines.ts` 886、`companion-api.ts` 840、`partner-runtime.ts` 782、`memory-consolidate.ts` 758、`memory/src/store.ts` 724 等）——这些都还在原文件里，下一步可以按同一套流程处理。

## 已知取舍

- **单类不拆**：`ProjectsStore`（820）、`PartnersStore`（1071）保留整类。方法内聚在 `this` 上，拆成自由函数要连调用点一起改，风险远大于收益。
- **单函数不拆**：`chatStream`（349）、`openHarness`（523）、`mountDelegationApi`（428）、`createTools` 段（1455）都没动内部。
- **模块级状态没重构**：`provider.ts`、`lifecycle.ts` 的状态本该收进一个 state 对象，那是行为级改动，本轮不做。
- **顶层流程语句敏感**：所有 probe/selftest 脚本按顺序执行，未拆。

## 回滚

每个文件一个独立提交，`git revert` 对应提交即可回到拆前状态；分区文件随之删除，外部导入路径没变，不需要同步改调用方。
