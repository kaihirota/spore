import { spawn } from "node:child_process";
import { TIMED_OUT, type Shell } from "./shell";

export const localShell: Shell = (command, options = {}) =>
  new Promise((resolve) => {
    // Own process group, so a timeout kills everything the command started.
    const child = spawn("/bin/bash", ["-c", command], { cwd: options.cwd, detached: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          process.kill(-child.pid!, "SIGKILL");
        }, options.timeoutMs)
      : undefined;
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) resolve({ exitCode: TIMED_OUT, stdout, stderr: `${stderr}\ntimed out after ${options.timeoutMs} ms` });
      else resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
