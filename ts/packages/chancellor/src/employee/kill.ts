import { spawn, type ChildProcess } from "node:child_process";
import process from "node:process";

/**
 * Windows 上只杀直接子进程会漏掉孙子进程，先整棵树杀掉。
 * 非 Windows 直接 kill。
 */
export function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (process.platform !== "win32" || typeof pid !== "number") {
    killDefault(child);
    return;
  }
  let handled = false;
  const fallback = (): void => {
    if (handled) return;
    handled = true;
    killDefault(child);
  };
  try {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.on("error", fallback);
    killer.on("close", (code) => {
      if (code === 0) handled = true;
      else fallback();
    });
  } catch {
    fallback();
  }
}

function killDefault(child: ChildProcess): void {
  try {
    child.kill();
  } catch {
    /* 进程可能已经退出 */
  }
}
