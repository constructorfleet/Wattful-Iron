import assert from "node:assert/strict"
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import test from "node:test"
import { tmpdir } from "node:os"
import path from "node:path"
import express from "express"
import request from "supertest"
import { checkManufacturability, cleanupManufacturingArchive, createGerberArchive, mountManufacturingRoutes } from "./manufacturing.js"

const elements = [
  { type: "pcb_board", width: 20, height: 10 },
  { type: "source_component", source_component_id: "source_component_1", name: "R1", footprint: "0402" },
  { type: "pcb_component", source_component_id: "source_component_1", width: 1, height: 1 },
]

test("manufacturing preflight accepts the current successful board and reports limits", () => {
  const result = checkManufacturability(elements, { status: "ready", revision: "rev-1" }, "rev-1")
  assert.equal(result.ready, true)
  assert.equal(result.checks.find(({ id }) => id === "bom-review")?.status, "warning")
  assert.equal(result.checks.find(({ id }) => id === "electrical-validation")?.status, "warning")
  assert.equal(result.checks.find(({ id }) => id === "fabricator-profile")?.status, "warning")
})

test("manufacturing preflight blocks stale or unsuccessful builds", () => {
  const result = checkManufacturability(elements, { status: "failed", revision: "rev-1" }, "rev-1")
  assert.equal(result.ready, false)
  assert.equal(result.checks.find(({ id }) => id === "build")?.status, "fail")
  const stale = checkManufacturability(elements, { status: "ready", revision: "rev-1" }, "rev-1", "rev-2")
  assert.equal(stale.ready, false)
})

test("manufacturing preflight blocks a board without footprints or references", () => {
  const result = checkManufacturability([
    { type: "pcb_board" },
    { type: "source_component", source_component_id: "source_component_2", name: "", footprint: "" },
  ], { status: "ready", revision: "rev-1" }, "rev-1")
  assert.equal(result.ready, false)
  assert.equal(result.checks.find(({ id }) => id === "references")?.status, "fail")
  assert.equal(result.checks.find(({ id }) => id === "footprints")?.status, "fail")
})

test("manufacturing preflight blocks Circuit JSON without a PCB board", () => {
  const result = checkManufacturability([], { status: "ready", revision: "rev-1" }, "rev-1")
  assert.equal(result.ready, false)
  assert.equal(result.checks.find(({ id }) => id === "board")?.status, "fail")
})

test("manufacturing preflight endpoint returns current build checks", async () => {
  const app = express()
  mountManufacturingRoutes(app, {
    get: async () => ({ name: "Manufacturing project", revision: "rev-1", previewRevision: "rev-1", lastBuild: { status: "ready", revision: "rev-1" } }),
    preview: async () => ({ revision: "rev-1", circuitJson: elements }),
    exportGerbers: async () => { throw new Error("not expected") },
  })
  const response = await request(app).get("/api/projects/project-id/manufacturing").expect(200)
  assert.equal(response.body.projectRevision, "rev-1")
  assert.equal(response.body.preflight.ready, true)
})

test("installed tsci gerbers export packages Gerbers, drills, BOM, and pick-and-place", async () => {
  const projectDir = await buildManufacturingSnapshot()
  let archive: string | undefined
  try {
    archive = await createGerberArchive(projectDir, ".workbench/circuit.json")
    const bytes = await readFile(archive)
    assert.equal(bytes.readUInt32LE(0), 0x04034b50)
    const sizes = archiveEntrySizes(bytes)
    for (const filename of ["F_Cu.gbr", "Edge_Cuts.gbr", "drill-L1-L2.drl", "drill_npth.drl", "bom.csv", "pick_and_place.csv"]) {
      assert.ok((sizes.get(filename) ?? 0) > 0, `missing or empty ${filename} in manufacturing ZIP`)
    }
  } finally {
    if (archive) await cleanupManufacturingArchive(archive)
    await rm(projectDir, { recursive: true, force: true })
  }
})

function archiveEntrySizes(buffer: Buffer) {
  let endOffset = -1
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65_557); offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { endOffset = offset; break }
  }
  assert.ok(endOffset >= 0, "invalid ZIP end record")
  const count = buffer.readUInt16LE(endOffset + 10)
  let offset = buffer.readUInt32LE(endOffset + 16)
  const sizes = new Map<string, number>()
  for (let index = 0; index < count; index++) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, "invalid ZIP central directory")
    const size = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength)
    sizes.set(name.split("/").at(-1)!, size)
    offset += 46 + nameLength + extraLength + commentLength
  }
  return sizes
}

async function buildManufacturingSnapshot() {
  const projectDir = await copyManufacturingProject("circuits-fab-build-")
  await mkdir(path.join(projectDir, ".workbench"), { recursive: true })
  const cli = path.resolve("node_modules/tscircuit/cli.mjs")
  await runBuild(cli, projectDir)
  const builtJson = await readFile(path.join(projectDir, "dist/index/circuit.json"), "utf8")
  await writeFile(path.join(projectDir, ".workbench/circuit.json"), builtJson)
  return projectDir
}

async function copyManufacturingProject(prefix = "circuits-fab-export-") {
  const projectDir = await mkdtemp(path.join(tmpdir(), prefix))
  await symlink(path.resolve("node_modules"), path.join(projectDir, "node_modules"), "dir")
  await writeFile(path.join(projectDir, "index.circuit.tsx"), await readFile(path.resolve("examples/manufacturing-board/index.circuit.tsx")))
  return projectDir
}

function runBuild(cli: string, cwd: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.env.BUN_BINARY ?? "bun", [cli, "build", "index.circuit.tsx"], { cwd, stdio: "ignore" })
    child.once("error", reject)
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`tsci fixture build exited with status ${code ?? "unknown"}`)))
  })
}

test("manufacturing download returns the verified CLI ZIP", async () => {
  const projectDir = await copyManufacturingProject()
  const app = express()
  try {
    mountManufacturingRoutes(app, {
      get: async () => ({ name: "Fab test", revision: "rev-1", lastBuild: { status: "ready", revision: "rev-1" } }),
      preview: async () => ({ revision: "rev-1", circuitJson: elements }),
      exportGerbers: () => createGerberArchive(projectDir, "index.circuit.tsx"),
    })
    const response = await request(app).get("/api/projects/project-id/manufacturing.zip")
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = []
        res.on("data", (chunk: Buffer) => chunks.push(chunk))
        res.on("end", () => callback(null, Buffer.concat(chunks)))
      })
      .expect(200)
    assert.match(response.headers["content-type"]!, /application\/zip/)
    assert.match(response.headers["content-disposition"]!, /fab-test-manufacturing\.zip/i)
    assert.ok(Buffer.isBuffer(response.body))
    assert.ok(response.body.includes(Buffer.from("pick_and_place.csv")))
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
})

test("manufacturing download does not export when preflight fails", async () => {
  const app = express()
  let exportCalled = false
  mountManufacturingRoutes(app, {
    get: async () => ({ revision: "rev-2", lastBuild: { status: "failed", revision: "rev-1" } }),
    preview: async () => ({ revision: "rev-1", circuitJson: elements }),
    exportGerbers: async () => { exportCalled = true; throw new Error("should not export") },
  })
  const response = await request(app).get("/api/projects/project-id/manufacturing.zip").expect(422)
  assert.equal(exportCalled, false)
  assert.equal(response.body.preflight.ready, false)
})

test("manufacturing download rejects a project revision change and cleans its temporary ZIP", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "circuits-fab-race-"))
  const archive = path.join(tempDir, "manufacturing.zip")
  await writeFile(archive, "test archive")
  let getCount = 0
  const app = express()
  mountManufacturingRoutes(app, {
    get: async () => ++getCount === 1
      ? { name: "Fab test", revision: "rev-1", lastBuild: { status: "ready", revision: "rev-1" } }
      : { name: "Fab test", revision: "rev-2", lastBuild: { status: "ready", revision: "rev-1" } },
    preview: async () => ({ revision: "rev-1", circuitJson: elements }),
    exportGerbers: async () => archive,
  })
  app.use((error: Error & { status?: number }, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(error.status ?? 500).json({ error: error.message })
  })
  await request(app).get("/api/projects/project-id/manufacturing.zip").expect(409)
  await assert.rejects(access(archive))
})
