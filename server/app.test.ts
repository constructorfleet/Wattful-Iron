import assert from "node:assert/strict"
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import request from "supertest"
import { createApp } from "./app.js"

const circuit = [{ type: "source_component", name: "demo" }]

async function fixture(build: (projectDir: string) => Promise<unknown>) {
  const root = await mkdtemp(path.join(tmpdir(), "circuits-server-"))
  const app = createApp({ projectsDir: root, buildCircuit: build, watchFiles: false })
  return { root, app, cleanup: async () => { await (app.locals.projectService as { close: () => Promise<void> }).close(); await rm(root, { recursive: true, force: true }) } }
}

test("project creation returns an editable tscircuit starter and project listing", async () => {
  const f = await fixture(async () => circuit)
  try {
    const created = await request(f.app).post("/api/projects").send({ name: "LED board" }).expect(201)
    assert.equal(created.body.name, "LED board")
    assert.equal(created.body.entrypoint, "index.circuit.tsx")
    const file = await request(f.app)
      .get("/api/projects/" + created.body.id + "/files")
      .query({ path: "index.circuit.tsx" })
      .expect(200)
    assert.match(file.body.content, /<board/)
    assert.equal(file.body.revision, created.body.revision)
    const listed = await request(f.app).get("/api/projects").expect(200)
    assert.deepEqual(listed.body.map((project: { id: string }) => project.id), [created.body.id])
  } finally {
    await f.cleanup()
  }
})

test("built-in examples are listed and copied into independent editable projects", async () => {
  const f = await fixture(async () => circuit)
  try {
    const examples = await request(f.app).get("/api/examples").expect(200)
    assert.ok(examples.body.some((example: { id: string }) => example.id === "blank-board"))
    assert.ok(examples.body.some((example: { id: string }) => example.id === "led-indicator"))
    assert.ok(examples.body.some((example: { id: string }) => example.id === "voltage-divider"))
    for (const example of examples.body as Array<{ id: string; name: string }>) {
      const created = await request(f.app).post("/api/projects").send({ name: example.name, templateId: example.id }).expect(201)
      const file = await request(f.app).get(`/api/projects/${created.body.id}/files`).query({ path: created.body.entrypoint }).expect(200)
      assert.match(file.body.content, /export default/)
      assert.ok(file.body.content.length > 30, `${example.id} should have its own circuit source`)
      assert.ok(file.body.revision)
      assert.equal(file.body.content, await readFile(path.resolve(`examples/${example.id}/index.circuit.tsx`), "utf8"))
      if (example.id === "led-indicator") {
        const sharedSource = await readFile(path.resolve("examples/led-indicator/index.circuit.tsx"), "utf8")
        await request(f.app).put(`/api/projects/${created.body.id}/files`).query({ path: created.body.entrypoint })
          .set("If-Match", file.body.revision).send({ content: `${file.body.content}\n// local edit`, revision: file.body.revision }).expect(200)
        assert.equal(await readFile(path.resolve("examples/led-indicator/index.circuit.tsx"), "utf8"), sharedSource)
      }
    }
    await request(f.app).post("/api/projects").send({ name: "Invalid", templateId: "../outside" }).expect(400)
  } finally {
    await f.cleanup()
  }
})

test("projects can be duplicated at a known revision with independent files and retained metadata", async () => {
  const f = await fixture(async () => circuit)
  try {
    const { body: original } = await request(f.app).post("/api/projects").send({ name: "Sensor board" }).expect(201)
    const source = await request(f.app).get(`/api/projects/${original.id}/files`).query({ path: original.entrypoint }).expect(200)
    const edited = await request(f.app).put(`/api/projects/${original.id}/files`).query({ path: original.entrypoint })
      .set("If-Match", source.body.revision).send({ revision: source.body.revision, content: "export default () => <board name=\"sensor\" />" }).expect(200)
    const extra = await request(f.app).put(`/api/projects/${original.id}/files`).query({ path: "src/config.json" })
      .set("If-Match", edited.body.revision).send({ revision: edited.body.revision, content: "{\"gain\":2}" }).expect(200)
    const originalPackage = await request(f.app).get(`/api/projects/${original.id}/files`).query({ path: "package.json" }).expect(200)
    const duplicate = await request(f.app).post(`/api/projects/${original.id}/duplicate`)
      .set("If-Match", extra.body.revision).send({ name: "Sensor board experiment" }).expect(201)
    assert.notEqual(duplicate.body.id, original.id)
    assert.equal(duplicate.body.name, "Sensor board experiment")
    assert.equal(duplicate.body.entrypoint, original.entrypoint)
    assert.notEqual(duplicate.body.revision, extra.body.revision)

    const duplicateSource = await request(f.app).get(`/api/projects/${duplicate.body.id}/files`).query({ path: original.entrypoint }).expect(200)
    const duplicateConfig = await request(f.app).get(`/api/projects/${duplicate.body.id}/files`).query({ path: "src/config.json" }).expect(200)
    const duplicatePackage = await request(f.app).get(`/api/projects/${duplicate.body.id}/files`).query({ path: "package.json" }).expect(200)
    assert.equal(duplicateSource.body.content, "export default () => <board name=\"sensor\" />")
    assert.equal(duplicateConfig.body.content, "{\"gain\":2}")
    assert.equal(duplicatePackage.body.content, originalPackage.body.content)
    const changed = await request(f.app).put(`/api/projects/${duplicate.body.id}/files`).query({ path: "src/config.json" })
      .set("If-Match", duplicate.body.revision).send({ revision: duplicate.body.revision, content: "{\"gain\":4}" }).expect(200)
    assert.equal((await request(f.app).get(`/api/projects/${original.id}/files`).query({ path: "src/config.json" })).body.content, "{\"gain\":2}")
    await request(f.app).post(`/api/projects/${original.id}/duplicate`).set("If-Match", edited.body.revision)
      .send({ name: "Stale copy" }).expect(409)
    await request(f.app).get(`/api/projects/${duplicate.body.id}`).expect(200)
    assert.notEqual(changed.body.revision, duplicate.body.revision)
  } finally { await f.cleanup() }
})

test("project duplication preserves PDF references and their document bytes", async () => {
  const f = await fixture(async () => circuit)
  try {
    const pdf = Buffer.from("%PDF-1.4\nreference content")
    const imported = await request(f.app).post("/api/projects/import-pdf").query({ name: "PDF project", filename: "schematic.pdf" })
      .set("Content-Type", "application/pdf").send(pdf).expect(201)
    const duplicate = await request(f.app).post(`/api/projects/${imported.body.id}/duplicate`)
      .set("If-Match", imported.body.revision).send({ name: "PDF project copy" }).expect(201)
    assert.deepEqual(duplicate.body.referencePdfs, imported.body.referencePdfs)
    const referenceId = duplicate.body.referencePdfs[0].id
    const copiedPdf = await request(f.app).get(`/api/projects/${duplicate.body.id}/references/${referenceId}`).expect(200)
    assert.deepEqual(copiedPdf.body, pdf)
  } finally { await f.cleanup() }
})

test("project metadata can be renamed and deletion requires current revision and explicit name confirmation", async () => {
  const f = await fixture(async () => circuit)
  try {
    const { body: created } = await request(f.app).post("/api/projects").send({ name: "Initial" }).expect(201)
    const renamed = await request(f.app).patch("/api/projects/" + created.id)
      .set("If-Match", created.revision).send({ name: "Renamed" }).expect(200)
    assert.equal(renamed.body.name, "Renamed")
    await request(f.app).delete("/api/projects/" + created.id)
      .set("If-Match", renamed.body.revision).set("X-Confirm-Delete", "wrong")
      .expect(400)
    const deleted = await request(f.app).delete("/api/projects/" + created.id)
      .set("If-Match", renamed.body.revision).set("X-Confirm-Delete", "Renamed")
    assert.equal(deleted.status, 204, deleted.text)
    await request(f.app).get("/api/projects/" + created.id).expect(404)
  } finally {
    await f.cleanup()
  }
})

test("source writes require the current revision and reject traversal", async () => {
  const f = await fixture(async () => circuit)
  try {
    const { body: project } = await request(f.app).post("/api/projects").send({ name: "Safe" }).expect(201)
    const read = await request(f.app)
      .get("/api/projects/" + project.id + "/files").query({ path: "index.circuit.tsx" }).expect(200)
    const updated = await request(f.app)
      .put("/api/projects/" + project.id + "/files")
      .query({ path: "index.circuit.tsx" })
      .set("If-Match", read.body.revision)
      .send({ content: "export default () => null", revision: read.body.revision })
      .expect(200)
    assert.notEqual(updated.body.revision, read.body.revision)
    await request(f.app)
      .put("/api/projects/" + project.id + "/files")
      .query({ path: "index.circuit.tsx" })
      .set("If-Match", read.body.revision)
      .send({ content: "stale", revision: read.body.revision })
      .expect(409)
    await request(f.app)
      .get("/api/projects/" + project.id + "/files").query({ path: "../../outside" }).expect(400)
    await request(f.app)
      .get("/api/projects/" + project.id + "/files").query({ path: ".workbench/project.json" }).expect(400)
    await assert.rejects(readFile(path.join(f.root, "outside")))
  } finally {
    await f.cleanup()
  }
})

test("project requirements are schema-validated, revisioned, and marked stale until the build catches up", async () => {
  const f = await fixture(async () => [{ type: "pcb_board", width: 50, height: 35, num_layers: 4 }])
  try {
    const { body: project } = await request(f.app).post("/api/projects").send({ name: "Requirements" }).expect(201)
    const empty = await request(f.app).get(`/api/projects/${project.id}/requirements`).expect(200)
    assert.equal(empty.body.configured, false)
    const document = { version: 1, requirements: { board: { width_mm: 50, height_mm: 35, layers: 4 } } }
    const saved = await request(f.app).put(`/api/projects/${project.id}/requirements`)
      .set("If-Match", project.revision).send({ revision: project.revision, requirements: document }).expect(200)
    assert.equal(saved.body.configured, true)
    assert.notEqual(saved.body.revision, project.revision)
    assert.deepEqual(saved.body.requirements.requirements.board, document.requirements.board)
    const read = await request(f.app).get(`/api/projects/${project.id}/requirements`).expect(200)
    assert.equal(read.body.configured, true)
    assert.deepEqual(read.body.requirements, document)
    const validation = await request(f.app).get(`/api/projects/${project.id}/requirements/validate`).expect(200)
    assert.equal(validation.body.stale, true)
    await request(f.app).put(`/api/projects/${project.id}/requirements`)
      .set("If-Match", project.revision).send({ revision: project.revision, requirements: document }).expect(409)
    await request(f.app).put(`/api/projects/${project.id}/requirements`)
      .set("If-Match", read.body.revision).send({ revision: read.body.revision, requirements: { version: 1, requirements: { board: { width_mm: -1 } } } }).expect(400)
  } finally { await f.cleanup() }
})

test("REST requirements validation checks required component references and named nets", async () => {
  const f = await fixture(async () => [
    { type: "source_component", name: "U1" },
    { type: "source_trace", name: "GND", connected_source_port_ids: ["port-1", "port-2"] },
  ])
  try {
    const { body: project } = await request(f.app).post("/api/projects").send({ name: "Reference checks" }).expect(201)
    await waitForPreview(f.app, project.id)
    const saved = await request(f.app).put(`/api/projects/${project.id}/requirements`)
      .set("If-Match", project.revision).send({ revision: project.revision, requirements: { version: 1, requirements: { components: ["U1", "U2"], nets: ["GND", "SCL"] } } }).expect(200)
    await request(f.app).post(`/api/projects/${project.id}/build`).expect(202)
    await waitForPreview(f.app, project.id, saved.body.revision)
    const validation = await request(f.app).get(`/api/projects/${project.id}/requirements/validate`).expect(200)
    assert.deepEqual(validation.body.checks.map(({ id, status }: { id: string; status: string }) => [id, status]), [
      ["component-U1", "pass"], ["component-U2", "fail"], ["net-GND", "pass"], ["net-SCL", "fail"],
    ])
    assert.equal(validation.body.failed, 2)
  } finally { await f.cleanup() }
})

async function waitForPreview(app: ReturnType<typeof createApp>, projectId: string, revision?: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const preview = await request(app).get(`/api/projects/${projectId}/preview?kind=schematic`)
    if (preview.status === 200 && (!revision || preview.body.revision === revision)) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail("timed out waiting for a successful preview")
}

test("simultaneous writes using one revision allow only one save", async () => {
  const f = await fixture(async () => circuit)
  try {
    const { body: project } = await request(f.app).post("/api/projects").send({ name: "Concurrent" }).expect(201)
    const pathQuery = { path: project.entrypoint }
    const read = await request(f.app).get("/api/projects/" + project.id + "/files").query(pathQuery).expect(200)
    const save = (content: string) => request(f.app).put("/api/projects/" + project.id + "/files")
      .query(pathQuery).set("If-Match", read.body.revision)
      .send({ content, revision: read.body.revision })
    const results = await Promise.all([save("first writer"), save("second writer")])
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 409])
  } finally {
    await f.cleanup()
  }
})

test("project history lists snapshots and compares changed source files", async () => {
  const f = await fixture(async () => circuit)
  try {
    const { body: project } = await request(f.app).post("/api/projects").send({ name: "History" }).expect(201)
    const initial = await request(f.app).get(`/api/projects/${project.id}/history`).expect(200)
    assert.equal(initial.body.revisions.length, 1)
    const before = initial.body.revisions[0]
    const file = await request(f.app).get(`/api/projects/${project.id}/files`).query({ path: project.entrypoint }).expect(200)
    const saved = await request(f.app).put(`/api/projects/${project.id}/files`).query({ path: project.entrypoint })
      .set("If-Match", file.body.revision).send({ content: "export default () => <board width='24mm' />", revision: file.body.revision }).expect(200)
    const history = await request(f.app).get(`/api/projects/${project.id}/history`).expect(200)
    assert.equal(history.body.revisions.length, 2)
    const after = history.body.revisions.find((revision: { revision: string }) => revision.revision === saved.body.revision)
    assert.deepEqual(after.changedFiles, [project.entrypoint])
    assert.equal(typeof after.createdAt, "string")
    const compared = await request(f.app).get(`/api/projects/${project.id}/history/compare`).query({ from: before.revision, to: after.revision }).expect(200)
    assert.equal(compared.body.files.length, 1)
    assert.match(compared.body.files[0].before, /20mm/)
    assert.match(compared.body.files[0].after, /24mm/)
  } finally { await f.cleanup() }
})

test("history restore writes a new current revision and rejects stale restores", async () => {
  const f = await fixture(async () => circuit)
  try {
    const { body: project } = await request(f.app).post("/api/projects").send({ name: "Restore" }).expect(201)
    const initial = await request(f.app).get(`/api/projects/${project.id}/history`).expect(200)
    const originalRevision = initial.body.revisions[0].revision
    const file = await request(f.app).get(`/api/projects/${project.id}/files`).query({ path: project.entrypoint }).expect(200)
    const changed = await request(f.app).put(`/api/projects/${project.id}/files`).query({ path: project.entrypoint })
      .set("If-Match", file.body.revision).send({ content: "temporary source", revision: file.body.revision }).expect(200)
    const added = await request(f.app).put(`/api/projects/${project.id}/files`).query({ path: "notes.txt" })
      .set("If-Match", changed.body.revision).send({ content: "new file", revision: changed.body.revision }).expect(200)
    const restored = await request(f.app).post(`/api/projects/${project.id}/history/${originalRevision}/restore`)
      .set("If-Match", added.body.revision).expect(200)
    assert.equal(restored.body.restoredFrom, originalRevision)
    assert.notEqual(restored.body.revision, changed.body.revision)
    const source = await request(f.app).get(`/api/projects/${project.id}/files`).query({ path: project.entrypoint }).expect(200)
    assert.match(source.body.content, /<board/)
    const files = await request(f.app).get(`/api/projects/${project.id}/file-list`).expect(200)
    assert.equal(files.body.includes("notes.txt"), false)
    await request(f.app).post(`/api/projects/${project.id}/history/${originalRevision}/restore`)
      .set("If-Match", added.body.revision).expect(409)
    const unchanged = await request(f.app).get(`/api/projects/${project.id}/files`).query({ path: project.entrypoint }).expect(200)
    assert.equal(unchanged.body.content, source.body.content)
  } finally { await f.cleanup() }
})

test("history retains the newest 50 snapshots and reports per-revision storage size", async () => {
  const f = await fixture(async () => circuit)
  try {
    const { body: project } = await request(f.app).post("/api/projects").send({ name: "Retention" }).expect(201)
    const originalRevision = project.revision
    let revision = project.revision
    for (let index = 0; index < 50; index++) {
      const result = await request(f.app).put(`/api/projects/${project.id}/files`).query({ path: project.entrypoint })
        .set("If-Match", revision).send({ content: `revision ${index}`, revision }).expect(200)
      revision = result.body.revision
    }
    const history = await request(f.app).get(`/api/projects/${project.id}/history`).expect(200)
    assert.equal(history.body.revisions.length, 50)
    assert.equal(history.body.revisions[0].revision, revision)
    assert.equal(history.body.revisions.some((item: { revision: string }) => item.revision === originalRevision), false)
    assert.ok(history.body.revisions.every((item: { sizeBytes: number }) => item.sizeBytes > 0))
    await request(f.app).get(`/api/projects/${project.id}/history/compare`).query({ from: originalRevision, to: revision }).expect(404)
  } finally { await f.cleanup() }
})

test("project history remains available after the server restarts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "circuits-history-restart-"))
  const firstApp = createApp({ projectsDir: root, buildCircuit: async () => circuit, watchFiles: false })
  let restartedApp: ReturnType<typeof createApp> | undefined
  try {
    const { body: project } = await request(firstApp).post("/api/projects").send({ name: "Persistent history" }).expect(201)
    const source = await request(firstApp).get(`/api/projects/${project.id}/files`).query({ path: project.entrypoint }).expect(200)
    const saved = await request(firstApp).put(`/api/projects/${project.id}/files`).query({ path: project.entrypoint })
      .set("If-Match", source.body.revision).send({ content: "restart snapshot", revision: source.body.revision }).expect(200)
    await (firstApp.locals.projectService as { close: () => Promise<void> }).close()

    restartedApp = createApp({ projectsDir: root, buildCircuit: async () => circuit, watchFiles: false })
    const history = await request(restartedApp).get(`/api/projects/${project.id}/history`).expect(200)
    assert.equal(history.body.revisions.length, 2)
    assert.equal(history.body.revisions[0].revision, saved.body.revision)
  } finally {
    if (restartedApp) await (restartedApp.locals.projectService as { close: () => Promise<void> }).close()
    else await (firstApp.locals.projectService as { close: () => Promise<void> }).close()
    await rm(root, { recursive: true, force: true })
  }
})

test("failed builds expose diagnostics and keep the most recent successful Circuit JSON", async () => {
  let shouldFail = false
  const f = await fixture(async () => {
    if (shouldFail) throw new Error("index.tsx:3:5: broken connection")
    return circuit
  })
  try {
    const { body: project } = await request(f.app).post("/api/projects").send({ name: "Preview" }).expect(201)
    await waitForBuild(f.app, project.id, "ready")
    const preview = await request(f.app)
      .get("/api/projects/" + project.id + "/preview").query({ kind: "pcb" }).expect(200)
    assert.deepEqual(preview.body.circuitJson, circuit)

    shouldFail = true
    const build = await request(f.app).post("/api/projects/" + project.id + "/build").expect(202)
    await waitForBuild(f.app, project.id, "failed")
    const failed = await request(f.app).get("/api/projects/" + project.id).expect(200)
    assert.equal(failed.body.lastBuild.status, "failed")
    assert.match(failed.body.lastBuild.diagnostics[0].message, /broken connection/)
    const stillAvailable = await request(f.app)
      .get("/api/projects/" + project.id + "/preview").query({ kind: "schematic" }).expect(200)
    assert.deepEqual(stillAvailable.body.circuitJson, circuit)
    assert.equal(stillAvailable.body.revision, preview.body.revision)
    assert.ok(build.body.buildId)
  } finally {
    await f.cleanup()
  }
})

test("simulation endpoint returns retained tscircuit waveforms with net correlation", async () => {
  const simulatedCircuit = [
    { type: "simulation_experiment", simulation_experiment_id: "e1", name: "Transient", experiment_type: "transient" },
    { type: "simulation_voltage_probe", simulation_voltage_probe_id: "p1", name: "OUT", signal_input_source_net_id: "net1" },
    { type: "simulation_transient_voltage_graph", simulation_transient_voltage_graph_id: "g1", simulation_experiment_id: "e1", timestamps_ms: [0, 1], voltage_levels: [0, 5], time_per_step: 1, start_time_ms: 0, end_time_ms: 1 },
    { type: "simulation_oscilloscope_trace", simulation_oscilloscope_trace_id: "t1", simulation_transient_voltage_graph_id: "g1", simulation_voltage_probe_id: "p1" },
  ]
  const f = await fixture(async () => simulatedCircuit)
  try {
    const { body: project } = await request(f.app).post("/api/projects").send({ name: "Simulation" }).expect(201)
    await waitForBuild(f.app, project.id, "ready")
    const result = await request(f.app).get(`/api/projects/${project.id}/simulation`).expect(200)
    assert.equal(result.body.status, "complete")
    assert.equal(result.body.signals[0].netId, "net1")
    assert.deepEqual(result.body.signals[0].samples, [{ x: 0, y: 0 }, { x: 1, y: 5 }])
  } finally { await f.cleanup() }
})

test("new projects build Circuit JSON through the documented tscircuit CLI", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "circuits-cli-integration-"))
  const app = createApp({ projectsDir: root, watchFiles: false, buildExecutionMode: "trusted-local" })
  try {
    const { body: project } = await request(app).post("/api/projects").send({ name: "CLI smoke" }).expect(201)
    await waitForBuild(app, project.id, "ready", 1200, 100)
    const result = await request(app).get("/api/projects/" + project.id + "/preview")
      .query({ kind: "pcb" }).expect(200)
    assert.ok(Array.isArray(result.body.circuitJson))
    assert.equal(result.body.revision, project.revision)
    assert.ok(result.body.circuitJson.some((item: { type?: string }) => item.type === "pcb_board"))
  } finally {
    await (app.locals.projectService as { close: () => Promise<void> }).close()
    await rm(root, { recursive: true, force: true })
  }
})

test("default builds fail closed without the runner and do not expose app node_modules", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "circuits-isolated-default-"))
  const app = createApp({ projectsDir: root, watchFiles: false })
  try {
    const { body: project } = await request(app).post("/api/projects").send({ name: "Isolated by default" }).expect(201)
    const result = await waitForBuild(app, project.id, "failed")
    assert.match(result.diagnostics[0]?.message ?? "", /BUILD_RUNNER_TOKEN/)
    await assert.rejects(lstat(path.join(root, project.id, "node_modules")))
  } finally {
    await (app.locals.projectService as { close: () => Promise<void> }).close()
    await rm(root, { recursive: true, force: true })
  }
})

test("production mode refuses trusted-local project builds", () => {
  const previous = process.env.NODE_ENV
  process.env.NODE_ENV = "production"
  try {
    assert.throws(() => createApp({ projectsDir: "/tmp/not-created", watchFiles: false, buildExecutionMode: "trusted-local" }), /disabled in production/)
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previous
  }
})

test("default app builds send a bounded source snapshot to the isolated runner", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "circuits-isolated-runner-"))
  let requestBody = ""
  let requestAuthorization = ""
  const runner = createServer((incoming, response) => {
    requestAuthorization = incoming.headers.authorization ?? ""
    incoming.on("data", (chunk) => { requestBody += chunk.toString("utf8") })
    incoming.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ circuitJson: circuit, isolation: "gvisor", runtime: "runsc" }))
    })
  })
  await new Promise<void>((resolve) => runner.listen(0, "127.0.0.1", resolve))
  const address = runner.address()
  assert.ok(address && typeof address !== "string")
  const token = "app-test-runner-token-with-more-than-32-bytes"
  const app = createApp({ projectsDir: root, watchFiles: false, buildRunner: { url: `http://127.0.0.1:${address.port}`, token } })
  try {
    const { body: project } = await request(app).post("/api/projects").send({ name: "Remote build" }).expect(201)
    await waitForBuild(app, project.id, "ready")
    assert.equal(requestAuthorization, `Bearer ${token}`)
    assert.equal(JSON.parse(requestBody).entrypoint, "index.circuit.tsx")
    assert.ok(JSON.parse(requestBody).files.some((file: { path: string }) => file.path === "index.circuit.tsx"))
    await assert.rejects(lstat(path.join(root, project.id, "node_modules")))
  } finally {
    await (app.locals.projectService as { close: () => Promise<void> }).close()
    await new Promise<void>((resolve) => runner.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

test("the server does not report its own atomic file write as an external edit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "circuits-watch-"))
  const app = createApp({ projectsDir: root, buildCircuit: async () => circuit })
  try {
    const { body: project } = await request(app).post("/api/projects").send({ name: "Watched" }).expect(201)
    const read = await request(app).get("/api/projects/" + project.id + "/files").query({ path: project.entrypoint }).expect(200)
    const saved = await request(app).put("/api/projects/" + project.id + "/files")
      .query({ path: project.entrypoint }).set("If-Match", read.body.revision)
      .send({ content: "updated source", revision: read.body.revision }).expect(200)
    await new Promise((resolve) => setTimeout(resolve, 500))
    const current = await request(app).get("/api/projects/" + project.id + "/files")
      .query({ path: project.entrypoint }).expect(200)
    assert.equal(current.body.revision, saved.body.revision)
    const historyBeforeExternalEdit = await request(app).get(`/api/projects/${project.id}/history`).expect(200)
    assert.equal(historyBeforeExternalEdit.body.revisions.length, 2)
    await writeFile(path.join(root, project.id, project.entrypoint), "outside update", "utf8")
    await new Promise((resolve) => setTimeout(resolve, 500))
    const historyAfterExternalEdit = await request(app).get(`/api/projects/${project.id}/history`).expect(200)
    assert.equal(historyAfterExternalEdit.body.revisions.length, 3)
    assert.deepEqual(historyAfterExternalEdit.body.revisions[0].changedFiles, [project.entrypoint])
  } finally {
    await (app.locals.projectService as { close: () => Promise<void> }).close()
    await rm(root, { recursive: true, force: true })
  }
})

test("health endpoint reports readiness", async () => {
  const f = await fixture(async () => circuit)
  try {
    await request(f.app).get("/healthz").expect(200, { status: "ok" })
  } finally {
    await f.cleanup()
  }
})

test("shared workbench auth protects browser and REST routes while leaving health checks public", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "circuits-auth-"))
  const token = "a".repeat(64)
  const app = createApp({ projectsDir: root, watchFiles: false, workbenchAuthToken: token })
  try {
    await request(app).get("/healthz").expect(200)
    const denied = await request(app).get("/api/projects").expect(401)
    assert.match(denied.headers["www-authenticate"] ?? "", /Basic realm="Wattful-Iron"/)
    await request(app).get("/api/projects").set("Authorization", "Bearer wrong").expect(401)
    await request(app).get("/api/projects").auth("workbench", token).expect(200)
    await request(app).get("/api/projects").set("Authorization", `Bearer ${token}`).expect(200)
  } finally {
    await (app.locals.projectService as { close: () => Promise<void> }).close()
    await rm(root, { recursive: true, force: true })
  }
})

test("workbench auth rejects secrets shorter than 32 bytes", () => {
  assert.throws(() => createApp({ projectsDir: "/tmp/not-created", watchFiles: false, workbenchAuthToken: "too-short" }), /at least 32 bytes/)
})

async function waitForBuild(app: import("express").Express, id: string, status: "ready" | "failed", maxAttempts = 100, intervalMs = 10) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = await request(app).get("/api/projects/" + id)
    if (result.body.lastBuild?.status === status) return result.body.lastBuild as { diagnostics: Array<{ message: string }> }
    if (result.body.lastBuild?.status === "failed") assert.fail("build failed: " + JSON.stringify(result.body.lastBuild.diagnostics))
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  assert.fail("build did not reach " + status)
}
