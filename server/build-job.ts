import { spawn } from "node:child_process"
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises"
import path from "node:path"

const RESULT_PREFIX = "@@WATTFUL_BUILD_RESULT@@"
const ERROR_PREFIX = "@@WATTFUL_BUILD_ERROR@@"
const MAX_RESULT_BYTES = 12 * 1024 * 1024

async function main() {
  const entrypoint = process.argv[2]
  if (!entrypoint || path.isAbsolute(entrypoint) || entrypoint.split("/").some((part) => part === ".." || part.startsWith("."))) {
    throw new Error("Invalid build entrypoint")
  }
  const workspace = "/tmp/build"
  await mkdir(workspace, { recursive: true })
  await copySourceTree("/app/build", workspace)
  try { await symlink("/app/node_modules", path.join(workspace, "node_modules"), "dir") } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  const executable = "/app/node_modules/tscircuit/cli.mjs"
  const { exitCode, output } = await runBuild("/usr/local/bin/bun", [executable, "build", entrypoint], workspace)
  if (exitCode !== 0) throw new Error(output || `tsci build exited ${exitCode}`)
  const circuitFiles = await findCircuitJson(path.join(workspace, "dist"))
  let circuitJson: unknown
  for (const file of circuitFiles) {
    try { circuitJson = JSON.parse(await readFile(file, "utf8")); break } catch { /* Check the next compiler output. */ }
  }
  if (circuitJson === undefined) throw new Error("tsci build succeeded without producing Circuit JSON")
  const json = JSON.stringify(circuitJson)
  if (Buffer.byteLength(json) > MAX_RESULT_BYTES) throw new Error("Circuit JSON output exceeds the build limit")
  process.stdout.write(`${RESULT_PREFIX}${json}\n`)
}

async function copySourceTree(source: string, destination: string): Promise<void> {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name)
    const destinationPath = path.join(destination, entry.name)
    if (entry.isDirectory()) {
      await mkdir(destinationPath, { recursive: true })
      await copySourceTree(sourcePath, destinationPath)
    } else if (entry.isFile()) {
      await writeFile(destinationPath, await readFile(sourcePath), { mode: 0o644 })
    } else {
      throw new Error("Build source archive contains an unsupported entry")
    }
  }
}

function runBuild(command: string, args: string[], cwd: string) {
  return new Promise<{ exitCode: number; output: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp", TMPDIR: "/tmp", CI: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let output = ""
    const collect = (chunk: Buffer) => { output = (output + chunk.toString("utf8")).slice(-16_000) }
    child.stdout.on("data", collect)
    child.stderr.on("data", collect)
    child.once("error", reject)
    child.once("close", (code) => resolve({ exitCode: code ?? 1, output }))
  })
}

async function findCircuitJson(directory: string): Promise<string[]> {
  try {
    const found: string[] = []
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name)
      if (entry.isDirectory()) found.push(...await findCircuitJson(filename))
      else if (entry.isFile() && entry.name === "circuit.json") found.push(filename)
    }
    return found
  } catch { return [] }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stdout.write(`${ERROR_PREFIX}${message.replace(/[\r\n]+/g, " ").slice(0, 16_000)}\n`)
  process.exitCode = 1
})
