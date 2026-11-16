# 派活清单补全：CodeBuddy 并历史记录、新增手动补刀文件、清单每日缓存

**日期**：2026-11-17
**范围**：`ts/apps/server/src/executor-probe.ts`、`src/executor-mount.ts`（节流）、`.data/executor-models.json`（新）、接口文档 §2.23.1
**背景**：用户口径——常用的是 CodeBuddy 和 Qoder，这两个的模型清单拉不全（Codex / OpenCode /
Claude Code 后期用到了再修，本批不动）；清单**没必要每次点都真拉**，用缓存、每天拉一次就行。

## 探查结论（2026-11-17 实测）

- **CodeBuddy**：`--help` 的 supported 列表只有 19 个，但本机会话历史（`~/.codebuddy/projects`
  的 jsonl）里真实用过 7 个 help 没有的名字（hy4 / hy4-free / hy4free / hy4-preview /
  hy4-flash / hy4-flash-free）——**help 清单滞后于后端**。没有 models 子命令
  （`codebuddy models` 被当成提示词吞掉）。
- **Qoder**：`qodercli --list-models`（国际 17 / 国内 14）就是「当前账号的全部」：
  ①IDE 的完整目录缓存在 `AppData/Roaming/Qoder/User/globalStorage/state.vscdb` 能读到明文，
  但只有 14 个内部 id 且**加密的 `~/.qoder/.models/<uid>/catalog-v7` 读不出**；
  ②内部 modelId（dfmodel 等）CLI 不收——`-m dfmodel` 真调实测 **exit 42**；
  ③无其它明文缓存。三路都堵死，CLI 清单即全量。

## 改了什么

1. **CodeBuddy 清单三路合并**：help 列表（19）∪ 本机历史真用过的模型（限量流式扫：
   按 mtime 新到旧、每件只读头部 256KB、上限 40 件 / 12MB、进程内缓存一次——projects 目录
   229MB 不能全读）∪ 手动补刀。实测 19 → **25**（历史扫到 4 个 + 补刀 2 个更深的旧名
   hy4-preview / hy4free）。旧名不保证还能用，消息里写明「旧名可能已改版」，
   「检测」按钮就是干这个的。
2. **手动补刀文件** `.data/executor-models.json`：`{"<kind>": ["模型名", ...]}`，并入清单
   （去重、≤200 条）。这是 CLI 报不全、用户在 IDE 里看得到名字时的通用出口，对所有
   外部执行器生效；文件坏了 / 不存在就当没有。
3. **Qoder 不加假数据**：清单保持 CLI 输出原样（排序去重），消息改为如实说明
   「qodercli --list-models 报的全部」；缺的名字走补刀文件。
4. **清单缓存**（2026-11-17 续，用户口径：模型目录一天变不了两次，没必要每次点都真拉）：
   `.data/executor-model-cache.json` 按 kind 缓存，**24 小时内直接回缓存**——实测第二次
   调用 2610ms → **1ms**；过期后首次点击才真拉一次并落盘；只缓存 ok 且非空的结果
   （CLI 没装 / 失败不缓存，下次重试）。补刀文件**不进缓存**，改了立即生效（缓存命中
   也现拼）。缓存命中不占 3 秒节流（`probeNeedsThrottle` 先判，连点不再 429）；
   响应多一个 `cached: true` 字段，message 附「缓存于 X 前，每天最多真拉一次」。
   `EXECUTOR_MODEL_CACHE=false/0/off` 退回每次真拉。

## 验证

- 真跑：CodeBuddy 25 个（19 help + 4 历史 + 2 手动）、Qoder 国际 17 / 国内 14（原样）。
- 缓存：删缓存文件首拉 2610ms（cached=false），第二次 **1ms**（cached=true、消息带
  「缓存于 X 前」）；缓存命中期间改补刀文件 → 下一次点击立即生效（25→26 实测）。
- typecheck 全绿；executor 链路单测 28/28 绿。

## 回滚

- 清单缓存：`EXECUTOR_MODEL_CACHE=false/0/off` 一行退回每次真拉（或删缓存文件）。
- 其余：`git checkout` executor-probe.ts / executor-mount.ts 即回 help-only 形态；补刀文件删掉即失效。

## 刻意不做

- **不真调验证历史旧名**：CodeBuddy 免费档边界是「必须带 Flash」，旧名可能路由到付费档
  （用户警告过），不拿真金白银试；清单只登记，「检测」是显式人工动作。
- **不给 Qoder 加猜的名字**：三个本地来源都堵死，编名单=造假；补刀文件交给用户登记。
