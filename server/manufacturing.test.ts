import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import test from "node:test"
import { tmpdir } from "node:os"
import path from "node:path"
import { unzipSync, zipSync } from "fflate"
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
  assert.equal(result.profile.id, "board-default")
  assert.equal(result.checks.find(({ id }) => id === "bom-data")?.status, "warning")
  assert.equal(result.checks.find(({ id }) => id === "circuit-errors")?.status, "not-evaluated")
  assert.equal(result.checks.find(({ id }) => id === "circuit-warnings")?.status, "not-evaluated")
  assert.equal(result.checks.find(({ id }) => id === "trace-width")?.status, "warning")
})

test("BOM preflight identifies source components missing values or supplier part numbers", () => {
  const result = checkManufacturability([
    ...elements,
    { type: "source_component", source_component_id: "source_component_2", name: "C1", value: "100nF" },
  ], { status: "ready", revision: "rev-1" }, "rev-1")

  assert.equal(result.checks.find(({ id }) => id === "bom-data")?.status, "warning")
  assert.match(result.checks.find(({ id }) => id === "bom-data")?.message ?? "", /R1.*manufacturer part number/)
  assert.match(result.checks.find(({ id }) => id === "bom-data")?.message ?? "", /C1.*manufacturer part number/)
})

test("BOM preflight passes when source components have values and supplier part numbers", () => {
  const result = checkManufacturability([
    { ...elements[0] },
    { ...elements[1], value: "10k", manufacturer_part_number: "RC0402FR-0710KL" },
    elements[2]!,
  ], { status: "ready", revision: "rev-1" }, "rev-1")

  assert.equal(result.checks.find(({ id }) => id === "bom-data")?.status, "pass")
})

test("fabricator profile blocks traces and non-plated holes below its published minima", () => {
  const result = checkManufacturability([
    ...elements,
    { type: "pcb_trace", pcb_trace_id: "trace-1", route: [{ route_type: "wire", x: 0, y: 0, width: 0.08, layer: "top" }] },
    { type: "pcb_hole", pcb_hole_id: "hole-1", hole_shape: "circle", x: 0, y: 0, hole_diameter: 0.4 },
  ], { status: "ready", revision: "rev-1" }, "rev-1", "rev-1", "jlcpcb-2layer-1oz")
  assert.equal(result.ready, false)
  assert.equal(result.checks.find(({ id }) => id === "trace-width")?.status, "fail")
  assert.equal(result.checks.find(({ id }) => id === "hole-size")?.status, "fail")
})

test("preflight reports Circuit JSON validation errors and warnings", () => {
  const result = checkManufacturability([
    ...elements,
    { type: "pcb_port_not_connected_error", message: "U1 pin 2 is not connected" },
    { type: "source_pin_missing_trace_warning", message: "R1 pin 1 has no trace" },
  ], { status: "ready", revision: "rev-1" }, "rev-1")
  assert.equal(result.ready, false)
  assert.equal(result.checks.find(({ id }) => id === "circuit-errors")?.status, "fail")
  assert.equal(result.checks.find(({ id }) => id === "circuit-warnings")?.status, "warning")
})

test("Circuit JSON validation records do not imply that missing check categories passed", () => {
  const result = checkManufacturability([
    ...elements,
    { type: "pcb_port_not_connected_error", message: "U1 pin 2 is not connected" },
  ], { status: "ready", revision: "rev-1" }, "rev-1")
  assert.equal(result.checks.find(({ id }) => id === "circuit-errors")?.status, "fail")
  assert.equal(result.checks.find(({ id }) => id === "circuit-warnings")?.status, "not-evaluated")
})

test("manufacturing preflight blocks source connections without a routed PCB trace", () => {
  const result = checkManufacturability([
    ...elements,
    { type: "source_trace", source_trace_id: "source_trace_1" },
    { type: "pcb_trace", pcb_trace_id: "pcb_trace_1", source_trace_id: "source_trace_1", route: [] },
    { type: "source_trace", source_trace_id: "source_trace_2" },
  ], { status: "ready", revision: "rev-1" }, "rev-1")

  assert.equal(result.ready, false)
  assert.equal(result.checks.find(({ id }) => id === "routed-connections")?.status, "fail")
  assert.match(result.checks.find(({ id }) => id === "routed-connections")?.message ?? "", /source_trace_1.*source_trace_2/)
})

test("routing preflight warns when Circuit JSON has no logical connections to verify", () => {
  const result = checkManufacturability(elements, { status: "ready", revision: "rev-1" }, "rev-1")
  assert.equal(result.checks.find(({ id }) => id === "routed-connections")?.status, "warning")
})

test("routing preflight passes when every logical source trace has PCB route geometry", () => {
  const result = checkManufacturability([
    ...elements,
    { type: "source_trace", source_trace_id: "source_trace_1" },
    { type: "pcb_trace", pcb_trace_id: "pcb_trace_1", source_trace_id: "source_trace_1", route: [{ route_type: "wire", x: 0, y: 0, width: 0.2 }] },
  ], { status: "ready", revision: "rev-1" }, "rev-1")

  assert.equal(result.checks.find(({ id }) => id === "routed-connections")?.status, "pass")
})

test("fabricator profile checks copper clearance to a rectangular board edge", () => {
  const result = checkManufacturability([
    ...elements,
    { type: "pcb_trace", pcb_trace_id: "trace-1", route: [{ route_type: "wire", x: 9.9, y: 0, width: 0.1, layer: "top" }] },
  ], { status: "ready", revision: "rev-1" }, "rev-1", "rev-1", "jlcpcb-2layer-1oz")
  assert.equal(result.checks.find(({ id }) => id === "board-edge-clearance")?.status, "fail")
})

test("fabricator profile blocks a declared layer-count or material mismatch", () => {
  const result = checkManufacturability([
    { ...elements[0], num_layers: 4, material: "fr4" },
    ...elements.slice(1),
  ], { status: "ready", revision: "rev-1" }, "rev-1", "rev-1", "jlcpcb-2layer-1oz")
  assert.equal(result.checks.find(({ id }) => id === "board-stackup")?.status, "fail")
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
    getSnapshotFiles: async () => [],
  })
  const response = await request(app).get("/api/projects/project-id/manufacturing").expect(200)
  assert.equal(response.body.projectRevision, "rev-1")
  assert.equal(response.body.preflight.ready, true)
  assert.equal(response.body.preflight.profile.id, "board-default")
  const selected = await request(app).get("/api/projects/project-id/manufacturing?profile=jlcpcb-2layer-1oz").expect(200)
  assert.equal(selected.body.preflight.profile.id, "jlcpcb-2layer-1oz")
  await request(app).get("/api/projects/project-id/manufacturing?profile=unknown").expect(400)
})

test("manufacturing profiles include JLCPCB rigid two-layer one-ounce limits", async () => {
  const app = express()
  mountManufacturingRoutes(app, {
    get: async () => ({ revision: "rev-1" }),
    preview: async () => ({ revision: "rev-1", circuitJson: [] }),
    exportGerbers: async () => { throw new Error("not expected") },
    getSnapshotFiles: async () => [],
  })
  const response = await request(app).get("/api/manufacturing/profiles").expect(200)
  const profile = response.body.profiles.find((item: { id: string }) => item.id === "jlcpcb-2layer-1oz")
  assert.equal(profile.label, "JLCPCB rigid PCB, 2-layer, 1 oz")
  assert.equal(profile.rules.minTraceWidthMm, 0.1)
  assert.equal(profile.rules.minNonPlatedHoleMm, 0.5)
  assert.equal(profile.rules.copperToBoardEdgeMm, 0.2)
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
      getSnapshotFiles: async () => [],
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
    getSnapshotFiles: async () => [],
  })
  const response = await request(app).get("/api/projects/project-id/manufacturing.zip").expect(422)
  assert.equal(exportCalled, false)
  assert.equal(response.body.preflight.ready, false)
})

test("manufacturing download applies the selected profile before exporting", async () => {
  const app = express()
  let exportCalled = false
  mountManufacturingRoutes(app, {
    get: async () => ({ revision: "rev-1", lastBuild: { status: "ready", revision: "rev-1" } }),
    preview: async () => ({ revision: "rev-1", circuitJson: [...elements, { type: "pcb_hole", hole_shape: "circle", hole_diameter: 0.4 }] }),
    exportGerbers: async () => { exportCalled = true; return "/tmp/never.zip" },
    getSnapshotFiles: async () => [],
  })
  const response = await request(app).get("/api/projects/project-id/manufacturing.zip?profile=jlcpcb-2layer-1oz").expect(422)
  assert.equal(exportCalled, false)
  assert.equal(response.body.preflight.profile.id, "jlcpcb-2layer-1oz")
})

test("manufacturing ZIP contains a revisioned provenance manifest with artifact checksums", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "circuits-fab-manifest-"))
  const archive = path.join(tempDir, "manufacturing.zip")
  const gerber = Buffer.from("gerber-artifact")
  const bom = Buffer.from("Reference,Value\\nR1,1k\\n")
  await writeFile(archive, zipSync({ "F_Cu.gbr": gerber, "bom.csv": bom }, { level: 0 }))
  const app = express()
  mountManufacturingRoutes(app, {
    get: async () => ({ id: "project-id", name: "Snapshot board", revision: "rev-1", lastBuild: { status: "ready", revision: "rev-1" } }),
    preview: async () => ({ revision: "rev-1", circuitJson: elements.map((item) => item.type === "source_component" ? { ...item, manufacturer_part_number: "RES-1K" } : item) }),
    exportGerbers: async () => archive,
    getSnapshotFiles: async () => [
      { path: "index.circuit.tsx", content: "export default () => <board />" },
      { path: "package.json", content: JSON.stringify({ dependencies: { tscircuit: "0.0.2930" } }) },
      { path: "package-lock.json", content: JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/tscircuit": { version: "0.0.2930" } } }) },
    ],
  })
  try {
    const response = await request(app).get("/api/projects/project-id/manufacturing.zip")
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = []
        res.on("data", (chunk: Buffer) => chunks.push(chunk))
        res.on("end", () => callback(null, Buffer.concat(chunks)))
      })
      .expect(200)
    const entries = unzipSync(new Uint8Array(response.body))
    const manifest = JSON.parse(Buffer.from(entries["snapshot-manifest.json"]!).toString("utf8"))
    assert.deepEqual(manifest.project, { id: "project-id", name: "Snapshot board", revision: "rev-1" })
    assert.equal(manifest.source.files[0].sha256, createHash("sha256").update("export default () => <board />").digest("hex"))
    assert.equal(manifest.dependencies.resolved.tscircuit, "0.0.2930")
    assert.equal(manifest.bom_artifact, "bom.csv")
    assert.equal(manifest.checksum_scope, "all files in archive except snapshot-manifest.json")
    assert.equal(manifest.components[0].manufacturer_part_number, "RES-1K")
    assert.equal(manifest.validation.checks.length > 0, true)
    assert.equal(manifest.simulation.status, "not_configured")
    assert.equal(manifest.artifacts.find((item: { path: string }) => item.path === "bom.csv").sha256, createHash("sha256").update(bom).digest("hex"))
    assert.equal(entries["F_Cu.gbr"]?.byteLength, gerber.byteLength)
  } finally { await rm(tempDir, { recursive: true, force: true }) }
})

test("manufacturing download rejects a project revision change and cleans its temporary ZIP", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "circuits-fab-race-"))
  const archive = path.join(tempDir, "manufacturing.zip")
  await writeFile(archive, zipSync({ "F_Cu.gbr": Buffer.from("gerber") }, { level: 0 }))
  let getCount = 0
  const app = express()
  mountManufacturingRoutes(app, {
    get: async () => ++getCount === 1
      ? { name: "Fab test", revision: "rev-1", lastBuild: { status: "ready", revision: "rev-1" } }
      : { name: "Fab test", revision: "rev-2", lastBuild: { status: "ready", revision: "rev-1" } },
    preview: async () => ({ revision: "rev-1", circuitJson: elements }),
    exportGerbers: async () => archive,
    getSnapshotFiles: async () => [],
  })
  app.use((error: Error & { status?: number }, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(error.status ?? 500).json({ error: error.message })
  })
  await request(app).get("/api/projects/project-id/manufacturing.zip").expect(409)
  await assert.rejects(access(archive))
})
