import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
const [,, taskFile, outFile, model] = process.argv;
const task = readFileSync(taskFile, "utf8");
const env = { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" };
const child = spawn("C:/Program Files/nodejs/node.exe",
  ["C:/Users/<user>/AppData/Roaming/npm/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy", "-p", task, "--model", model, "--output-format", "json", "-y"],
  { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
writeFileSync(outFile + ".stdout", "");
writeFileSync(outFile + ".stderr", "");
child.stdout.on("data", (d) => appendFileSync(outFile + ".stdout", d));
child.stderr.on("data", (d) => appendFileSync(outFile + ".stderr", d));
child.on("exit", (code) => { appendFileSync(outFile + ".stdout", `\n[EXIT ${code}]\n`); process.exit(0); });
