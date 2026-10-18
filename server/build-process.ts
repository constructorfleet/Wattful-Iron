import { spawn } from "node:child_process"

export type CommandResult = {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}

export async function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<CommandResult> {
  const detached = process.platform !== "win32"
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"], detached })
  let stdout = ""
  let stderr = ""
  let timedOut = false
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk })
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk })
  const timeout = setTimeout(() => {
    timedOut = true
    terminateProcessGroup(child, detached)
  }, options.timeoutMs)
  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject)
      child.once("close", (code) => resolve(code ?? 1))
    })
    return { exitCode, stdout, stderr, timedOut }
  } finally {
    clearTimeout(timeout)
  }
}

function terminateProcessGroup(child: ReturnType<typeof spawn>, detached: boolean) {
  if (!detached || child.pid === undefined) {
    child.kill("SIGKILL")
    return
  }
  try {
    process.kill(-child.pid, "SIGKILL")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL")
  }
}
