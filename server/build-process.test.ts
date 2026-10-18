import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { runCommand } from "./build-process.js"

test("timed out build command kills its descendants", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "circuits-build-process-"))
  const marker = path.join(directory, "escaped")
  const nested = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "escaped"), 350)`
  const parent = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(nested)}], { stdio: "ignore" }); setInterval(() => {}, 1000)`
  try {
    const result = await runCommand(process.execPath, ["-e", parent], { cwd: directory, env: process.env, timeoutMs: 75 })
    assert.equal(result.timedOut, true)
    await new Promise((resolve) => setTimeout(resolve, 450))
    await assert.rejects(readFile(marker), { code: "ENOENT" })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
