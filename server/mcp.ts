import { createMcpHandler, McpServer, OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server"
import { requireBearerAuth, type OAuthTokenVerifier } from "@modelcontextprotocol/express"
import { toNodeHandler } from "@modelcontextprotocol/node"
import type { Express } from "express"
import { timingSafeEqual } from "node:crypto"
import { z } from "zod4"
import { getSimulationResults } from "./simulation.js"
import { checkManufacturability } from "./manufacturing.js"

type Project = {
  id: string
  name: string
  entrypoint: string
  revision: string
  lastBuild?: { buildId: string; revision: string; status: string; diagnostics: unknown[] }
}

type ProjectService = {
  list(): Promise<Project[]>
  create(name: string): Promise<Project>
  get(id: string): Promise<Project>
  getFileList(id: string): Promise<string[]>
  readFile(id: string, relativePath: string): Promise<{ path: string; content: string; revision: string }>
  writeFile(id: string, relativePath: string, content: string, revision: string): Promise<{ path: string; revision: string }>
  requestBuild(id: string): { buildId: string; status: string }
  preview(id: string): Promise<{ revision: string; circuitJson: unknown }>
  onClose(close: () => Promise<void>): void
}

const projectId = z.string().uuid()
const toolError = (error: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: error instanceof Error ? error.message : JSON.stringify(error, null, 2) ?? String(error) }],
})

export function mountMcp(app: Express, service: ProjectService, configuredToken?: string) {
  if (!configuredToken) {
    app.all("/mcp", (_request, response) => response.status(503).json({ error: "MCP_AUTH_TOKEN must be configured" }))
    return
  }

  const verifier: OAuthTokenVerifier = {
    async verifyAccessToken(token) {
      if (!sameToken(token, configuredToken)) throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid bearer token")
      return {
        token,
        clientId: "local-workbench-client",
        scopes: [],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      }
    },
  }

  const mcpHandler = createMcpHandler(() => createServer(service), { onerror: (error) => console.error("MCP handler failed", error) })
  const handler = toNodeHandler(mcpHandler)
  service.onClose(() => mcpHandler.close())
  const auth = requireBearerAuth({ verifier })
  app.all("/mcp", auth, (request, response, next) => {
    void handler(request, response, request.body).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : new Error(String(error)))
        return
      }
      next(error)
    })
  })
}

function createServer(service: ProjectService): McpServer {
  const server = new McpServer({ name: "circuits-workbench", version: "0.2.0" })
  server.registerTool("list_projects", {
    title: "List projects",
    description: "List circuits projects available in this workbench.",
    inputSchema: z.object({}),
  }, async () => result(await service.list()))

  server.registerTool("create_project", {
    title: "Create project",
    description: "Create a project with a minimal editable tscircuit starter. The initial build is scheduled automatically.",
    inputSchema: z.object({ name: z.string().trim().min(1).max(100) }),
  }, async ({ name }) => result(await service.create(name)))

  server.registerTool("get_project", {
    title: "Get project",
    description: "Get project metadata, current revision, and latest build state.",
    inputSchema: z.object({ projectId }),
  }, async ({ projectId }) => safeTool(() => service.get(projectId)))

  server.registerTool("get_project_files", {
    title: "List project files",
    description: "List source and configuration files in a project.",
    inputSchema: z.object({ projectId }),
  }, async ({ projectId }) => safeTool(() => service.getFileList(projectId)))

  server.registerTool("read_project_file", {
    title: "Read project file",
    description: "Read a project file and its current project revision.",
    inputSchema: z.object({ projectId, path: z.string().min(1) }),
  }, async ({ projectId, path }) => safeTool(() => service.readFile(projectId, path)))

  server.registerTool("update_project_file", {
    title: "Update project file",
    description: "Write source using the revision returned by read_project_file. Stale revisions are rejected with a conflict.",
    inputSchema: z.object({ projectId, path: z.string().min(1), content: z.string(), revision: z.string().uuid() }),
  }, async ({ projectId, path, content, revision }) => safeTool(() => service.writeFile(projectId, path, content, revision)))

  server.registerTool("build_project", {
    title: "Build project",
    description: "Run the tscircuit CLI and wait for the build result and diagnostics.",
    inputSchema: z.object({ projectId }),
  }, async ({ projectId }) => {
    try {
      const build = service.requestBuild(projectId)
      const completed = await waitForBuild(service, projectId, build.buildId)
      return completed.status === "failed" ? toolError(completed) : result(completed)
    } catch (error) { return toolError(error) }
  })

  server.registerTool("get_diagnostics", {
    title: "Get build diagnostics",
    description: "Get diagnostics from the latest project build.",
    inputSchema: z.object({ projectId }),
  }, async ({ projectId }) => safeTool(async () => {
    const project = await service.get(projectId)
    return project.lastBuild ? { buildId: project.lastBuild.buildId, revision: project.lastBuild.revision, status: project.lastBuild.status, diagnostics: project.lastBuild.diagnostics } : { status: "idle", diagnostics: [] }
  }))

  server.registerTool("get_preview", {
    title: "Get project preview",
    description: "Get the most recent successfully built Circuit JSON for schematic, PCB, or 3D preview contexts.",
    inputSchema: z.object({ projectId, kind: z.enum(["schematic", "pcb", "3d"]) }),
  }, async ({ projectId, kind }) => safeTool(async () => ({ ...await service.preview(projectId), kind })))

  server.registerTool("run_simulation", {
    title: "Build and inspect simulation",
    description: "Build the current project with tscircuit, then return any supported SPICE simulation results and waveform diagnostics in its Circuit JSON.",
    inputSchema: z.object({ projectId }),
  }, async ({ projectId }) => {
    try {
      const build = service.requestBuild(projectId)
      const completed = await waitForBuild(service, projectId, build.buildId)
      if (completed.status !== "ready") return toolError(completed)
      return result({ ...getSimulationResults((await service.preview(projectId)).circuitJson), buildId: completed.buildId, revision: completed.revision })
    } catch (error) { return toolError(error) }
  })

  server.registerTool("get_simulation_results", {
    title: "Get simulation results",
    description: "Read supported SPICE waveforms and probe-to-net information from the most recent successful Circuit JSON build.",
    inputSchema: z.object({ projectId }),
  }, async ({ projectId }) => safeTool(async () => {
    const preview = await service.preview(projectId)
    return { revision: preview.revision, ...getSimulationResults(preview.circuitJson) }
  }))

  server.registerTool("check_manufacturability", {
    title: "Check manufacturing readiness",
    description: "Run the manufacturing completeness preflight against the latest successful Circuit JSON build. This does not perform ERC/DRC or fabricator-specific validation.",
    inputSchema: z.object({ projectId }),
  }, async ({ projectId }) => safeTool(async () => {
    const [project, preview] = await Promise.all([service.get(projectId), service.preview(projectId)])
    return {
      revision: preview.revision,
      ...checkManufacturability(
        preview.circuitJson,
        project.lastBuild ?? { status: "idle", revision: "" },
        preview.revision,
        project.revision,
      ),
    }
  }))


  return server
}

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] }
}

async function safeTool(read: () => Promise<unknown>) {
  try { return result(await read()) } catch (error) { return toolError(error) }
}

async function waitForBuild(service: ProjectService, id: string, buildId: string) {
  const expiresAt = Date.now() + 120_000
  while (Date.now() < expiresAt) {
    const project = await service.get(id)
    const build = project.lastBuild
    if (build?.buildId === buildId && (build.status === "ready" || build.status === "failed")) return build
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("Build did not finish within 120 seconds")
}

function sameToken(candidate: string, expected: string) {
  const candidateBytes = Buffer.from(candidate)
  const expectedBytes = Buffer.from(expected)
  return candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes)
}
