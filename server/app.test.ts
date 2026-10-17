import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
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

test("new projects build Circuit JSON through the documented tscircuit CLI", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "circuits-cli-integration-"))
  const app = createApp({ projectsDir: root, watchFiles: false })
  try {
    const { body: project } = await request(app).post("/api/projects").send({ name: "CLI smoke" }).expect(201)
    await waitForBuild(app, project.id, "ready", 500)
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

async function waitForBuild(app: import("express").Express, id: string, status: "ready" | "failed", maxAttempts = 100) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = await request(app).get("/api/projects/" + id)
    if (result.body.lastBuild?.status === status) return
    if (result.body.lastBuild?.status === "failed") assert.fail("build failed: " + JSON.stringify(result.body.lastBuild.diagnostics))
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail("build did not reach " + status)
}
