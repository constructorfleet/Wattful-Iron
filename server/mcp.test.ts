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
    assert.ok(tools.tools.some((tool) => tool.name === "check_manufacturability"))
    const created = await client.callTool({ name: "create_project", arguments: { name: "MCP board" } })
    assert.equal(created.isError, undefined)
    const payload = JSON.parse(created.content.find((item) => item.type === "text")?.text ?? "null")
    assert.equal(payload.name, "MCP board")
    const listed = await client.callTool({ name: "list_projects", arguments: {} })
    const projects = JSON.parse(listed.content.find((item) => item.type === "text")?.text ?? "null")
    assert.deepEqual(projects.map((project: { id: string }) => project.id), [payload.id])
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
