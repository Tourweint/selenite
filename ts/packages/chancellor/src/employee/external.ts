import { spawn } from "node:child_process";
import process from "node:process";
import { CODEBUDDY_BIN, QODER_BIN, QODER_CN_BIN } from "../config.ts";
import { resolveCodeBuddyLauncher } from "./codebuddy.ts";
import { killTree } from "./kill.ts";
import { resolveQoderBinary } from "./qoder.ts";

/**
 * 三个外部执行档位的健康检查与选择顺序（方案 §5.6）。
 *
 * 顺序是定稿：CodeBuddy → Qoder 国际版 → Qoder CN。
 * 启动时各跑一次 `--version`，结果缓存；不可用的档位不参与选择。
 * 负责人按任务改档位是后续拆单层的事，这里只提供"按顺序挑第一个可用"。
 */
export const EXTERNAL_CLI_ORDER = [
  "codebuddy",
  "qoder-intl",
  "qoder-cn",
] as const;

export type ExternalCliName = (typeof EXTERNAL_CLI_ORDER)[number];

export interface ExternalCliStatus {
  ok: boolean;
  detail: string;
}

const cache = new Map<ExternalCliName, Promise<ExternalCliStatus>>();

/** 进程级缓存：同一档位只探一次，避免每张单都起三个进程。 */
export function preflightExternalCli(
  name: ExternalCliName,
): Promise<ExternalCliStatus> {
  const cached = cache.get(name);
  if (cached) return cached;
  const pending = probe(name).catch((error: unknown) => ({
    ok: false,
    detail: error instanceof Error ? error.message : String(error),
  }));
  cache.set(name, pending);
  return pending;
}

/** 按定稿顺序挑第一个可用档位；全部不可用返回 null。 */
export async function selectExternalCli(
  order: readonly ExternalCliName[] = EXTERNAL_CLI_ORDER,
  probe: (name: ExternalCliName) => Promise<ExternalCliStatus> = preflightExternalCli,
): Promise<ExternalCliName | null> {
  for (const name of order) {
    const status = await probe(name);
    if (status.ok) return name;
  }
  return null;
}

async function probe(name: ExternalCliName): Promise<ExternalCliStatus> {
  const launcher =
    name === "codebuddy"
      ? resolveCodeBuddyLauncher(CODEBUDDY_BIN)
      : {
          command: resolveQoderBinary(name === "qoder-cn" ? QODER_CN_BIN : QODER_BIN),
          prefixArgs: [] as string[],
        };

  const { code, stdout, stderr } = await runVersion(launcher.command, [
    ...launcher.prefixArgs,
    "--version",
  ]);
  const text = firstLine(stdout) || firstLine(stderr);
  return {
    ok: code === 0 && text !== "",
    detail: text || `退出码 ${code === null ? "null" : code}`,
  };
}

function runVersion(
  command: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout, stderr });
    };

    let child;
    try {
      child = spawn(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: process.env,
      });
    } catch {
      finish(null);
      return;
    }

    const timer = setTimeout(() => {
      killTree(child);
      finish(null);
    }, 15_000);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code);
    });
  });
}

function firstLine(text: string): string {
  return text.replace(/\r/g, "").split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}
