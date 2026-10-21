import { createMcpHandler, McpServer, OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server"
import { requireBearerAuth, type OAuthTokenVerifier } from "@modelcontextprotocol/express"
import { toNodeHandler } from "@modelcontextprotocol/node"
import type { Express } from "express"
import { timingSafeEqual } from "node:crypto"
import { z } from "zod4"
import { getSimulationResults } from "./simulation.js"
import { checkManufacturability } from "./manufacturing.js"
import { checkConnectivity, getBoardProperties, getComponent, getPinConnections, listComponents, listNets, traceNet } from "./circuit-inspection.js"
import { buildNetTraceIndex, findNet } from "./net-trace.js"
import { parseRequirements, validateRequirements } from "./requirements.js"
import type { AssertionReport } from "./assertions.js"
import { isReviewState, type ReviewState } from "./review-state.js"
import { moduleImportLine, type CircuitModule } from "./circuit-modules.js"
import { addComponent, connectComponents, listSourceComponents, removeComponent, setBoardDimensions, setComponentProperties } from "./circuit-source.js"
import { checkRouting, runDesignRuleCheck, runElectricalRuleCheck } from "./rule-checks.js"
import { analyzePower } from "./power-analysis.js"
import { estimateBomCost, listDesignParts, normalizeLcscPartNumber, type SourcingClient } from "./component-sourcing.js"

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
  duplicateProject(id: string, name: string, expectedRevision: string): Promise<Project>
  get(id: string): Promise<Project>
  getFileList(id: string): Promise<string[]>
  readFile(id: string, relativePath: string): Promise<{ path: string; content: string; revision: string }>
  writeFile(id: string, relativePath: string, content: string, revision: string): Promise<{ path: string; revision: string }>
  requestBuild(id: string): { buildId: string; status: string }
  listHistory(id: string): Promise<unknown>
  compareHistory(id: string, from: string, to: string): Promise<unknown>
  preview(id: string): Promise<{ revision: string; circuitJson: unknown }>
  onClose(close: () => Promise<void>): void
}

const projectId = z.string().uuid()
const propertyValue = z.union([z.string().max(200), z.number().finite(), z.boolean()])
const componentProps = z.record(z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/), propertyValue)
const revision = z.string().uuid()

const toolError = (error: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: error instanceof Error ? error.message : JSON.stringify(error, null, 2) ?? String(error) }],
})

/** Review access the app hands to MCP: reading status, and recording the states agents may set. */
export type ReviewAccess = {
  view(id: string): Promise<unknown>
  set(id: string, target: ReviewState, expectedRevision: string, note?: string): Promise<unknown>
}

/** The module library the app hands to MCP. */
export type ModuleAccess = {
  list(): Promise<CircuitModule[]>
  read(id: string): Promise<{ module: CircuitModule; source: string }>
}

export function mountMcp(app: Express, service: ProjectService, configuredToken?: string, sourcing?: SourcingClient, assertions?: (id: string) => Promise<AssertionReport | undefined>, review?: ReviewAccess, modules?: ModuleAccess) {
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

  const mcpHandler = createMcpHandler(() => createServer(service, sourcing, assertions, review, modules), { onerror: (error) => console.error("MCP handler failed", error) })
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

function createServer(service: ProjectService, sourcing?: SourcingClient, assertions?: (id: string) => Promise<AssertionReport | undefined>, review?: ReviewAccess, modules?: ModuleAccess): McpServer {
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

  server.registerTool("duplicate_project", {
    title: "Duplicate project",
    description: "Copy a project's editable files and references into a new independent project. The current source revision is required.",
    inputSchema: z.object({ projectId, name: z.string().trim().min(1).max(100), revision: z.string().uuid() }),
  }, async ({ projectId, name, revision }) => safeTool(() => service.duplicateProject(projectId, name, revision)))

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

  server.registerTool("list_source_components", {
    title: "List circuit source components",
    description: "List the component elements placed in the project's circuit source, as opposed to the components in the last build output.",
    inputSchema: z.object({ projectId }),
  }, async ({ projectId }) => safeTool(async () => {
    const project = await service.get(projectId)
    const file = await service.readFile(projectId, project.entrypoint)
    return { path: file.path, revision: file.revision, components: listSourceComponents(file.content) }
  }))

  server.registerTool("set_board_dimensions", {
    title: "Set board dimensions",
    description: "Set the board width, height, or layer count in the circuit source. Lengths need a unit, such as 30mm. Requires the current project revision.",
    inputSchema: z.object({
      projectId,
      revision,
      width: z.string().max(20).optional(),
      height: z.string().max(20).optional(),
      layers: z.number().int().min(1).max(32).optional(),
    }),
  }, async ({ projectId, revision, width, height, layers }) =>
    safeTool(() => editSource(service, projectId, revision, (source) => setBoardDimensions(source, { width, height, layers }))))

  server.registerTool("add_component", {
    title: "Add a component",
    description: "Add a component element such as resistor, capacitor, or led to the board, with its tscircuit properties. Requires the current project revision.",
    inputSchema: z.object({
      projectId,
      revision,
      element: z.string().min(1).max(50),
      name: z.string().min(1).max(64),
      props: componentProps.optional(),
    }),
  }, async ({ projectId, revision, element, name, props }) =>
    safeTool(() => editSource(service, projectId, revision, (source) => addComponent(source, { element, name, props }))))

  server.registerTool("remove_component", {
    title: "Remove a component",
    description: "Remove a component from the board together with every trace that references it. Requires the current project revision.",
    inputSchema: z.object({ projectId, revision, name: z.string().min(1).max(64) }),
  }, async ({ projectId, revision, name }) =>
    safeTool(() => editSource(service, projectId, revision, (source) => removeComponent(source, name))))

  server.registerTool("set_component_properties", {
    title: "Set component properties",
    description: "Set or replace properties on a named component. A null value removes that property. Requires the current project revision.",
    inputSchema: z.object({
      projectId,
      revision,
      name: z.string().min(1).max(64),
      props: z.record(z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/), propertyValue.nullable()),
    }),
  }, async ({ projectId, revision, name, props }) =>
    safeTool(() => editSource(service, projectId, revision, (source) => setComponentProperties(source, name, props))))

  server.registerTool("connect_components", {
    title: "Connect two ports",
    description: "Add a trace between two tscircuit selectors, such as '.R1 > .pin2' and '.D1 > .pin1'. Requires the current project revision.",
    inputSchema: z.object({
      projectId,
      revision,
      from: z.string().min(1).max(200),
      to: z.string().min(1).max(200),
      name: z.string().min(1).max(64).optional(),
    }),
  }, async ({ projectId, revision, from, to, name }) =>
    safeTool(() => editSource(service, projectId, revision, (source) => connectComponents(source, { from, to, name }))))

  server.registerTool("list_project_revisions", {
    title: "List project revisions",
    description: "List the project's revision history newest first: revision, Git commit when the project is Git-backed, timestamp, changed files, whether a source snapshot is still retained, and whether a build summary exists for comparison.",
    inputSchema: z.object({ projectId }),
  }, async ({ projectId }) => safeTool(async () => service.listHistory(projectId)))

  server.registerTool("compare_project_revisions", {
    title: "Compare two project revisions",
    description: "Compare two revisions: the changed source files with their before and after contents, plus a design comparison of what each revision's build produced (board dimensions, components, nets, routing counts, simulation results). The design comparison is unavailable, with a reason, when either revision has no retained build summary. Rendered images are not compared.",
    inputSchema: z.object({ projectId, from: revision, to: revision }),
  }, async ({ projectId, from, to }) => safeTool(async () => service.compareHistory(projectId, from, to)))

  server.registerTool("list_circuit_modules", {
    title: "List reusable circuit modules",
    description: "List the reusable circuit modules this workbench ships: each one's parameters, terminals, the file it lands at, example usage, and the notes naming what it does not do.",
    inputSchema: z.object({}),
  }, async () => safeTool(async () => {
    if (!modules) throw new Error("The circuit module library is unavailable on this workbench")
    return { modules: await modules.list() }
  }))

  server.registerTool("add_circuit_module", {
    title: "Add a reusable circuit module to a project",
    description: "Write a module's source into the project at modules/<id>.tsx and return the import line and example usage to place in the circuit source. Pass the current project revision for concurrency. The module is a starting point, not a verified design: read its notes.",
    inputSchema: z.object({ projectId, module: z.string().trim().min(1).max(50), revision }),
  }, async ({ projectId, module: moduleId, revision: expected }) => safeTool(async () => {
    if (!modules) throw new Error("The circuit module library is unavailable on this workbench")
    const { module, source } = await modules.read(moduleId)
    const saved = await service.writeFile(projectId, module.path, source, expected)
    return { module, path: saved.path, revision: saved.revision, importLine: moduleImportLine(module), usage: module.usage }
  }))

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

  server.registerTool("list_components", {
    title: "List circuit components",
    description: "List source components and their matching PCB placement when present in the latest successful Circuit JSON build.",
    inputSchema: z.object({ projectId }),
  }, async ({ projectId }) => safeTool(async () => listComponents((await service.preview(projectId)).circuitJson)))

  server.registerTool("get_component", {
    title: "Get circuit component",
    description: "Get one source component by reference/name or source_component_id, including any PCB placement, source ports, and their connected traces present in the latest successful Circuit JSON.",
    inputSchema: z.object({ projectId, component: z.string().trim().min(1).max(200) }),
  }, async ({ projectId, component }) => safeTool(async () => getComponent((await service.preview(projectId)).circuitJson, component)))

  server.registerTool("get_circuit_json", {
    title: "Get Circuit JSON",
    description: "Read the raw Circuit JSON from the latest successful build and the project revision that produced it.",
    inputSchema: z.object({ projectId }),
  }, async ({ projectId }) => safeTool(async () => service.preview(projectId)))

  server.registerTool("list_nets", {
    title: "List circuit nets",
    description: "List logical connections represented by source_trace elements and their connected source ports.",
    inputSchema: z.object({ projectId }),
  }, async ({ projectId }) => safeTool(async () => listNets((await service.preview(projectId)).circuitJson)))

  server.registerTool("trace_net", {
    title: "Trace a circuit net",
    description: "Inspect source_trace elements matching a net name or source_trace_id, their connected ports and components, and matching PCB routes.",
    inputSchema: z.object({ projectId, net: z.string().trim().min(1) }),
  }, async ({ projectId, net }) => safeTool(async () => traceNet((await service.preview(projectId)).circuitJson, net)))

  server.registerTool("get_net_trace", {
    title: "Trace a net across schematic, PCB, and simulation views",
    description: "Group the latest successful build into connectivity-map nets and report each net's component pins, schematic wires, copper traces, vias, routing state, and correlated simulation signals. Pass a net name, net ID, or source_trace_id to trace one net. Every response names what it does not evaluate.",
    inputSchema: z.object({ projectId, net: z.string().trim().min(1).optional() }),
  }, async ({ projectId, net }) => safeTool(async () => {
    const preview = await service.preview(projectId)
    const index = buildNetTraceIndex(preview.circuitJson)
    if (!net) return { revision: preview.revision, ...index }
    return { revision: preview.revision, net: findNet(index, net), limitations: index.limitations }
  }))

  server.registerTool("get_pin_connections", {
    title: "Get component pin connections",
    description: "List source ports for a component matched by name or source_component_id and the source_trace names that include each port.",
    inputSchema: z.object({ projectId, component: z.string().trim().min(1) }),
  }, async ({ projectId, component }) => safeTool(async () => getPinConnections((await service.preview(projectId)).circuitJson, component)))

  server.registerTool("get_board_properties", {
    title: "Get PCB board properties",
    description: "Return pcb_board elements from the latest successful Circuit JSON build, including dimensions, material, stackup, and emitted design-rule fields.",
    inputSchema: z.object({ projectId }),
  }, async ({ projectId }) => safeTool(async () => getBoardProperties((await service.preview(projectId)).circuitJson)))

  server.registerTool("check_connectivity", {
    title: "Check emitted connectivity",
    description: "Summarize source-port connections present in the latest successful Circuit JSON. Reports unconnected and dangling port references without inferring design intent or performing ERC.",
    inputSchema: z.object({ projectId }),
  }, async ({ projectId }) => safeTool(async () => {
    const preview = await service.preview(projectId)
    return { revision: preview.revision, ...checkConnectivity(preview.circuitJson) }
  }))

  server.registerTool("get_project_requirements", {
    title: "Get project requirements",
    description: "Read the versioned requirements.json engineering requirements document, if configured.",
    inputSchema: z.object({ projectId }),
  }, async ({ projectId }) => safeTool(async () => {
    const project = await service.get(projectId)
    if (!(await service.getFileList(projectId)).includes("requirements.json")) return { configured: false, revision: project.revision, requirements: null }
    const file = await service.readFile(projectId, "requirements.json")
    return { configured: true, revision: file.revision, requirements: parseRequirements(file.content) }
  }))

  server.registerTool("validate_project_requirements", {
    title: "Validate project requirements",
    description: "Compare measurable board requirements with the latest successful Circuit JSON build. Unsupported requirement types are returned as not evaluated.",
    inputSchema: z.object({ projectId }),
  }, async ({ projectId }) => safeTool(async () => {
    const project = await service.get(projectId)
    if (!(await service.getFileList(projectId)).includes("requirements.json")) return { configured: false, revision: project.revision, checks: [] }
    const [file, preview] = await Promise.all([service.readFile(projectId, "requirements.json"), service.preview(projectId)])
    if (file.revision !== project.revision || preview.revision !== project.revision) return { configured: true, stale: true, revision: project.revision, previewRevision: preview.revision, checks: [], message: "The latest successful build or requirements file is for an older project revision; rebuild before validating requirements." }
    return { configured: true, stale: false, revision: project.revision, previewRevision: preview.revision, ...validateRequirements(parseRequirements(file.content), preview.circuitJson) }
  }))

  server.registerTool("get_review_state", {
    title: "Get the project's design review state",
    description: "Read the review state of the project's current revision (draft, validated, reviewed, or manufacturing_approved), the review history, the evidence each transition is judged against, and which states can be set now. A state applies only to the revision it was recorded against, so any source change returns the project to draft.",
    inputSchema: z.object({ projectId }),
  }, async ({ projectId }) => safeTool(async () => {
    if (!review) throw new Error("Design review state is unavailable on this workbench")
    return review.view(projectId)
  }))

  server.registerTool("set_review_state", {
    title: "Record a design review state",
    description: "Record 'validated' or 'reviewed' for the project's current revision, passing that revision for concurrency. Both require a successful build of the current revision and, when the project declares assertions, that none of them fail. Approving a revision for manufacturing and reopening an approved revision are reserved for a person and refused here. While a revision is approved for manufacturing, all file writes are refused.",
    inputSchema: z.object({ projectId, state: z.enum(["validated", "reviewed"]), revision, note: z.string().trim().max(2000).optional() }),
  }, async ({ projectId, state, revision: expected, note }) => safeTool(async () => {
    if (!review) throw new Error("Design review state is unavailable on this workbench")
    if (!isReviewState(state)) throw new Error("state must be validated or reviewed")
    return review.set(projectId, state, expected, note)
  }))

  server.registerTool("check_project_assertions", {
    title: "Check project regression assertions",
    description: "Evaluate the project's assertions.json document against the latest successful build: named nets stay connected, required components exist, supply current and dissipation stay within limits, design check findings do not increase against the previous retained build, component cost stays within budget, and simulation values stay within range. Each assertion reports pass, fail, or not evaluated with the reason; nothing passes on missing evidence.",
    inputSchema: z.object({ projectId }),
  }, async ({ projectId }) => safeTool(async () => {
    const report = await assertions?.(projectId)
    if (!report) return { configured: false, message: "This project declares no assertions.json document, so no regression assertions were evaluated." }
    return { configured: true, ...report }
  }))

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

  server.registerTool("list_simulation_signals", {
    title: "List simulation signals",
    description: "List the transient waveforms, DC operating-point values, and DC/AC sweeps the latest successful build emitted, without their sample data. Also reports which analysis modes produced no results.",
    inputSchema: z.object({ projectId }),
  }, async ({ projectId }) => safeTool(async () => {
    const preview = await service.preview(projectId)
    const results = getSimulationResults(preview.circuitJson)
    return {
      revision: preview.revision,
      status: results.status,
      experiments: results.experiments,
      analyses: results.analyses,
      signals: results.signals.map(({ id, name, unit, netId, samples }) => ({ id, name, unit, netId, kind: "transient", sampleCount: samples.length })),
      operatingPoints: results.operatingPoints,
      sweeps: results.sweeps.map(({ id, name, kind, unit, xLabel, netId, samples }) => ({ id, name, kind, unit, xLabel, netId, sampleCount: samples.length })),
      notEvaluated: results.notEvaluated,
    }
  }))

  server.registerTool("get_waveform", {
    title: "Get one simulation waveform or sweep",
    description: "Return the samples of one transient waveform or one DC/AC sweep from the latest successful build, matched by signal ID or probe name. AC sweeps include magnitude in dB and phase in degrees.",
    inputSchema: z.object({ projectId, signal: z.string().trim().min(1) }),
  }, async ({ projectId, signal }) => safeTool(async () => {
    const preview = await service.preview(projectId)
    const results = getSimulationResults(preview.circuitJson)
    const waveform = results.signals.find((item) => item.id === signal || item.name === signal)
    const sweep = results.sweeps.find((item) => item.id === signal || item.name === signal)
    if (!waveform && !sweep) throw new Error(`No simulation signal or sweep in the latest successful build matches '${signal}'`)
    return { revision: preview.revision, ...(waveform ? { kind: "transient", signal: waveform } : { kind: sweep!.kind, sweep }) }
  }))

  server.registerTool("run_erc", {
    title: "Run electrical rule checks",
    description: "Run the supported tscircuit netlist, pin specification, and source checks against the latest successful build, and report which electrical checks are not evaluated.",
    inputSchema: z.object({ projectId }),
  }, async ({ projectId }) => safeTool(async () => {
    const preview = await service.preview(projectId)
    return { revision: preview.revision, ...await runElectricalRuleCheck(preview.circuitJson) }
  }))

  server.registerTool("run_drc", {
    title: "Run PCB design rule checks",
    description: "Run the supported tscircuit placement and routing checks against the latest successful build, and report which board checks are not evaluated. Fabricator limits are checked by check_manufacturability.",
    inputSchema: z.object({ projectId }),
  }, async ({ projectId }) => safeTool(async () => {
    const preview = await service.preview(projectId)
    return { revision: preview.revision, ...await runDesignRuleCheck(preview.circuitJson) }
  }))

  server.registerTool("check_routing", {
    title: "Check routing",
    description: "Report routing findings for the latest successful build, including unrouted and discontinuous connections.",
    inputSchema: z.object({ projectId }),
  }, async ({ projectId }) => safeTool(async () => {
    const preview = await service.preview(projectId)
    return { revision: preview.revision, ...await checkRouting(preview.circuitJson) }
  }))

  server.registerTool("analyze_power", {
    title: "Analyze power",
    description: "Report the IPC-2221 current capacity of each routed trace in the latest successful build. Quantities that need an operating point, such as dissipation and total current demand, are reported as not evaluated rather than estimated.",
    inputSchema: z.object({
      projectId,
      temperatureRiseC: z.number().positive().max(100).optional(),
      copperOunces: z.number().positive().max(10).optional(),
    }),
  }, async ({ projectId, temperatureRiseC, copperOunces }) => safeTool(async () => {
    const preview = await service.preview(projectId)
    return { revision: preview.revision, ...analyzePower(preview.circuitJson, { temperatureRiseC, copperOunces }) }
  }))

  server.registerTool("check_manufacturability", {
    title: "Check manufacturing readiness",
    description: "Run manufacturing completeness checks, supported tscircuit Circuit JSON design checks, and selected fabricator profile checks against the latest build.",
    inputSchema: z.object({ projectId }),
  }, async ({ projectId }) => safeTool(async () => {
    const [project, preview] = await Promise.all([service.get(projectId), service.preview(projectId)])
    return {
      revision: preview.revision,
      ...await checkManufacturability(
        preview.circuitJson,
        project.lastBuild ?? { status: "idle", revision: "" },
        preview.revision,
        project.revision,
        undefined,
        sourcing,
        await assertions?.(projectId),
      ),
    }
  }))

  server.registerTool("get_component_sourcing", {
    title: "Look up supplier data for a part",
    description: "Read manufacturer part number, package, description, stock, unit price, and basic/preferred flags for an LCSC part number from the configured supplier index. Fails when no provider is configured.",
    inputSchema: z.object({ part: z.string().trim().min(2).max(20) }),
  }, async ({ part }) => safeTool(async () => {
    if (!sourcing) throw new Error("No component sourcing provider is configured. Set COMPONENT_SOURCING_URL to enable supplier lookups.")
    const normalized = normalizeLcscPartNumber(part)
    if (!normalized) throw new Error(`'${part}' is not an LCSC part number such as C2040`)
    const sourced = await sourcing.lookup(normalized)
    if (!sourced) throw new Error(`The supplier index returned no part for ${normalized}`)
    return { provider: sourcing.provider, part: sourced }
  }))

  server.registerTool("estimate_manufacturing_cost", {
    title: "Estimate component cost for a board quantity",
    description: "Price the components in the latest successful build for a board quantity using the configured supplier index. Covers component cost only: fabrication, assembly, tooling, shipping, and taxes are excluded, and parts without an LCSC part number or price are listed as unpriced.",
    inputSchema: z.object({ projectId, boards: z.number().int().min(1).max(10000).optional() }),
  }, async ({ projectId, boards }) => safeTool(async () => {
    const preview = await service.preview(projectId)
    if (!sourcing) return {
      revision: preview.revision,
      configured: false,
      parts: listDesignParts(preview.circuitJson),
      message: "No component sourcing provider is configured, so no prices or stock were looked up. Set COMPONENT_SOURCING_URL to enable it.",
    }
    return { revision: preview.revision, configured: true, provider: sourcing.provider, ...await estimateBomCost(preview.circuitJson, sourcing, boards ?? 1) }
  }))

  server.registerTool("get_manufacturing_package", {
    title: "Get manufacturing package download reference",
    description: "Return a machine-usable reference to the manufacturing ZIP download. Fetch the path with GET and the same bearer token; the download route reruns manufacturing preflight and rejects project revision changes.",
    inputSchema: z.object({ projectId, profile: z.enum(["board-default", "jlcpcb-2layer-1oz"]).optional() }),
  }, async ({ projectId, profile }) => {
    const query = profile ? `?profile=${encodeURIComponent(profile)}` : ""
    return result({
      method: "GET",
      path: `/api/projects/${projectId}/manufacturing.zip${query}`,
      contentType: "application/zip",
      generatedBy: "preflight-gated manufacturing download route",
    })
  })


  return server
}

/** Apply a structural edit to a project's circuit source and write it back under the caller's revision. */
async function editSource(service: ProjectService, id: string, expectedRevision: string, transform: (source: string) => string) {
  const project = await service.get(id)
  const file = await service.readFile(id, project.entrypoint)
  const updated = transform(file.content)
  if (updated === file.content) return { path: file.path, revision: file.revision, changed: false }
  const written = await service.writeFile(id, project.entrypoint, updated, expectedRevision)
  return { ...written, changed: true }
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
