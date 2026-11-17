/**
 * worker 人设注入口（2026-11-16 通用 worker 配置统一 批2）。
 *
 * 宿主（harness 服务端）装配时推一份人设来源进来，chancellor 只消费、不读宿主的文件
 * （依赖方向：server 推、chancellor 收，同 `setInternalAsk` 先例）。
 * 来源未注入 / 读抛错 / 空串 → TASK.md 不出「你是谁」段，绝不阻塞派活。
 * 宿主侧回滚：`WORKER_PERSONA_DISPATCH=false` 时宿主注入 null，行为回到无身份的纯 TASK.md。
 */

export type WorkerPersonaSource = () => string;

let source: WorkerPersonaSource | null = null;

export function setWorkerPersonaSource(fn: WorkerPersonaSource | null): void {
  source = fn;
}

/** 每张 TASK.md 现取一次（宿主每轮现读文件，改完下一单生效）；异常吞掉返回空串。 */
export function workerPersonaText(): string {
  if (!source) return "";
  try {
    return (source() ?? "").trim();
  } catch {
    return "";
  }
}
