import { spawn } from "node:child_process"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Express } from "express"

export type BuildState = { status: string; revision: string; diagnostics?: unknown[] }
export type ManufacturingCheck = { id: string; status: "pass" | "fail" | "warning" | "not-evaluated"; message: string }
export type ManufacturingPreflight = { ready: boolean; profile: Pick<ManufacturingRuleProfile, "id" | "label">; checks: ManufacturingCheck[] }
export type ManufacturingRuleProfile = {
  id: string
  label: string
  description: string
  rules: { minTraceWidthMm: number; minNonPlatedHoleMm: number; copperToBoardEdgeMm: number }
  board?: { layers: number; material: string }
}
export const manufacturingRuleProfiles: ManufacturingRuleProfile[] = [
  { id: "board-default", label: "Board defaults", description: "Use the design rules declared by the board.", rules: { minTraceWidthMm: 0, minNonPlatedHoleMm: 0, copperToBoardEdgeMm: 0 } },
  { id: "jlcpcb-2layer-1oz", label: "JLCPCB rigid PCB, 2-layer, 1 oz", description: "Published baseline limits for standard rigid two-layer, one-ounce copper boards.", board: { layers: 2, material: "fr4" }, rules: { minTraceWidthMm: 0.1, minNonPlatedHoleMm: 0.5, copperToBoardEdgeMm: 0.2 } },
]
type ManufacturingProject = { id?: string; name?: string; entrypoint?: string; revision: string; previewRevision?: string; lastBuild?: BuildState }
type ManufacturingService = {
  get(id: string): Promise<ManufacturingProject>
  preview(id: string): Promise<{ revision: string; circuitJson: unknown }>
  exportGerbers(id: string): Promise<string>
}

const records = (json: unknown) => Array.isArray(json) ? json.filter(isRecord) : []
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

/** Conservative checks based on build state and the Circuit JSON elements present. */
export function checkManufacturability(circuitJson: unknown, build: BuildState, previewRevision: string, projectRevision = previewRevision, profileId = "board-default"): ManufacturingPreflight {
  const items = records(circuitJson)
  const boards = items.filter((item) => item.type === "pcb_board")
  const pcbComponents = items.filter((item) => item.type === "pcb_component")
  const sources = items.filter((item) => item.type === "source_component")
  const profile = manufacturingRuleProfiles.find(({ id }) => id === profileId) ?? manufacturingRuleProfiles[0]!
  const ruleChecks = checkProfileRules(items, profile)
  const validationChecks = checkCircuitValidation(items)
  const routingCheck = checkRoutedConnections(items)
  const checks: ManufacturingCheck[] = [
    build.status === "ready" && build.revision === previewRevision && previewRevision === projectRevision
      ? { id: "build", status: "pass", message: "Latest project revision built successfully." }
      : { id: "build", status: "fail", message: "A successful build for the current preview revision is required." },
    boards.length > 0
      ? { id: "board", status: "pass", message: `${boards.length} PCB board${boards.length === 1 ? "" : "s"} found.` }
      : { id: "board", status: "fail", message: "Circuit JSON contains no PCB board." },
    pcbComponents.length > 0
      ? { id: "pcb-components", status: "pass", message: `${pcbComponents.length} placed PCB component${pcbComponents.length === 1 ? "" : "s"} found.` }
      : { id: "pcb-components", status: "warning", message: "No placed PCB components were found; assembly exports may be empty." },
    sourceComponentsHaveReferences(sources)
      ? { id: "references", status: "pass", message: "Source components have reference designators." }
      : { id: "references", status: "fail", message: "One or more source components lack a reference designator." },
    sourceComponentsHaveFootprints(sources, pcbComponents)
      ? { id: "footprints", status: "pass", message: "Source components have placed PCB footprint geometry." }
      : { id: "footprints", status: "fail", message: "One or more source components lack placed PCB footprint geometry." },
    ...validationChecks,
    routingCheck,
    ...ruleChecks,
    { id: "bom-review", status: "warning", message: "Review generated BOM supplier part numbers and values before ordering." },
  ]
  return { ready: checks.every((check) => check.status !== "fail"), profile: { id: profile.id, label: profile.label }, checks }
}

function checkRoutedConnections(items: Record<string, unknown>[]): ManufacturingCheck {
  const sourceTraces = items.filter((item) => item.type === "source_trace")
  if (sourceTraces.length === 0) {
    return { id: "routed-connections", status: "warning", message: "No logical source traces were found; routed connectivity could not be verified." }
  }

  const pcbTraces = items.filter((item) => item.type === "pcb_trace")
  const routedSourceTraceIds = new Set(pcbTraces.flatMap((trace) =>
    typeof trace.source_trace_id === "string" && Array.isArray(trace.route) && trace.route.length > 0
      ? [trace.source_trace_id]
      : []))
  const unrouted = sourceTraces.filter((trace) =>
    typeof trace.source_trace_id !== "string" || !routedSourceTraceIds.has(trace.source_trace_id))
  if (unrouted.length > 0) {
    const ids = unrouted.map((trace) => typeof trace.source_trace_id === "string" ? trace.source_trace_id : "(missing source trace ID)")
    return { id: "routed-connections", status: "fail", message: `${unrouted.length} logical source trace${unrouted.length === 1 ? "" : "s"} lack a routed PCB trace with route geometry: ${ids.join(", ")}.` }
  }
  return { id: "routed-connections", status: "pass", message: `All ${sourceTraces.length} logical source trace${sourceTraces.length === 1 ? " has" : "s have"} routed PCB trace geometry.` }
}

export function mountManufacturingRoutes(app: Express, service: ManufacturingService) {
  app.get("/api/manufacturing/profiles", (_request, response) => response.json({ profiles: manufacturingRuleProfiles }))
  app.get("/api/projects/:id/manufacturing", async (request, response, next) => {
    try {
      const profileId = readProfileId(request.query.profile, response)
      if (!profileId) return
      const project = await service.get(request.params.id!)
      const preview = await service.preview(request.params.id!)
      response.json({ projectRevision: project.revision, previewRevision: preview.revision,
        preflight: checkManufacturability(preview.circuitJson, project.lastBuild ?? { status: "idle", revision: "" }, preview.revision, project.revision, profileId) })
    } catch (error) { next(error) }
  })
  app.get("/api/projects/:id/manufacturing.zip", async (request, response, next) => {
    let archive: string | undefined
    try {
      const profileId = readProfileId(request.query.profile, response)
      if (!profileId) return
      const project = await service.get(request.params.id!)
      const preview = await service.preview(request.params.id!)
      const preflight = checkManufacturability(preview.circuitJson, project.lastBuild ?? { status: "idle", revision: "" }, preview.revision, project.revision, profileId)
      if (!preflight.ready) return response.status(422).json({ error: "Manufacturing preflight failed", projectRevision: project.revision, preflight })
      archive = await service.exportGerbers(request.params.id!)
      const current = await service.get(request.params.id!)
      if (current.revision !== project.revision) throw Object.assign(new Error("Project changed while manufacturing files were generated"), { status: 409, revision: current.revision })
      const filename = `${safeFilename(project.name ?? "circuit")}-manufacturing.zip`
      response.download(archive, filename, async (error) => {
        if (archive) await cleanupManufacturingArchive(archive)
        if (error && !response.headersSent) next(error)
      })
    } catch (error) {
      if (archive) await cleanupManufacturingArchive(archive)
      next(error)
    }
  })
}

function readProfileId(value: unknown, response: import("express").Response) {
  const id = typeof value === "string" ? value : "board-default"
  if (!manufacturingRuleProfiles.some((profile) => profile.id === id)) {
    response.status(400).json({ error: `Unknown manufacturing profile: ${id}` })
    return undefined
  }
  return id
}

function checkCircuitValidation(items: Record<string, unknown>[]): ManufacturingCheck[] {
  const errors = items.filter((item) => typeof item.type === "string" && /^(pcb|source)_.*_error$/.test(item.type))
  const warnings = items.filter((item) => typeof item.type === "string" && /^(pcb|source)_.*_warning$/.test(item.type))
  return [
    errors.length
      ? { id: "circuit-errors", status: "fail", message: `${errors.length} Circuit JSON ERC/DRC error${errors.length === 1 ? "" : "s"}: ${errors.map(validationMessage).join("; ")}` }
      : { id: "circuit-errors", status: "not-evaluated", message: "Circuit JSON contains no ERC/DRC error records; no validator result confirms this check passed." },
    warnings.length
      ? { id: "circuit-warnings", status: "warning", message: `${warnings.length} Circuit JSON warning${warnings.length === 1 ? "" : "s"}: ${warnings.map(validationMessage).join("; ")}` }
      : { id: "circuit-warnings", status: "not-evaluated", message: "Circuit JSON contains no ERC/DRC warning records; no validator result confirms this check passed." },
  ]
}

function validationMessage(item: Record<string, unknown>) {
  return typeof item.message === "string" ? item.message : String(item.type)
}

function checkProfileRules(items: Record<string, unknown>[], profile: ManufacturingRuleProfile): ManufacturingCheck[] {
  const traces = items.filter((item) => item.type === "pcb_trace")
  const wireWidths = traces.flatMap((trace) => Array.isArray(trace.route) ? trace.route.filter(isRecord).filter((point) => point.route_type === "wire" && typeof point.width === "number").map((point) => point.width as number) : [])
  const holes = items.filter((item) => item.type === "pcb_hole").map((item) => item.hole_diameter).filter((diameter): diameter is number => typeof diameter === "number")
  const tooNarrow = wireWidths.filter((width) => width < profile.rules.minTraceWidthMm)
  const tooSmall = holes.filter((diameter) => diameter < profile.rules.minNonPlatedHoleMm)
  const isDefault = profile.id === "board-default"
  const board = items.find((item) => item.type === "pcb_board")
  const boardWidth = board && typeof board.width === "number" ? board.width : undefined
  const boardHeight = board && typeof board.height === "number" ? board.height : undefined
  const stackupMatches = !profile.board || Boolean(board && board.num_layers === profile.board.layers && board.material === profile.board.material)
  const edgeClearances = board && board.shape !== "polygon" && boardWidth !== undefined && boardHeight !== undefined
    ? traces.flatMap((trace) => Array.isArray(trace.route) ? trace.route.filter(isRecord).flatMap((point) => {
      const center = isRecord(board.center) ? board.center : {}
      const x = typeof point.x === "number" ? point.x : undefined
      const y = typeof point.y === "number" ? point.y : undefined
      const radius = point.route_type === "via" ? Number(point.outer_diameter ?? 0) / 2 : point.route_type === "wire" ? Number(point.width ?? 0) / 2 : 0
      if (x === undefined || y === undefined) return []
      return [Math.min(boardWidth / 2 - Math.abs(x - Number(center.x ?? 0)), boardHeight / 2 - Math.abs(y - Number(center.y ?? 0))) - radius]
    }) : [])
    : undefined
  const belowEdgeClearance = edgeClearances?.filter((clearance) => clearance < profile.rules.copperToBoardEdgeMm) ?? []
  return [
    profile.board
      ? board && board.num_layers !== undefined && board.material !== undefined
        ? stackupMatches
          ? { id: "board-stackup", status: "pass", message: `Board matches the ${profile.board.layers}-layer ${profile.board.material.toUpperCase()} profile.` }
          : { id: "board-stackup", status: "fail", message: `Selected profile requires ${profile.board.layers}-layer ${profile.board.material.toUpperCase()}; the board declares ${String(board.num_layers)} layers of ${String(board.material).toUpperCase()}.` }
        : { id: "board-stackup", status: "warning", message: "Board layer count or material is missing; verify it matches the selected profile." }
      : { id: "board-stackup", status: "warning", message: "Select a fabricator profile to check board stackup." },
    isDefault
      ? { id: "trace-width", status: "warning", message: "Select a fabricator profile to check minimum trace width." }
      : tooNarrow.length
        ? { id: "trace-width", status: "fail", message: `${tooNarrow.length} trace segment${tooNarrow.length === 1 ? "" : "s"} fall below the ${profile.rules.minTraceWidthMm} mm minimum.` }
        : { id: "trace-width", status: "pass", message: `All measured trace segments meet the ${profile.rules.minTraceWidthMm} mm minimum.` },
    isDefault
      ? { id: "hole-size", status: "warning", message: "Select a fabricator profile to check non-plated hole size." }
      : tooSmall.length
        ? { id: "hole-size", status: "fail", message: `${tooSmall.length} non-plated hole${tooSmall.length === 1 ? "" : "s"} fall below the ${profile.rules.minNonPlatedHoleMm} mm minimum.` }
        : { id: "hole-size", status: "pass", message: `All measured non-plated holes meet the ${profile.rules.minNonPlatedHoleMm} mm minimum.` },
    isDefault
      ? { id: "board-edge-clearance", status: "warning", message: "Select a fabricator profile to check copper-to-board-edge clearance." }
      : edgeClearances === undefined
        ? { id: "board-edge-clearance", status: "warning", message: "Copper-to-edge clearance could not be measured for this board outline; review the outline manually." }
        : belowEdgeClearance.length
          ? { id: "board-edge-clearance", status: "fail", message: `${belowEdgeClearance.length} routed copper point${belowEdgeClearance.length === 1 ? " is" : "s are"} closer than ${profile.rules.copperToBoardEdgeMm} mm to the rectangular board edge.` }
          : { id: "board-edge-clearance", status: "pass", message: `Routed copper meets the ${profile.rules.copperToBoardEdgeMm} mm clearance from the rectangular board edge.` },
  ]
}

export async function createGerberArchive(projectDir: string, entrypoint: string) {
  const projectRoot = path.resolve(projectDir)
  const source = path.resolve(projectRoot, entrypoint)
  if (!source.startsWith(projectRoot + path.sep)) throw Object.assign(new Error("Invalid project entrypoint"), { status: 400 })
  const resolvedRoot = await realpath(projectRoot)
  const resolvedSource = await realpath(source)
  if (!resolvedSource.startsWith(resolvedRoot + path.sep)) throw Object.assign(new Error("Invalid project entrypoint"), { status: 400 })
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "circuits-manufacturing-"))
  const archive = path.join(tempDir, "manufacturing.zip")
  const cli = path.resolve(process.cwd(), "node_modules/tscircuit/cli.mjs")
  try {
    await runExport(cli, projectDir, ["export", entrypoint, "--format", "gerbers", "--output", archive])
    return archive
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true })
    throw error
  }
}

export async function cleanupManufacturingArchive(archive: string) {
  await rm(path.dirname(archive), { recursive: true, force: true })
}

function runExport(cli: string, cwd: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.env.BUN_BINARY ?? "bun", [cli, ...args], {
      cwd,
      env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: cwd, TMPDIR: process.env.TMPDIR ?? os.tmpdir(), CI: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
      stdio: ["ignore", "ignore", "pipe"],
    })
    let stderr = ""
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk })
    const timeout = setTimeout(() => child.kill("SIGKILL"), 120_000)
    child.once("error", (error) => { clearTimeout(timeout); reject(error) })
    child.once("close", (code) => {
      clearTimeout(timeout)
      if (code === 0) resolve()
      else reject(new Error(stderr.trim() || `tsci gerbers export exited with status ${code ?? "unknown"}`))
    })
  })
}

function safeFilename(value: string) {
  return value.normalize("NFKD").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "circuit"
}

function sourceComponentsHaveReferences(components: Record<string, unknown>[]) {
  return components.every((component) => typeof (component.name ?? component.ftype) === "string" && String(component.name ?? component.ftype).trim() !== "")
}

function sourceComponentsHaveFootprints(components: Record<string, unknown>[], pcbComponents: Record<string, unknown>[]) {
  return components.every((component) => pcbComponents.some((pcbComponent) =>
    pcbComponent.source_component_id === component.source_component_id &&
    typeof pcbComponent.width === "number" && pcbComponent.width > 0 &&
    typeof pcbComponent.height === "number" && pcbComponent.height > 0))
}
