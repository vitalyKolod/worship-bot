import { ChildProcess, spawn } from "node:child_process";

const activeProcesses = new Set<ChildProcess>();
process.once("exit", () => {
  for (const child of activeProcesses) child.kill("SIGTERM");
});

export async function runProcess(executable: string, args: string[], timeoutMs: number, cwd?: string, onStderr?: (chunk: string) => void): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    activeProcesses.add(child);
    let stdout = "";
    let stderr = "";
    const append = (current: string, chunk: Buffer) => (current + chunk.toString()).slice(-64_000);
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); onStderr?.(chunk.toString()); });
    const timer = setTimeout(() => { child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 5_000).unref(); }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); activeProcesses.delete(child); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      activeProcesses.delete(child);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Process failed (code=${code}, signal=${signal ?? "none"}): ${stderr.slice(-4000)}`));
    });
  });
}
