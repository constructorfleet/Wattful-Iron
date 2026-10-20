import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import request from "supertest"
import { createApp } from "./app.js"

test("example circuits build with their expected PCB geometry and electrical routing", async () => {
  const projectsDir = await mkdtemp(path.join(tmpdir(), "circuits-examples-http-"))
  const app = createApp({ projectsDir, watchFiles: false, buildExecutionMode: "trusted-local" })
  try {
    for (const example of ["blank-board", "manufacturing-board", "footprint-comparison", "mounting-pattern", "led-indicator", "voltage-divider"]) {
      const { body: project } = await request(app).post("/api/projects")
        .send({ name: example, templateId: example }).expect(201)
      const built = await waitForBuild(app, project.id, project.revision)
      const circuit = await request(app).get(`/api/projects/${project.id}/preview`).query({ kind: "pcb" }).expect(200)
      const elements = circuit.body.circuitJson as Array<{ type: string }>
      assert.ok(elements.some((element) => element.type === "pcb_board"), `${example} has no PCB board`)
      const minComponents = example === "blank-board" ? 0 : example === "manufacturing-board" ? 2 : 3
      assert.ok(elements.filter((element) => element.type === "pcb_component").length >= minComponents, `${example} has too few placed components`)
      assert.equal(built.status, "ready")
      if (example === "led-indicator" || example === "voltage-divider") {
        const components = elements.filter((element) => element.type === "source_component") as Array<{ name?: string }>
        const expectedComponents = example === "led-indicator" ? ["J1", "R1", "D1"] : ["J1", "R1", "R2", "C1"]
        const logicalTraces = elements.filter((element) => element.type === "source_trace") as Array<{ name?: string; connected_source_port_ids?: string[]; source_trace_id?: string }>
        const pcbTraces = elements.filter((element) => element.type === "pcb_trace") as Array<{ source_trace_id?: string; route?: unknown[] }>
        for (const name of expectedComponents) assert.ok(components.some((component) => component.name === name), `${example} should include ${name}`)
        const expectedNets = example === "led-indicator" ? ["VCC", "LED_CURRENT", "GND"] : ["VCC", "SENSE", "GND"]
        for (const name of expectedNets) assert.ok(logicalTraces.some((trace) => trace.name === name), `${example} should expose a ${name} net`)
        assert.ok(logicalTraces.length >= 3, `${example} should define multiple logical connections`)
        assert.ok(logicalTraces.every((trace) => (trace.connected_source_port_ids?.length ?? 0) >= 2), `${example} traces should join component ports`)
        assert.ok(pcbTraces.length >= 3, `${example} should produce visible routed PCB traces`)
        assert.ok(pcbTraces.every((trace) => trace.route && trace.route.length >= 2 && logicalTraces.some((source) => source.source_trace_id === trace.source_trace_id)), `${example} PCB routes should map to named logical traces`)
      }
    }
  } finally {
    await (app.locals.projectService as { close(): Promise<void> }).close()
    await rm(projectsDir, { recursive: true, force: true })
  }
})

test("custom board outline source produces the requested PCB edge geometry", async () => {
  const projectsDir = await mkdtemp(path.join(tmpdir(), "circuits-board-outline-http-"))
  const app = createApp({ projectsDir, watchFiles: false, buildExecutionMode: "trusted-local" })
  const outline = [{ x: -10, y: -6 }, { x: 10, y: -6 }, { x: 7, y: 6 }, { x: -10, y: 6 }]
  try {
    const { body: project } = await request(app).post("/api/projects").send({ name: "Custom outline" }).expect(201)
    const file = await request(app).get(`/api/projects/${project.id}/files`).query({ path: project.entrypoint }).expect(200)
    const source = `export default () => <board outline={${JSON.stringify(outline)}} />`
    const saved = await request(app).put(`/api/projects/${project.id}/files`).query({ path: project.entrypoint })
      .set("If-Match", file.body.revision).send({ content: source, revision: file.body.revision }).expect(200)
    await request(app).post(`/api/projects/${project.id}/build`).send().expect(202)
    const built = await waitForBuild(app, project.id, saved.body.revision)
    assert.equal(built.status, "ready")
    const { body: preview } = await request(app).get(`/api/projects/${project.id}/preview`).query({ kind: "pcb" }).expect(200)
    const board = (preview.circuitJson as Array<{ type: string; outline?: typeof outline }>).find((element) => element.type === "pcb_board")
    assert.deepEqual(board?.outline, outline)
  } finally {
    await (app.locals.projectService as { close(): Promise<void> }).close()
    await rm(projectsDir, { recursive: true, force: true })
  }
})

async function waitForBuild(app: import("express").Express, id: string, revision: string) {
  for (let attempt = 0; attempt < 1200; attempt++) {
    const { body: project } = await request(app).get(`/api/projects/${id}`).expect(200)
    if (project.lastBuild?.revision === revision && project.lastBuild.status === "ready") return project.lastBuild
    if (project.lastBuild?.revision === revision && project.lastBuild.status === "failed") {
      assert.fail(JSON.stringify(project.lastBuild.diagnostics))
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.fail("project build did not finish")
}
