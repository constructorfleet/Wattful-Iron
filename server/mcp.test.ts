import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import request from "supertest"
import { createApp } from "./app.js"

const TOKEN = "test-mcp-secret"

test("MCP endpoint rejects requests without a valid bearer token", async () => {
  const fixture = await makeFixture()
  try {
    await request(fixture.app).post("/mcp").send({}).expect(401)
    await request(fixture.app).post("/mcp").set("Authorization", "Bearer wrong").send({}).expect(401)
  } finally {
    await fixture.cleanup()
  }
})

test("MCP clients can list and create projects through registered tools", async () => {
  const fixture = await makeFixture()
  const server = createServer(fixture.app)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const client = new Client({ name: "circuits-workbench-test", version: "1.0.0" })
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  })
  try {
    await client.connect(transport)
    const tools = await client.listTools()
    assert.ok(tools.tools.some((tool) => tool.name === "list_projects"))
    assert.ok(tools.tools.some((tool) => tool.name === "duplicate_project"))
    assert.ok(tools.tools.some((tool) => tool.name === "check_manufacturability"))
    assert.ok(tools.tools.some((tool) => tool.name === "get_manufacturing_package"))
    assert.ok(tools.tools.some((tool) => tool.name === "check_connectivity"))
    const created = await client.callTool({ name: "create_project", arguments: { name: "MCP board" } })
    assert.equal(created.isError, undefined)
    const payload = JSON.parse(created.content.find((item) => item.type === "text")?.text ?? "null")
    assert.equal(payload.name, "MCP board")
    const duplicated = await client.callTool({ name: "duplicate_project", arguments: { projectId: payload.id, name: "MCP board copy", revision: payload.revision } })
    assert.equal(duplicated.isError, undefined)
    const copy = JSON.parse(duplicated.content.find((item) => item.type === "text")?.text ?? "null")
    assert.equal(copy.name, "MCP board copy")
    assert.notEqual(copy.id, payload.id)
    const listed = await client.callTool({ name: "list_projects", arguments: {} })
    const projects = JSON.parse(listed.content.find((item) => item.type === "text")?.text ?? "null")
    assert.deepEqual(projects.map((project: { id: string }) => project.id).sort(), [copy.id, payload.id].sort())
    const packageReference = readResult<{ method: string; path: string; contentType: string; generatedBy: string }>(await client.callTool({
      name: "get_manufacturing_package", arguments: { projectId: payload.id, profile: "jlcpcb-2layer-1oz" },
    }))
    assert.equal(packageReference.method, "GET")
    assert.equal(packageReference.path, `/api/projects/${payload.id}/manufacturing.zip?profile=jlcpcb-2layer-1oz`)
    assert.equal(packageReference.contentType, "application/zip")
    assert.equal(packageReference.generatedBy, "preflight-gated manufacturing download route")
  } finally {
    await client.close()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await fixture.cleanup()
  }
})

test("MCP exposes read-only inspection of components, nets, pins, routes, and board properties", async () => {
  const circuitJson = [
    { type: "pcb_board", pcb_board_id: "pcb_board_0", width: 24, height: 12, thickness: 1.4, num_layers: 2, material: "fr4" },
    { type: "source_component", source_component_id: "source_component_0", name: "J1", ftype: "simple_connector", pin_count: 2 },
    { type: "source_component", source_component_id: "source_component_1", name: "R1", ftype: "simple_resistor", resistance: 1000, display_resistance: "1kΩ" },
    { type: "source_port", source_port_id: "source_port_0", source_component_id: "source_component_0", name: "VCC", pin_number: 1, port_hints: ["VCC", "pin1", "1"], subcircuit_connectivity_map_key: "net0" },
    { type: "source_port", source_port_id: "source_port_1", source_component_id: "source_component_1", name: "pin1", pin_number: 1, port_hints: ["pin1", "1"], subcircuit_connectivity_map_key: "net0" },
    { type: "source_port", source_port_id: "source_port_2", source_component_id: "source_component_1", name: "pin2", pin_number: 2, port_hints: ["pin2", "2"], subcircuit_connectivity_map_key: "net1" },
    { type: "source_port", source_port_id: "source_port_3", source_component_id: "source_component_0", name: "NC", pin_number: 2 },
    { type: "source_trace", source_trace_id: "source_trace_0", name: "VCC", connected_source_port_ids: ["source_port_0", "source_port_1"], connected_source_net_ids: [] },
    { type: "source_trace", source_trace_id: "source_trace_1", name: "GND", connected_source_port_ids: ["source_port_2", "source_port_404"], connected_source_net_ids: [] },
    { type: "pcb_component", pcb_component_id: "pcb_component_0", source_component_id: "source_component_1", center: { x: 2, y: 3 }, width: 1, height: 1, rotation: 90, layer: "top" },
    { type: "pcb_trace", pcb_trace_id: "pcb_trace_0", source_trace_id: "source_trace_0", route: [{ route_type: "wire", x: 1, y: 2, width: 0.15, layer: "top" }] },
  ]
  const fixture = await makeFixture(async () => circuitJson)
  const server = createServer(fixture.app)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const client = new Client({ name: "circuits-workbench-test", version: "1.0.0" })
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  })
  try {
    await client.connect(transport)
    const project = readResult<Project>(await client.callTool({ name: "create_project", arguments: { name: "Inspect board" } }))
    await waitForToolStatus(client, project.id, "ready")
    const components = readResult<Array<{ name: string; pcb?: { center: { x: number; y: number } } }>>(await client.callTool({ name: "list_components", arguments: { projectId: project.id } }))
    assert.equal(components.length, 2)
    assert.deepEqual(components.find(({ name }) => name === "R1")?.pcb?.center, { x: 2, y: 3 })
    const component = readResult<{ source_component_id: string; name: string; pcb: { center: { x: number; y: number } }; pins: Array<{ name: string; connections: Array<{ name: string }> }> }>(await client.callTool({ name: "get_component", arguments: { projectId: project.id, component: "R1" } }))
    assert.equal(component.source_component_id, "source_component_1")
    assert.deepEqual(component.pcb.center, { x: 2, y: 3 })
    assert.deepEqual(component.pins.map(({ name, connections }) => [name, connections.map(({ name }) => name)]), [["pin1", ["VCC"]], ["pin2", ["GND"]]])
    const byId = readResult<{ name: string }>(await client.callTool({ name: "get_component", arguments: { projectId: project.id, component: "source_component_1" } }))
    assert.equal(byId.name, "R1")
    const missingComponent = await client.callTool({ name: "get_component", arguments: { projectId: project.id, component: "U404" } })
    assert.equal(missingComponent.isError, true)
    assert.match(missingComponent.content.map((item) => item.type === "text" ? item.text : "").join("\n"), /No Circuit JSON source_component matches 'U404'/)
    const rawCircuit = readResult<{ revision: string; circuitJson: unknown }>(await client.callTool({ name: "get_circuit_json", arguments: { projectId: project.id } }))
    const revisionPreview = readResult<{ revision: string }>(await client.callTool({ name: "get_preview", arguments: { projectId: project.id, kind: "pcb" } }))
    assert.equal(rawCircuit.revision, revisionPreview.revision)
    assert.deepEqual(rawCircuit.circuitJson, circuitJson)
    const nets = readResult<Array<{ id: string; name: string; ports: string[] }>>(await client.callTool({ name: "list_nets", arguments: { projectId: project.id } }))
    assert.deepEqual(nets.map(({ name }) => name), ["VCC", "GND"])
    assert.deepEqual(nets[0]?.ports, ["source_port_0", "source_port_1"])
    const trace = readResult<Array<{ sourceTrace: { source_trace_id: string }; pcbTraces: unknown[] }>>(await client.callTool({ name: "trace_net", arguments: { projectId: project.id, net: "VCC" } }))
    assert.equal(trace[0]?.sourceTrace.source_trace_id, "source_trace_0")
    assert.equal(trace[0]?.pcbTraces.length, 1)
    const pins = readResult<Array<{ name: string; connectedNets: string[] }>>(await client.callTool({ name: "get_pin_connections", arguments: { projectId: project.id, component: "R1" } }))
    assert.deepEqual(pins.map(({ name, connectedNets }) => [name, connectedNets]), [["pin1", ["VCC"]], ["pin2", ["GND"]]])
    const board = readResult<Array<{ width: number; height: number; num_layers: number }>>(await client.callTool({ name: "get_board_properties", arguments: { projectId: project.id } }))
    assert.deepEqual([board[0]?.width, board[0]?.height, board[0]?.num_layers], [24, 12, 2])
    const connectivity = readResult<{ revision: string; componentCount: number; portCount: number; connectedPortCount: number; unconnectedPorts: Array<{ source_port_id: string; source_component_name: string; name: string }>; danglingPortIds: string[] }>(await client.callTool({
      name: "check_connectivity", arguments: { projectId: project.id },
    }))
    assert.equal(connectivity.revision, rawCircuit.revision)
    assert.equal(connectivity.componentCount, 2)
    assert.equal(connectivity.portCount, 4)
    assert.equal(connectivity.connectedPortCount, 3)
    assert.deepEqual(connectivity.unconnectedPorts.map(({ source_port_id, source_component_name, name }) => [source_port_id, source_component_name, name]), [["source_port_3", "J1", "NC"]])
    assert.deepEqual(connectivity.danglingPortIds, ["source_port_404"])
  } finally {
    await client.close()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await fixture.cleanup()
  }
})

test("MCP reads and validates versioned project requirements", async () => {
  const fixture = await makeFixture(async () => [
    { type: "pcb_board", width: 50, height: 35, num_layers: 4 },
    { type: "source_component", name: "U1" },
    { type: "source_trace", name: "GND", connected_source_port_ids: ["port-1", "port-2"] },
  ])
  const server = createServer(fixture.app)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const client = new Client({ name: "circuits-workbench-test", version: "1.0.0" })
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  })
  try {
    await client.connect(transport)
    const project = readResult<Project>(await client.callTool({ name: "create_project", arguments: { name: "Requirements board" } }))
    await waitForToolStatus(client, project.id, "ready")
    const initial = readResult<{ revision: string }>(await client.callTool({ name: "get_project", arguments: { projectId: project.id } }))
    await client.callTool({ name: "update_project_file", arguments: {
      projectId: project.id, path: "requirements.json", revision: initial.revision,
      content: JSON.stringify({ version: 1, requirements: { board: { width_mm: 50, height_mm: 35, layers: 4 }, components: ["U1"], nets: ["GND", "SDA"], power: { voltage: 5 } } }),
    } })
    const build = readResult<{ status: string }>(await client.callTool({ name: "build_project", arguments: { projectId: project.id } }))
    assert.equal(build.status, "ready")
    const requirements = readResult<{ configured: boolean; requirements: { requirements: { board: { width_mm: number } } } }>(await client.callTool({ name: "get_project_requirements", arguments: { projectId: project.id } }))
    assert.equal(requirements.configured, true)
    assert.equal(requirements.requirements.requirements.board.width_mm, 50)
    const validation = readResult<{ stale: boolean; checks: Array<{ id: string; status: string }> }>(await client.callTool({ name: "validate_project_requirements", arguments: { projectId: project.id } }))
    assert.equal(validation.stale, false)
    assert.deepEqual(validation.checks.map(({ status }) => status), ["pass", "pass", "pass", "pass", "pass", "fail", "not-evaluated"])
  } finally {
    await client.close()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await fixture.cleanup()
  }
})

test("MCP tools use revision checks and return build and preview data", async () => {
  const fixture = await makeFixture()
  const server = createServer(fixture.app)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const client = new Client({ name: "circuits-workbench-test", version: "1.0.0" })
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  })
  try {
    await client.connect(transport)
    const create = await client.callTool({ name: "create_project", arguments: { name: "Editable board" } })
    const project = readResult<Project>(create)
    const file = readResult<{ path: string; content: string; revision: string }>(await client.callTool({
      name: "read_project_file", arguments: { projectId: project.id, path: project.entrypoint },
    }))
    const saved = readResult<{ path: string; revision: string }>(await client.callTool({
      name: "update_project_file", arguments: { projectId: project.id, path: file.path, content: "export default () => null", revision: file.revision },
    }))
    assert.notEqual(saved.revision, file.revision)
    const stale = await client.callTool({
      name: "update_project_file", arguments: { projectId: project.id, path: file.path, content: "stale", revision: file.revision },
    })
    assert.equal(stale.isError, true)
    const build = readResult<{ status: string; revision: string; diagnostics: unknown[] }>(await client.callTool({
      name: "build_project", arguments: { projectId: project.id },
    }))
    assert.equal(build.status, "ready")
    const preview = readResult<{ kind: string; circuitJson: unknown }>(await client.callTool({
      name: "get_preview", arguments: { projectId: project.id, kind: "pcb" },
    }))
    assert.equal(preview.kind, "pcb")
    assert.deepEqual(preview.circuitJson, [{ type: "source_component", name: "fixture" }])
    const diagnostics = readResult<{ status: string }>(await client.callTool({
      name: "get_diagnostics", arguments: { projectId: project.id },
    }))
    assert.equal(diagnostics.status, "ready")
    const simulation = readResult<{ status: string; revision: string }>(await client.callTool({
      name: "get_simulation_results", arguments: { projectId: project.id },
    }))
    assert.equal(simulation.status, "not_configured")
    assert.equal(simulation.revision, build.revision)
    const manufacturing = readResult<{ ready: boolean; revision: string; checks: Array<{ id: string; status: string }> }>(await client.callTool({
      name: "check_manufacturability", arguments: { projectId: project.id },
    }))
    assert.equal(manufacturing.ready, false)
    assert.equal(manufacturing.revision, build.revision)
    assert.equal(manufacturing.checks.find((check) => check.id === "board")?.status, "fail")
  } finally {
    await client.close()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await fixture.cleanup()
  }
})

test("MCP endpoint is disabled when its bearer token is not configured", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "circuits-mcp-closed-"))
  const app = createApp({ projectsDir: root, watchFiles: false, mcpAuthToken: "" })
  try {
    await request(app).post("/mcp").set("Authorization", "Bearer anything").send({}).expect(503, { error: "MCP_AUTH_TOKEN must be configured" })
  } finally {
    await (app.locals.projectService as { close: () => Promise<void> }).close()
    await rm(root, { recursive: true, force: true })
  }
})

test("MCP build failures return diagnostics and keep diagnostics queryable", async () => {
  let failBuild = false
  const fixture = await makeFixture(async () => {
    if (failBuild) throw new Error("index.circuit.tsx:7:4: disconnected pin")
    return [{ type: "source_component", name: "fixture" }]
  })
  const server = createServer(fixture.app)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const client = new Client({ name: "circuits-workbench-test", version: "1.0.0" })
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  })
  try {
    await client.connect(transport)
    const project = readResult<Project>(await client.callTool({ name: "create_project", arguments: { name: "Diagnostic board" } }))
    await waitForToolStatus(client, project.id, "ready")
    failBuild = true
    const build = await client.callTool({ name: "build_project", arguments: { projectId: project.id } })
    assert.equal(build.isError, true)
    assert.match(build.content.map((item) => item.type === "text" ? item.text : "").join("\n"), /disconnected pin/)
    const diagnostics = readResult<{ status: string; diagnostics: Array<{ line: number; message: string }> }>(await client.callTool({
      name: "get_diagnostics", arguments: { projectId: project.id },
    }))
    assert.equal(diagnostics.status, "failed")
    assert.equal(diagnostics.diagnostics[0]?.line, 7)
    assert.match(diagnostics.diagnostics[0]?.message ?? "", /disconnected pin/)
  } finally {
    await client.close()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await fixture.cleanup()
  }
})

test("MCP build request completes when the automatic initial build is already running", async () => {
  let resolveFirstBuild!: () => void
  let markFirstStarted!: () => void
  const firstBuildStarted = new Promise<void>((resolve) => { markFirstStarted = resolve })
  const firstBuildGate = new Promise<void>((resolve) => { resolveFirstBuild = resolve })
  let buildCount = 0
  const fixture = await makeFixture(async () => {
    buildCount += 1
    if (buildCount === 1) {
      markFirstStarted()
      await firstBuildGate
    }
    return [{ type: "source_component", name: "fixture" }]
  })
  const server = createServer(fixture.app)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const client = new Client({ name: "circuits-workbench-test", version: "1.0.0" })
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  })
  try {
    await client.connect(transport)
    const project = readResult<Project>(await client.callTool({ name: "create_project", arguments: { name: "Concurrent build" } }))
    await firstBuildStarted
    const initial = readResult<{ lastBuild?: { buildId: string } }>(await client.callTool({ name: "get_project", arguments: { projectId: project.id } }))
    assert.ok(initial.lastBuild)
    const buildPromise = client.callTool({ name: "build_project", arguments: { projectId: project.id } })
    await waitForDifferentBuild(client, project.id, initial.lastBuild.buildId)
    resolveFirstBuild()
    const result = await Promise.race([
      buildPromise,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("queued build did not finish")), 2_000)),
    ])
    assert.equal(result.isError, undefined)
    assert.equal(readResult<{ status: string }>(result).status, "ready")
  } finally {
    resolveFirstBuild()
    await client.close()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await fixture.cleanup()
  }
})

async function makeFixture(buildCircuit: (projectDir: string) => Promise<unknown> = async () => [{ type: "source_component", name: "fixture" }]) {
  const root = await mkdtemp(path.join(tmpdir(), "circuits-mcp-"))
  const app = createApp({
    projectsDir: root,
    watchFiles: false,
    mcpAuthToken: TOKEN,
    buildCircuit,
  })
  return {
    app,
    cleanup: async () => {
      await (app.locals.projectService as { close: () => Promise<void> }).close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

type Project = { id: string; entrypoint: string }
function readResult<T>(result: Awaited<ReturnType<Client["callTool"]>>) {
  assert.notEqual(result.isError, true, result.content.map((item) => item.type === "text" ? item.text : "").join("\n"))
  const text = result.content.find((item) => item.type === "text")
  assert.ok(text && text.type === "text")
  return JSON.parse(text.text) as T
}

async function waitForToolStatus(client: Client, id: string, status: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const project = readResult<{ lastBuild?: { status: string } }>(await client.callTool({ name: "get_project", arguments: { projectId: id } }))
    if (project.lastBuild?.status === status) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail(`project did not reach ${status}`)
}

async function waitForDifferentBuild(client: Client, id: string, previousBuildId: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const project = readResult<{ lastBuild?: { buildId: string } }>(await client.callTool({ name: "get_project", arguments: { projectId: id } }))
    if (project.lastBuild && project.lastBuild.buildId !== previousBuildId) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail("MCP build request was not accepted")
}
