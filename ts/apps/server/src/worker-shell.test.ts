import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { Hono } from "hono";
import { createAuthMiddleware } from "./auth.ts";
import {
  executeAdbShell,
  mountWorkerShell,
  validateAdbShellArgv,
  type SpawnFn,
} from "./worker-shell.ts";

const TOKEN = "test-token";
const ADB = "C:/fake/adb.exe";

class FakeStream extends EventEmitter {
  setEncoding(): this {
    return this;
  }
}

class FakeChild extends EventEmitter {
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  killed: NodeJS.Signals | null = null;
  kill(signal: NodeJS.Signals): boolean {
    this.killed = signal;
    queueMicrotask(() => this.emit("close", null, signal));
    return true;
  }
}

interface ScriptedOutcome {
  stdout?: string;
  stderr?: string;
  code?: number;
  hang?: boolean;
  spawnError?: Error;
}

function scriptedSpawn(
  script: (args: string[], call: number) => ScriptedOutcome,
): { spawnFn: SpawnFn; calls: string[][]; children: FakeChild[] } {
  const calls: string[][] = [];
  const children: FakeChild[] = [];
  const spawnFn = ((command: string, args: string[]) => {
    calls.push([command, ...args]);
    const child = new FakeChild();
    children.push(child);
    const outcome = script(args, calls.length - 1);
    setImmediate(() => {
      if (outcome.spawnError) {
        child.emit("error", outcome.spawnError);
        return;
      }
      if (outcome.hang) return;
      if (outcome.stdout) child.stdout.emit("data", outcome.stdout);
      if (outcome.stderr) child.stderr.emit("data", outcome.stderr);
      child.emit("close", outcome.code ?? 0, null);
    });
    return child;
  }) as unknown as SpawnFn;
  return { spawnFn, calls, children };
}

function buildApp(options: { env: NodeJS.ProcessEnv; spawnFn: SpawnFn; timeoutMs?: number }) {
  const app = new Hono();
  app.use("/api/v1/*", createAuthMiddleware(TOKEN));
  mountWorkerShell(app, options);
  return app;
}

function shellRequest(app: Hono, argv: unknown, token: string | null = TOKEN) {
  return app.request("/api/v1/worker/shell", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ argv }),
  });
}

// ── 白名单 ────────────────────────────────────────────────────────────

test("允许四种形状", () => {
  const accepted = [
    ["am", "start", "--display", "0", "-n", "com.android.settings/.Settings"],
    ["am", "start", "--display", "2", "-n", "com.android.settings/.Settings", "-W"],
    ["am", "force-stop", "com.android.settings"],
    ["input", "-d", "0", "tap", "540", "1200"],
    ["input", "-d", "2", "swipe", "10", "20", "30", "40"],
    ["input", "-d", "2", "swipe", "10", "20", "30", "40", "500"],
  ];
  for (const argv of accepted) {
    assert.deepEqual(validateAdbShellArgv(argv), { ok: true, argv });
  }
});

test("拒绝不在白名单的命令", () => {
  for (const argv of [
    ["ls", "/"],
    ["sh", "-c", "id"],
    ["adb", "shell", "id"],
    ["pm", "list", "packages"],
  ]) {
    assert.equal(validateAdbShellArgv(argv).ok, false, JSON.stringify(argv));
  }
});

test("拒绝缺 --display 的 am start", () => {
  const result = validateAdbShellArgv(["am", "start", "-n", "com.x/.Y"]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /--display/);
});

test("拒绝 shell 元字符与路径", () => {
  const cases = [
    ["am", "start", "--display", "0", "-n", "com.x/.Y;rm -rf /"],
    ["am", "start", "--display", "0", "-n", "com.x/.Y && id"],
    ["am", "start", "--display", "0", "-n", "com.x/.Y|id"],
    ["am", "start", "--display", "0", "-n", "com.x/$(id)"],
    ["am", "start", "--display", "0", "-n", "com.x/`id`"],
    ["am", "start", "--display", "0", "-n", "/bin/sh"],
    ["am", "force-stop", "../../data"],
    ["input", "-d", "0", "tap", "/", "1"],
    ["am", "start", "--display", "0", "-n", "com.x/.Y", "."],
    ["am", "start", "--display", "0", "-n", "com.x/.Y", "C:/Windows/system32"],
  ];
  for (const argv of cases) {
    assert.equal(validateAdbShellArgv(argv).ok, false, JSON.stringify(argv));
  }
});

test("拒绝参数数量异常与非法数字", () => {
  const cases = [
    ["input", "-d", "0", "tap", "1"],
    ["input", "-d", "0", "tap", "1", "2", "3"],
    ["input", "-d", "0", "swipe", "1", "2", "3"],
    ["input", "-d", "0", "swipe", "a", "2", "3", "4"],
    ["input", "-d", "0", "swipe", "1", "2", "3", "4", "999999"],
    ["input", "-d", "0", "keyevent", "4"],
    ["input", "tap", "1", "2"],
    ["am", "force-stop", "com.x", "com.y"],
    ["am", "start", "--display", "0", "--display", "1", "-n", "com.x/.Y"],
    ["am", "start", "--display", "0", "-n", "com.x/.Y", "--display=1"],
    ["am", "start", "--display", "0"],
  ];
  for (const argv of cases) {
    assert.equal(validateAdbShellArgv(argv).ok, false, JSON.stringify(argv));
  }
});

test("拒绝非数组 / 非字符串 / 超长", () => {
  assert.equal(validateAdbShellArgv(null).ok, false);
  assert.equal(validateAdbShellArgv("am start").ok, false);
  assert.equal(validateAdbShellArgv([1, 2]).ok, false);
  assert.equal(validateAdbShellArgv([]).ok, false);
  assert.equal(validateAdbShellArgv(["input", "-d", "0", "tap", "1", "2", "x"]).ok, false);
});

// ── 执行 ──────────────────────────────────────────────────────────────

test("执行时直接传 argv，并带上 -s <serial> shell", async () => {
  const { spawnFn, calls } = scriptedSpawn(() => ({ stdout: "Starting: Intent\n" }));
  const result = await executeAdbShell(
    ["am", "start", "--display", "0", "-n", "com.android.settings/.Settings"],
    { env: { ADB_PATH: ADB, ADB_SERIAL: "SERIAL" }, spawnFn },
  );

  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "Starting: Intent\n");
  assert.deepEqual(calls, [
    [
      ADB,
      "-s",
      "SERIAL",
      "shell",
      "am",
      "start",
      "--display",
      "0",
      "-n",
      "com.android.settings/.Settings",
    ],
  ]);
});

test("没配 ADB_SERIAL 时用 devices 里唯一那台", async () => {
  const { spawnFn, calls } = scriptedSpawn((args) =>
    args[0] === "devices"
      ? { stdout: "List of devices attached\nONLY-ONE\tdevice product:x\n\n" }
      : { stdout: "tapped" },
  );
  const result = await executeAdbShell(["input", "-d", "0", "tap", "540", "1200"], {
    env: { ADB_PATH: ADB },
    spawnFn,
  });

  assert.equal(result.ok, true);
  assert.equal(result.serial, "ONLY-ONE");
  assert.deepEqual(calls[0], [ADB, "devices"]);
  assert.deepEqual(calls[1], [ADB, "-s", "ONLY-ONE", "shell", "input", "-d", "0", "tap", "540", "1200"]);
});

test("多台设备时报错，不猜也不执行", async () => {
  const { spawnFn, calls } = scriptedSpawn(() => ({
    stdout: "List of devices attached\nAAA\tdevice\nBBB\tdevice\n",
  }));
  const result = await executeAdbShell(["am", "force-stop", "com.x"], {
    env: { ADB_PATH: ADB },
    spawnFn,
  });

  assert.equal(result.ok, false);
  assert.equal(result.setupError?.reason, "multiple_devices");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [ADB, "devices"]);
});

test("daemon 掉了：失败一次后 start-server 再重试", async () => {
  let shellCalls = 0;
  const { spawnFn, calls } = scriptedSpawn((args) => {
    if (args[0] === "start-server") return { stdout: "daemon started\n" };
    shellCalls += 1;
    if (shellCalls === 1) return { stderr: "error: device offline", code: 1 };
    return { stdout: "ok" };
  });

  const result = await executeAdbShell(["input", "-d", "0", "tap", "1", "2"], {
    env: { ADB_PATH: ADB, ADB_SERIAL: "SERIAL" },
    spawnFn,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    calls.map((call) => call.slice(1)),
    [
      ["-s", "SERIAL", "shell", "input", "-d", "0", "tap", "1", "2"],
      ["start-server"],
      ["-s", "SERIAL", "shell", "input", "-d", "0", "tap", "1", "2"],
    ],
  );
});

test("超时就杀子进程", async () => {
  const { spawnFn, children } = scriptedSpawn(() => ({ hang: true }));
  const startedAt = Date.now();
  const result = await executeAdbShell(["input", "-d", "0", "swipe", "1", "2", "3", "4", "60000"], {
    env: { ADB_PATH: ADB, ADB_SERIAL: "SERIAL" },
    spawnFn,
    timeoutMs: 40,
  });

  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(children[0]?.killed, "SIGKILL");
  assert.ok(Date.now() - startedAt < 2000);
});

test("adb 起不来时报可诊断错误", async () => {
  const { spawnFn } = scriptedSpawn(() => {
    const error = new Error("spawn adb ENOENT") as NodeJS.ErrnoException;
    error.code = "ENOENT";
    return { spawnError: error };
  });
  const result = await executeAdbShell(["am", "force-stop", "com.x"], {
    env: { ADB_PATH: ADB, ADB_SERIAL: "SERIAL" },
    spawnFn,
  });
  assert.equal(result.ok, false);
  assert.match(result.spawnError?.message ?? "", /ENOENT/);
});

// ── HTTP ──────────────────────────────────────────────────────────────

test("HTTP：没凭据 403 空体", async () => {
  const { spawnFn } = scriptedSpawn(() => ({ stdout: "ok" }));
  const app = buildApp({ env: { ADB_PATH: ADB, ADB_SERIAL: "SERIAL" }, spawnFn });
  const response = await shellRequest(app, ["am", "force-stop", "com.x"], null);
  assert.equal(response.status, 403);
  assert.equal(await response.text(), "");
});

test("HTTP：拒绝 ls / 且不创建子进程", async () => {
  const { spawnFn, calls } = scriptedSpawn(() => ({ stdout: "SHOULD NOT RUN" }));
  const app = buildApp({ env: { ADB_PATH: ADB, ADB_SERIAL: "SERIAL" }, spawnFn });
  const response = await shellRequest(app, ["ls", "/"]);
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 400);
  assert.equal(body.ok, false);
  assert.equal(body.error, "rejected");
  assert.equal(calls.length, 0);
});

test("HTTP：缺 --display 与元字符都 400", async () => {
  const { spawnFn, calls } = scriptedSpawn(() => ({ stdout: "SHOULD NOT RUN" }));
  const app = buildApp({ env: { ADB_PATH: ADB, ADB_SERIAL: "SERIAL" }, spawnFn });

  for (const argv of [
    ["am", "start", "-n", "com.x/.Y"],
    ["am", "start", "--display", "0", "-n", "com.x/.Y;rm -rf /"],
  ]) {
    const response = await shellRequest(app, argv);
    assert.equal(response.status, 400, JSON.stringify(argv));
  }
  assert.equal(calls.length, 0);
});

test("HTTP：成功返回 exitCode/stdout/stderr", async () => {
  const { spawnFn } = scriptedSpawn(() => ({ stdout: "Starting: Intent { ... }\n", stderr: "" }));
  const app = buildApp({ env: { ADB_PATH: ADB, ADB_SERIAL: "SERIAL" }, spawnFn });
  const response = await shellRequest(app, [
    "am",
    "start",
    "--display",
    "0",
    "-n",
    "com.android.settings/.Settings",
  ]);
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    ok: true,
    exitCode: 0,
    stdout: "Starting: Intent { ... }\n",
    stderr: "",
  });
});

test("HTTP：超时返回 504 且子进程被清掉", async () => {
  const { spawnFn, children } = scriptedSpawn(() => ({ hang: true }));
  const app = buildApp({
    env: { ADB_PATH: ADB, ADB_SERIAL: "SERIAL" },
    spawnFn,
    timeoutMs: 40,
  });
  const response = await shellRequest(app, [
    "input",
    "-d",
    "0",
    "swipe",
    "1",
    "2",
    "3",
    "4",
    "60000",
  ]);
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 504);
  assert.equal(body.error, "timeout");
  assert.equal(children[0]?.killed, "SIGKILL");
});
