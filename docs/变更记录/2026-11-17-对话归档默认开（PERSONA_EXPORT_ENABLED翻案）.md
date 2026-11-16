# 2026-11-17 对话归档默认开（`PERSONA_EXPORT_ENABLED` 翻案）

## 改了什么

`PERSONA_EXPORT_ENABLED`（插件页「一生记忆库（对外）」分组 →「对话归档（送）」）从**默认关翻成默认开**：

1. `src/plugins.json`：`defaultValue` `"false"→"true"`，summary 与分组说明同步改口径；
2. `persona-export.ts` / `agent/settled.ts` 头注释里的旧默认口径同步修正；
3. `persona-export.test.ts` 两处断言、`flags.test.ts` 一处断言按新语义改（默认开，显式 `false`/`0`/`off` 才关）；
4. 当前实例经 `PUT /api/v1/agent/flags/PERSONA_EXPORT_ENABLED` 钉进 `.data/agent-flags.json`（value 与 defaultValue 都为 true）。

## 为什么（翻案声明）

2026-11-16 深夜用户在日记执事小记 v2（见 `2026-11-16-日记执事小记人设v2（生活线亲随）.md`）语境下拍板：
「这个肯定得开」——小记每天一问的答案要往一生的记忆库（voicevault）回流，这正是这条导出管存在的意义。
2026-11-16 独立插件页落地时「保持默认关」的理由（唯一会把数据往外送的开关，默认不动）被用户明确让位。

## 生效与验证

- `hot: true`，改 `plugins.json` 后在跑的服务经清单热装载当场生效：实测 2026-11-17 00:00 起主对话轮已在
  向 `.data/persona-export/2026-11.jsonl` 追加（UTF-8、JSON 可解析）。
- `pnpm typecheck` 绿；`persona-export.test.ts` + `flags.test.ts` 22/22 绿；测试用临时目录替身，
  全量套件未向真实 `.data/persona-export` 写入（已核对文件增长全部来自真实主对话）。
- 全量套件另有 5 处红（闸门完整性 / 只读闸门 / 工具注册顺序 / pin 变量名 / partner-work 整文件），
  均与本批无交集（工作区另有大量并行在途改动），未处理。

## 未解（留给用户拍板）→ 已拍板（2026-11-17）

**执事会话仍在过滤名单里**（2026-11-09 方案 D-丁：`task-` 专线 / 群会话 / 执事会话一律不导，
理由是执事的声音混进主人语料会串人格）。小记的会话是执事会话——每天一问的答案不经这条管流进记忆库。

**2026-11-17 用户拍板：维持不导。** 小记的记忆（每天一问的答案、用户后续补充）就落在
harness 自带记忆引擎（remember/recall，自有存储表），**不往大记忆库（voicevault）送**；
大记忆库那条豁免不做。`persona_recall` 保留只读（小记聊过去时查库，不写入）。
主对话导出管保持默认开，不受此拍板影响。

## 回滚

插件页「对话归档（送）」拨回关（写入 agent-flags.json，即时生效）；或 env 显式 `PERSONA_EXPORT_ENABLED=false`。
