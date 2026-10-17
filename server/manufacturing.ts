import { spawn } from "node:child_process"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Express } from "express"

export type BuildState = { status: string; revision: string; diagnostics?: unknown[] }
export type ManufacturingCheck = { id: string; status: "pass" | "fail" | "warning"; message: string }
export type ManufacturingPreflight = { ready: boolean; checks: ManufacturingCheck[] }
type ManufacturingProject = { id?: string; name?: string; entrypoint?: string; revision: string; previewRevision?: string; lastBuild?: BuildState }
type ManufacturingService = {
  get(id: string): Promise<ManufacturingProject>
  preview(id: string): Promise<{ revision: string; circuitJson: unknown }>
  exportGerbers(id: string): Promise<string>
}

const records = (json: unknown) => Array.isArray(json) ? json.filter(isRecord) : []
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

/** Conservative checks based on build state and the Circuit JSON elements present. */
export function checkManufacturability(circuitJson: unknown, build: BuildState, previewRevision: string, projectRevision = previewRevision): ManufacturingPreflight {
  const items = records(circuitJson)
  const boards = items.filter((item) => item.type === "pcb_board")
  const pcbComponents = items.filter((item) => item.type === "pcb_component")
  const sources = items.filter((item) => item.type === "source_component")
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
    { id: "bom-review", status: "warning", message: "Review generated BOM supplier part numbers and values before ordering." },
    { id: "electrical-validation", status: "warning", message: "This workbench does not provide ERC/DRC or fabrication rule validation." },
    { id: "fabricator-profile", status: "warning", message: "No fabricator-specific stackup or design-rule profile has been applied." },
  ]
  return { ready: checks.every((check) => check.status !== "fail"), checks }
}

export function mountManufacturingRoutes(app: Express, service: ManufacturingService) {
  app.get("/api/projects/:id/manufacturing", async (request, response, next) => {
    try {
      const project = await service.get(request.params.id!)
      const preview = await service.preview(request.params.id!)
      response.json({ projectRevision: project.revision, previewRevision: preview.revision,
        preflight: checkManufacturability(preview.circuitJson, project.lastBuild ?? { status: "idle", revision: "" }, preview.revision, project.revision) })
    } catch (error) { next(error) }
  })
  app.get("/api/projects/:id/manufacturing.zip", async (request, response, next) => {
    let archive: string | undefined
    try {
      const project = await service.get(request.params.id!)
      const preview = await service.preview(request.params.id!)
      const preflight = checkManufacturability(preview.circuitJson, project.lastBuild ?? { status: "idle", revision: "" }, preview.revision, project.revision)
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
