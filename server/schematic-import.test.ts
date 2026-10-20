import assert from "node:assert/strict"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import request from "supertest"
import { createApp } from "./app.js"
import { readFile as readFixture } from "node:fs/promises"

const schematic = await readFixture(new URL("./fixtures/import-sample.kicad_sch", import.meta.url), "utf8")
const easyedaSchematic = await readFixture(new URL("./fixtures/easyeda-standard-sample.json", import.meta.url), "utf8")

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "circuits-import-"))
  const app = createApp({ projectsDir: root, watchFiles: false, buildCircuit: async () => [] })
  return { root, app, cleanup: async () => { await (app.locals.projectService as { close: () => Promise<void> }).close(); await rm(root, { recursive: true, force: true }) } }
}

test("imports EasyEDA Standard schematics into editable source and preserves the JSON", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "circuits-easyeda-"))
  const fakeCli = path.join(root, "kicad-cli")
  const convertedFixture = new URL("./fixtures/import-sample.kicad_sch", import.meta.url).pathname
  await writeFile(fakeCli, `#!/usr/bin/env node\nconst fs = require('node:fs'); const args = process.argv.slice(2); if (args[0] !== 'sch' || args[1] !== 'upgrade' || args[2] !== '--force') process.exit(3); fs.copyFileSync(${JSON.stringify(convertedFixture)}, args[3]);\n`)
  await chmod(fakeCli, 0o755)
  const app = createApp({ projectsDir: path.join(root, "projects"), watchFiles: false, buildCircuit: async () => [], kicadCliPath: fakeCli })
  try {
    const response = await request(app).post("/api/projects/import").send({ name: "EasyEDA import", files: [{ name: "board.json", content: easyedaSchematic }] })
    assert.equal(response.status, 201, JSON.stringify(response.body))
    const imported = response
    assert.ok(imported.body.sourceComponents > 0)
    assert.ok(imported.body.warnings.some((warning: string) => /best-effort/.test(warning)))
    const source = await request(app).get(`/api/projects/${imported.body.project.id}/files`).query({ path: "index.circuit.tsx" }).expect(200)
    assert.match(source.body.content, /ImportedSchematic/)
    const generated = await request(app).post(`/api/projects/${imported.body.project.id}/generate-pcb`).set("If-Match", imported.body.project.revision).expect(200)
    assert.ok(generated.body.placements > 0)
    const boardSource = await request(app).get(`/api/projects/${imported.body.project.id}/files`).query({ path: "index.circuit.tsx" }).expect(200)
    assert.match(boardSource.body.content, /<chip name="[A-Z]+\d+"/)
    assert.match(boardSource.body.content, /<schematicline/)
    const pcb = await request(app).get(`/api/projects/${imported.body.project.id}/preview`).query({ kind: "pcb" }).expect(200)
    assert.ok(pcb.body.circuitJson.some((item: { type: string }) => item.type === "pcb_component"))
    const original = await readFile(path.join(root, "projects", imported.body.project.id, "imports", "board.json"), "utf8")
    assert.equal(original, easyedaSchematic)
  } finally {
    await (app.locals.projectService as { close: () => Promise<void> }).close()
    await rm(root, { recursive: true, force: true })
  }
})

test("rejects malformed EasyEDA JSON with a useful error", async () => {
  const f = await fixture()
  try {
    const result = await request(f.app).post("/api/projects/import").send({ name: "Broken", files: [{ name: "broken.json", content: "{" }] }).expect(400)
    assert.match(result.body.error, /valid EasyEDA Standard JSON/i)
  } finally { await f.cleanup() }
})

test("imports KiCad schematics into editable source and preserves uploaded files", async () => {
  const f = await fixture()
  try {
    const imported = await request(f.app).post("/api/projects/import").send({
      name: "Imported sample",
      files: [{ name: "sample.kicad_sch", content: schematic }],
    }).expect(201)
    assert.equal(imported.body.project.name, "Imported sample")
    assert.ok(imported.body.sourceComponents > 0)
    assert.ok(imported.body.warnings.some((warning: string) => /best-effort/.test(warning)))
    const file = await request(f.app).get(`/api/projects/${imported.body.project.id}/files`).query({ path: "index.circuit.tsx" }).expect(200)
    assert.match(file.body.content, /ImportedSchematic/)
    const original = await readFile(path.join(f.root, imported.body.project.id, "imports", "sample.kicad_sch"), "utf8")
    assert.equal(original, schematic)
  } finally { await f.cleanup() }
})

test("rejects unsupported and malformed schematic imports with actionable errors", async () => {
  const f = await fixture()
  try {
    await request(f.app).post("/api/projects/import").send({ name: "Nope", files: [{ name: "board.sch", content: "" }] }).expect(400)
    const result = await request(f.app).post("/api/projects/import").send({ name: "Broken", files: [{ name: "broken.kicad_sch", content: "not a schematic" }] }).expect(400)
    assert.match(result.body.error, /convert|schematic/i)
  } finally { await f.cleanup() }
})

test("imported schematic source builds into a workbench preview", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "circuits-import-build-"))
  const app = createApp({ projectsDir: root, watchFiles: false, buildExecutionMode: "trusted-local" })
  try {
    const imported = await request(app).post("/api/projects/import").send({
      name: "Imported sample",
      files: [{ name: "sample.kicad_sch", content: schematic }],
    }).expect(201)
    let current: { lastBuild?: { status: string; diagnostics: Array<{ message: string }> } } = {}
    for (let attempt = 0; attempt < 60; attempt++) {
      const response = await request(app).get(`/api/projects/${imported.body.project.id}`).expect(200)
      current = response.body
      if (["ready", "failed"].includes(current.lastBuild?.status ?? "")) break
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    assert.equal(current.lastBuild?.status, "ready", JSON.stringify(current.lastBuild?.diagnostics))
    const preview = await request(app).get(`/api/projects/${imported.body.project.id}/preview`).query({ kind: "schematic" }).expect(200)
    assert.ok(preview.body.circuitJson.some((item: { type: string }) => item.type === "source_component"))
  } finally {
    await (app.locals.projectService as { close: () => Promise<void> }).close()
    await rm(root, { recursive: true, force: true })
  }
})
