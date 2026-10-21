import { createHash, randomUUID, timingSafeEqual } from "node:crypto"
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises"
import { execFile as execFileCallback } from "node:child_process"
import { promisify } from "node:util"
import { tmpdir } from "node:os"
import path from "node:path"
import express, { type Express, type Request, type Response } from "express"
import chokidar, { type FSWatcher } from "chokidar"
import { KicadToCircuitJsonConverter } from "kicad-to-circuit-json"
import { convertSchematicV6 } from "easyeda2kicad6"
import { convertCircuitJsonToTscircuit } from "circuit-json-to-tscircuit"
import { mountMcp } from "./mcp.js"
import { createGerberArchive, mountManufacturingRoutes } from "./manufacturing.js"
import { getSimulationResults } from "./simulation.js"
import { buildNetTraceIndex } from "./net-trace.js"
import { analyzePower } from "./power-analysis.js"
import { createSourcingClient, estimateBomCost, listDesignParts, normalizeLcscPartNumber, type SourcingClient } from "./component-sourcing.js"
import { createProjectGit, type ProjectGit } from "./project-git.js"
import { designDiffUnavailable, diffDesignSummaries, summarizeDesign, type DesignSummary } from "./design-summary.js"
import { parseRequirements, validateRequirements } from "./requirements.js"
import { runCommand } from "./build-process.js"
import { executeRemoteBuild, type IsolatedBuildResult } from "./build-client.js"
import { withGeneratedPcbDraft } from "./pcb-draft.js"
import { convertEasyedaFileToCircuit, enrichEasyedaComponentMetadata } from "./easyeda-component-metadata.js"
import { createProjectArchive, parseProjectArchive } from "./project-archive.js"

export type Diagnostic = { severity: "error" | "warning" | "info"; message: string; path?: string; line?: number; column?: number }
type BuildStatus = "idle" | "compiling" | "ready" | "failed"
type BuildRecord = { buildId: string; revision: string; status: BuildStatus; diagnostics: Diagnostic[]; updatedAt: string }
type ProjectData = { id: string; name: string; entrypoint: string; revision: string; previewRevision?: string; lastBuild?: BuildRecord; referencePdfs?: Array<{ id: string; name: string }> }
type ProjectState = { project: ProjectData; preview?: unknown }
type ProjectSnapshot = { revision: string; createdAt: string; changedFiles: string[]; sizeBytes: number; files: Record<string, string> }
type ServerEvent = "project" | "file" | "build.status" | "build.ready" | "build.failed"
type BuildFn = (projectDir: string, entrypoint: string) => Promise<unknown>
type AppOptions = { projectsDir?: string; examplesDir?: string; buildCircuit?: BuildFn; buildExecutionMode?: "isolated" | "trusted-local"; buildRunner?: { url: string; token: string }; watchFiles?: boolean; webDist?: string; mcpAuthToken?: string; workbenchAuthToken?: string; kicadCliPath?: string; componentSourcing?: SourcingClient | { baseUrl: string; provider?: string }; gitHistory?: boolean; gitPath?: string }

const execFile = promisify(execFileCallback)

const templates = [
  { id: "blank-board", name: "Blank starter", description: "An empty board ready for your circuit." },
  { id: "manufacturing-board", name: "Manufacturing preview", description: "A small board with components and mounting holes." },
  { id: "footprint-comparison", name: "Footprint comparison", description: "Compare common resistor package sizes." },
  { id: "mounting-pattern", name: "Mounting pattern", description: "Explore component placement and mounting holes." },
  { id: "led-indicator", name: "Connected LED indicator", description: "A powered LED circuit with named nets." },
  { id: "voltage-divider", name: "Filtered voltage divider", description: "A connected divider with a low-pass capacitor." },
] as const

/**
 * tscircuit version pinned into every new project. Keep it in step with the
 * dependency in the repository's package.json; the workbench has no dependency
 * management surface yet, so projects are created with this single pin.
 */
const PROJECT_TSCIRCUIT_VERSION = "0.0.2930"

const HISTORY_RETENTION = 50
/** Build summaries retained per project for revision comparison. */
const DESIGN_SUMMARY_RETENTION = 200

class ProjectService {
  readonly root: string
  readonly examplesDir: string
  readonly buildCircuit?: BuildFn
  readonly buildExecutionMode: "isolated" | "trusted-local"
  readonly buildRunner?: { url: string; token: string }
  readonly watchFiles: boolean
  readonly eventClients = new Map<string, Set<Response>>()
  readonly watchers = new Map<string, FSWatcher>()
  readonly states = new Map<string, ProjectState>()
  readonly timers = new Map<string, NodeJS.Timeout>()
  readonly buildsRunning = new Set<string>()
  readonly rerunBuild = new Set<string>()
  readonly queuedBuilds = new Map<string, { buildId: string; revision: string }>()
  readonly deletingProjects = new Set<string>()
  readonly writeQueues = new Map<string, Promise<void>>()
  readonly git: ProjectGit
  readonly ownFileHashes = new Map<string, string>()
  readonly ownFileDeletes = new Set<string>()
  readonly closeHandlers: Array<() => Promise<void>> = []
  readonly kicadCliPath: string
  readonly ready: Promise<void>
  readonly appNodeModules: string

  constructor(options: AppOptions) {
    this.root = path.resolve(options.projectsDir ?? process.env.PROJECTS_DIR ?? "/data/projects")
    this.examplesDir = path.resolve(options.examplesDir ?? path.join(process.cwd(), "examples"))
    this.buildCircuit = options.buildCircuit
    const executionMode = options.buildExecutionMode ?? process.env.BUILD_EXECUTION_MODE ?? "isolated"
    this.buildExecutionMode = executionMode as "isolated" | "trusted-local"
    this.buildRunner = options.buildRunner
    if (!["isolated", "trusted-local"].includes(this.buildExecutionMode)) throw new Error("BUILD_EXECUTION_MODE must be isolated or trusted-local")
    if (this.buildExecutionMode === "trusted-local" && process.env.NODE_ENV === "production") throw new Error("trusted-local project builds are disabled in production")
    this.watchFiles = options.watchFiles ?? true
    this.kicadCliPath = options.kicadCliPath ?? process.env.KICAD_CLI_PATH ?? "kicad-cli"
    this.appNodeModules = path.resolve(process.cwd(), "node_modules")
    this.git = createProjectGit({
      ...(options.gitPath ?? process.env.GIT_PATH ? { gitPath: options.gitPath ?? process.env.GIT_PATH } : {}),
      enabled: options.gitHistory ?? process.env.GIT_HISTORY !== "false",
    })
    this.ready = this.initialize()
  }

  async initialize() {
    await mkdir(this.root, { recursive: true })
    for (const dirent of await readdir(this.root, { withFileTypes: true })) {
      if (!dirent.isDirectory() || !isId(dirent.name)) continue
      const state = await this.load(dirent.name)
      if (state) {
        this.states.set(state.project.id, state)
        if ((await this.readSnapshots(state.project.id)).length === 0) await this.storeSnapshot(state.project.id, state.project.revision, await this.getFileList(state.project.id))
        if (this.watchFiles) this.watch(state.project.id)
      }
    }
  }

  async list() {
    return [...this.states.values()].map(({ project }) => project)
  }

  async create(name: string, templateId?: string) {
    const template = templateId ? templates.find((item) => item.id === templateId) : undefined
    if (templateId && !template) throw badRequest("Unknown project template")
    const source = await readFile(path.join(this.examplesDir, template?.id ?? "blank-board", "index.circuit.tsx"), "utf8")
    const id = randomUUID()
    const dir = this.projectDir(id)
    await mkdir(path.join(dir, ".workbench"), { recursive: true })
    const project: ProjectData = { id, name: name.trim(), entrypoint: "index.circuit.tsx", revision: newRevision() }
    await writeFile(path.join(dir, project.entrypoint), source)
    const projectPackage = JSON.stringify({ name: safePackageName(name), private: true, dependencies: { tscircuit: PROJECT_TSCIRCUIT_VERSION } }, null, 2) + "\n"
    await writeFile(path.join(dir, "package.json"), projectPackage)
    this.ownFileHashes.set(path.join(dir, project.entrypoint), digest(source))
    this.ownFileHashes.set(path.join(dir, "package.json"), digest(projectPackage))
    if (this.buildExecutionMode === "trusted-local") await this.linkNodeModules(dir)
    const state: ProjectState = { project }
    this.states.set(id, state)
    await this.storeSnapshot(id, project.revision, [project.entrypoint, "package.json"])
    await this.persist(state)
    this.watch(id)
    this.emit(id, "project", { project })
    this.scheduleBuild(id, 0)
    return project
  }

  async importArchive(name: string, entrypoint: string, files: Array<{ path: string; content: string }>) {
    const safeEntrypoint = cleanRelative(entrypoint)
    if (!files.some((file) => cleanRelative(file.path) === safeEntrypoint)) throw badRequest("Archive entrypoint is missing")
    const id = randomUUID()
    const dir = this.projectDir(id)
    try {
      await mkdir(path.join(dir, ".workbench"), { recursive: true })
      for (const file of files) {
        const relative = cleanRelative(file.path)
        const target = path.join(dir, relative)
        await mkdir(path.dirname(target), { recursive: true })
        await writeFile(target, file.content, "utf8")
        this.ownFileHashes.set(target, digest(file.content))
      }
      const project: ProjectData = { id, name: name.trim(), entrypoint: safeEntrypoint, revision: newRevision() }
      const state: ProjectState = { project }
      this.states.set(id, state)
      await this.persist(state)
      await this.storeSnapshot(id, project.revision, files.map((file) => file.path))
      this.watch(id)
      this.emit(id, "project", { project })
      this.scheduleBuild(id, 0)
      return project
    } catch (error) {
      this.states.delete(id)
      for (const filename of this.ownFileHashes.keys()) if (filename.startsWith(dir + path.sep)) this.ownFileHashes.delete(filename)
      await rm(dir, { recursive: true, force: true })
      throw error
    }
  }

  async exportArchive(id: string) {
    const project = this.state(id).project
    const files = await this.getSnapshotFiles(id)
    if (files.some(({ path: file }) => file === "_wattful_project.json")) throw badRequest("Project uses a reserved archive filename")
    return createProjectArchive({ version: 1, name: project.name, entrypoint: project.entrypoint }, files)
  }

  async duplicateProject(id: string, name: string, expectedRevision: string) {
    return this.withWriteLock(id, async () => {
      const original = this.state(id)
      this.assertRevision(original.project, expectedRevision)
      const duplicateId = randomUUID()
      const originalDir = this.projectDir(id)
      const duplicateDir = this.projectDir(duplicateId)
      try {
        await mkdir(path.join(duplicateDir, ".workbench"), { recursive: true })
        const files = await this.getFileList(id)
        for (const relative of files) {
          const source = await this.safeFile(id, relative, false)
          const target = path.join(duplicateDir, relative)
          await mkdir(path.dirname(target), { recursive: true })
          const content = await readFile(source)
          await writeFile(target, content)
          this.ownFileHashes.set(target, digest(content))
        }

        const copyInternalFile = async (relative: string) => {
          const source = path.resolve(originalDir, relative)
          if (!source.startsWith(originalDir + path.sep)) throw badRequest("Project metadata contains an invalid file path")
          try {
            const info = await lstat(source)
            if (!info.isFile() || info.isSymbolicLink()) throw badRequest("Project metadata contains an unsupported file")
            const target = path.resolve(duplicateDir, relative)
            if (!target.startsWith(duplicateDir + path.sep)) throw badRequest("Project metadata contains an invalid file path")
            await mkdir(path.dirname(target), { recursive: true })
            const content = await readFile(source)
            await writeFile(target, content)
            this.ownFileHashes.set(target, digest(content))
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
          }
        }
        await copyInternalFile(".workbench/imported-circuit.json")
        for (const reference of original.project.referencePdfs ?? []) {
          if (!isId(reference.id)) throw badRequest("Project metadata contains an invalid PDF reference")
          await copyInternalFile(path.join(".workbench", "references", `${reference.id}.pdf`))
        }
        if (original.preview !== undefined) {
          const preview = Buffer.from(JSON.stringify(original.preview))
          await writeFile(path.join(duplicateDir, ".workbench", "circuit.json"), preview)
        }

        const revision = newRevision()
        const project: ProjectData = {
          ...original.project,
          id: duplicateId,
          name: name.trim(),
          revision,
          ...(original.preview === undefined ? { previewRevision: undefined } : { previewRevision: revision }),
          ...(original.project.lastBuild ? { lastBuild: { ...original.project.lastBuild, buildId: randomUUID(), revision } } : {}),
          ...(original.project.referencePdfs ? { referencePdfs: original.project.referencePdfs.map((reference) => ({ ...reference })) } : {}),
        }
        const duplicate: ProjectState = { project, ...(original.preview === undefined ? {} : { preview: original.preview }) }
        if (this.buildExecutionMode === "trusted-local") await this.linkNodeModules(duplicateDir)
        this.states.set(duplicateId, duplicate)
        await this.persist(duplicate)
        await this.storeSnapshot(duplicateId, revision, await this.getFileList(duplicateId))
        this.watch(duplicateId)
        this.emit(duplicateId, "project", { project })
        this.scheduleBuild(duplicateId, 0)
        return project
      } catch (error) {
        this.states.delete(duplicateId)
        for (const filename of this.ownFileHashes.keys()) {
          if (filename.startsWith(duplicateDir + path.sep)) this.ownFileHashes.delete(filename)
        }
        await rm(duplicateDir, { recursive: true, force: true })
        throw error
      }
    })
  }

  async importSchematics(name: string, files: Array<{ name: string; content: string }>) {
    const converter = new KicadToCircuitJsonConverter()
    const importWarnings: string[] = []
    const easyedaDocuments: unknown[] = []
    let conversionDir: string | undefined
    try {
      for (const file of files) {
        if (!file.name.toLowerCase().endsWith(".json")) {
          converter.addFile(file.name, file.content)
          continue
        }
        let document: { docType?: unknown; schematics?: unknown }
        try { document = JSON.parse(file.content) as typeof document } catch {
          throw badRequest(`File ${file.name} must contain valid EasyEDA Standard JSON`)
        }
        if (document.docType !== "5" || !Array.isArray(document.schematics) || document.schematics.length === 0 || !document.schematics[0] || typeof document.schematics[0] !== "object") {
          throw badRequest(`File ${file.name} is not an EasyEDA Standard schematic document (expected docType 5 with at least one sheet)`)
        }
        easyedaDocuments.push(document)
        importWarnings.push(`${file.name} contains schematic sheets only; PCB placement and 3D geometry are not present in this file.`)
        try {
          const [converted] = convertSchematicV6(document as never, 1, path.basename(file.name, path.extname(file.name)))
          if (!converted?.trim()) throw new Error("converter returned an empty schematic")
          if (!conversionDir) conversionDir = await mkdtemp(path.join(tmpdir(), "wattful-easyeda-"))
          const outputPath = path.join(conversionDir, `${path.basename(file.name, path.extname(file.name))}.kicad_sch`)
          await writeFile(outputPath, converted)
          await execFile(this.kicadCliPath, ["sch", "upgrade", "--force", outputPath], { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 })
          const currentKicad = await readFile(outputPath, "utf8")
          converter.addFile(path.basename(outputPath), currentKicad.replace(/\s+\((?:show_name|do_not_autoplace)\s+(?:yes|no)\)/g, ""))
        } catch (error) {
          const detail = error instanceof Error ? error.message : "conversion failed"
          if ((error as NodeJS.ErrnoException).code === "ENOENT") throw badRequest("EasyEDA import requires KiCad 10 kicad-cli. Install KiCad 10 or set KICAD_CLI_PATH to its executable.")
          throw badRequest(`Unable to convert EasyEDA schematic ${file.name}: ${detail}`)
        }
        if (document.schematics.length > 1) importWarnings.push(`${file.name}: the importer currently brings in sheet 1 of ${document.schematics.length}; other sheets remain in the retained original JSON.`)
      }
      converter.runUntilFinished()
    } catch (error) {
      if ((error as { status?: number })?.status === 400) throw error
      throw badRequest(`Unable to convert schematic: ${error instanceof Error ? error.message : "invalid schematic"}`)
    } finally {
      if (conversionDir) await rm(conversionDir, { recursive: true, force: true })
    }
    const circuitJson = enrichEasyedaComponentMetadata(converter.getOutput(), easyedaDocuments) as ReturnType<typeof converter.getOutput>
    const sourceComponents = circuitJson.filter((item) => item.type === "source_component").length
    if (!sourceComponents) throw badRequest("No schematic components could be imported; check that the files contain supported KiCad symbols")
    let generated: string
    try {
      generated = convertCircuitJsonToTscircuit(circuitJson as never, { componentName: "ImportedSchematic" })
    } catch (error) {
      throw badRequest(`Unable to create editable tscircuit source: ${error instanceof Error ? error.message : "conversion failed"}`)
    }
    const entrypoint = "index.circuit.tsx"
    const source = `${generated}\n\nexport default () => (\n  <board routingDisabled>\n    <ImportedSchematic />\n  </board>\n)\n`
    const id = randomUUID()
    const dir = this.projectDir(id)
    await mkdir(path.join(dir, ".workbench"), { recursive: true })
    await mkdir(path.join(dir, "imports"), { recursive: true })
    const project: ProjectData = { id, name: name.trim(), entrypoint, revision: newRevision() }
    await writeFile(path.join(dir, entrypoint), source)
    await writeFile(path.join(dir, ".workbench", "imported-circuit.json"), JSON.stringify(circuitJson))
    const projectPackage = JSON.stringify({ name: safePackageName(name), private: true, dependencies: { tscircuit: PROJECT_TSCIRCUIT_VERSION } }, null, 2) + "\n"
    await writeFile(path.join(dir, "package.json"), projectPackage)
    for (const file of files) await writeFile(path.join(dir, "imports", path.basename(file.name)), file.content)
    this.ownFileHashes.set(path.join(dir, entrypoint), digest(source))
    this.ownFileHashes.set(path.join(dir, "package.json"), digest(projectPackage))
    for (const file of files) this.ownFileHashes.set(path.join(dir, "imports", path.basename(file.name)), digest(file.content))
    if (this.buildExecutionMode === "trusted-local") await this.linkNodeModules(dir)
    const state: ProjectState = {
      project: { ...project, lastBuild: { buildId: randomUUID(), revision: project.revision, status: "ready", diagnostics: [], updatedAt: new Date().toISOString() }, previewRevision: project.revision },
      preview: circuitJson,
    }
    this.states.set(id, state)
    await this.storeSnapshot(id, project.revision, [entrypoint, "package.json", ...files.map((file) => `imports/${path.basename(file.name)}`)])
    await this.persist(state)
    this.watch(id)
    this.emit(id, "project", { project })
    this.scheduleBuild(id, 0)
    return {
      project,
      sourceComponents,
      warnings: [...importWarnings, ...converter.getWarnings(), "The imported Circuit JSON is the faithful preview; generated tscircuit source is best-effort. Editing the source switches future builds to normal tscircuit compilation."],
    }
  }

  async importPdfReference(name: string, filename: string, content: Buffer) {
    const project = await this.create(name, "blank-board")
    const state = this.state(project.id)
    const id = randomUUID()
    const referencesDir = path.join(this.projectDir(project.id), ".workbench", "references")
    await mkdir(referencesDir, { recursive: true })
    await writeFile(path.join(referencesDir, `${id}.pdf`), content)
    state.project.referencePdfs = [...(state.project.referencePdfs ?? []), { id, name: filename }]
    await this.persist(state)
    this.emit(project.id, "project", { project: state.project })
    return state.project
  }

  async readReferencePdf(projectId: string, referenceId: string) {
    const reference = this.state(projectId).project.referencePdfs?.find((item) => item.id === referenceId)
    if (!reference) throw Object.assign(new Error("PDF reference not found"), { status: 404 })
    const content = await readFile(path.join(this.projectDir(projectId), ".workbench", "references", `${reference.id}.pdf`))
    return { name: reference.name, content }
  }

  async get(id: string) {
    return this.state(id).project
  }

  async exportGerbers(id: string) {
    this.state(id)
    return createGerberArchive(this.projectDir(id), ".workbench/circuit.json")
  }

  async renameProject(id: string, name: string, expectedRevision: string) {
    const state = this.state(id)
    this.assertRevision(state.project, expectedRevision)
    state.project.name = name.trim()
    state.project.revision = newRevision()
    await this.persist(state)
    this.emit(id, "project", { project: state.project })
    return state.project
  }

  async deleteProject(id: string, expectedRevision: string, confirmation: string) {
    const state = this.state(id)
    this.assertRevision(state.project, expectedRevision)
    if (confirmation !== state.project.name) throw badRequest("X-Confirm-Delete must exactly match the project name")
    this.deletingProjects.add(id)
    await this.writeQueues.get(id)
    const timer = this.timers.get(id)
    if (timer) clearTimeout(timer)
    this.timers.delete(id)
    while (this.buildsRunning.has(id)) await new Promise((resolve) => setTimeout(resolve, 10))
    const watcher = this.watchers.get(id)
    if (watcher) await watcher.close()
    this.watchers.delete(id)
    for (const client of this.eventClients.get(id) ?? []) client.end()
    this.eventClients.delete(id)
    this.states.delete(id)
    const projectDir = this.projectDir(id)
    for (const filename of this.ownFileHashes.keys()) {
      if (filename.startsWith(projectDir + path.sep)) this.ownFileHashes.delete(filename)
    }
    await rm(projectDir, { recursive: true, force: true })
    this.deletingProjects.delete(id)
    this.writeQueues.delete(id)
  }

  async readFile(id: string, relativePath: string) {
    const absolute = await this.safeFile(id, relativePath, false)
    const content = await readFile(absolute, "utf8")
    return { path: cleanRelative(relativePath), content, revision: this.state(id).project.revision }
  }

  async generatePcbDraft(id: string, expectedRevision: string) {
    return this.withWriteLock(id, async () => {
      const state = this.state(id)
      this.assertRevision(state.project, expectedRevision)
      let original: unknown
      try { original = JSON.parse(await readFile(path.join(this.projectDir(id), ".workbench", "imported-circuit.json"), "utf8")) } catch { /* Rebuild it from the retained source below. */ }
      const easyedaPath = (await this.getFileList(id)).find((file) => /^imports\/[^/]+\.json$/i.test(file))
      const alreadyHasPcb = Array.isArray(original) && original.some((item) => (item as { type?: string }).type === "pcb_component")
      if (easyedaPath && (!Array.isArray(original) || alreadyHasPcb)) {
        try { original = await convertEasyedaFileToCircuit(path.basename(easyedaPath), await readFile(await this.safeFile(id, easyedaPath, false), "utf8"), this.kicadCliPath) }
        catch (error) { throw badRequest(`Unable to refresh EasyEDA component metadata: ${error instanceof Error ? error.message : "conversion failed"}`) }
      }
      if (!Array.isArray(original)) throw badRequest("PCB draft generation is available for imported schematics")
      let draft: ReturnType<typeof withGeneratedPcbDraft>
      try { draft = withGeneratedPcbDraft(original) }
      catch (error) { throw badRequest(error instanceof Error ? error.message : "Unable to generate PCB draft") }
      let source: string
      try { source = convertCircuitJsonToTscircuit(draft.circuitJson as never, { componentName: "ImportedBoard" }) }
      catch (error) { throw badRequest(`Unable to generate PCB layout: ${error instanceof Error ? error.message : "conversion failed"}`) }
      const revision = newRevision()
      const entryPath = path.join(this.projectDir(id), state.project.entrypoint)
      const circuitPath = path.join(this.projectDir(id), ".workbench", "imported-circuit.json")
      await writeFile(entryPath + ".tmp", source, "utf8")
      await writeFile(circuitPath + ".tmp", JSON.stringify(draft.circuitJson), "utf8")
      await rename(entryPath + ".tmp", entryPath)
      await rename(circuitPath + ".tmp", circuitPath)
      this.ownFileHashes.set(entryPath, digest(source))
      state.project.revision = revision
      state.project.previewRevision = revision
      state.project.lastBuild = { buildId: randomUUID(), revision, status: "ready", diagnostics: [{ severity: "warning", message: "Generated PCB placements and generic pads are a draft. Verify footprints, pin mapping, component body models, and routing before fabrication." }], updatedAt: new Date().toISOString() }
      state.preview = draft.circuitJson
      await this.storeSnapshot(id, revision, [state.project.entrypoint, ".workbench/imported-circuit.json"])
      await this.persist(state)
      this.emit(id, "project", { project: state.project })
      return { revision, placements: draft.placements }
    })
  }

  async writeFile(id: string, relativePath: string, content: string, expectedRevision: string) {
    return this.withWriteLock(id, async () => {
      const state = this.state(id)
      this.assertRevision(state.project, expectedRevision)
      const absolute = await this.safeFile(id, relativePath, true)
      await mkdir(path.dirname(absolute), { recursive: true })
      const temporary = absolute + "." + randomUUID() + ".tmp"
      await writeFile(temporary, content, "utf8")
      await rename(temporary, absolute)
      await rm(path.join(this.projectDir(id), ".workbench", "imported-circuit.json"), { force: true })
      this.ownFileHashes.set(absolute, digest(content))
      state.project.revision = newRevision()
      await this.storeSnapshot(id, state.project.revision, [cleanRelative(relativePath)])
      await this.persist(state)
      const result = { path: cleanRelative(relativePath), revision: state.project.revision }
      this.emit(id, "file", result)
      this.scheduleBuild(id, 250)
      return result
    })
  }

  async getFileList(id: string) {
    const dir = this.projectDir(id)
    const out: string[] = []
    const visit = async (base: string, relative: string): Promise<void> => {
      for (const item of await readdir(base, { withFileTypes: true })) {
        if (item.name.startsWith(".") || ["node_modules", "dist"].includes(item.name)) continue
        const rel = path.posix.join(relative, item.name)
        if (item.isDirectory()) await visit(path.join(base, item.name), rel)
        else if (item.isFile()) out.push(rel)
      }
    }
    await visit(dir, "")
    return out.sort()
  }

  async getSnapshotFiles(id: string) {
    const files = await this.getFileList(id)
    return Promise.all(files.map(async (relativePath) => ({
      path: relativePath,
      content: await readFile(await this.safeFile(id, relativePath, false), "utf8"),
    })))
  }

  async listHistory(id: string) {
    const snapshots = await this.readSnapshots(id)
    const commits = await this.git.listRevisions(this.projectDir(id)).catch(() => [])
    const entries = new Map<string, { revision: string; createdAt: string; changedFiles: string[]; sizeBytes?: number; commit?: string; retainedSnapshot: boolean }>()
    for (const commit of commits) {
      if (!commit.revision) continue
      entries.set(commit.revision, { revision: commit.revision, createdAt: commit.createdAt, changedFiles: commit.changedFiles, commit: commit.commit, retainedSnapshot: false })
    }
    for (const snapshot of snapshots) {
      const existing = entries.get(snapshot.revision)
      entries.set(snapshot.revision, {
        revision: snapshot.revision,
        createdAt: snapshot.createdAt,
        changedFiles: snapshot.changedFiles,
        sizeBytes: snapshot.sizeBytes,
        ...(existing?.commit ? { commit: existing.commit } : {}),
        retainedSnapshot: true,
      })
    }
    const revisions = [...entries.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    const designs = new Set((await readdir(path.join(this.projectDir(id), ".workbench", "designs")).catch(() => []))
      .filter((name) => name.endsWith(".json")).map((name) => name.replace(/\.json$/, "")))
    return {
      gitBacked: await this.git.isAvailable(),
      snapshotRetention: HISTORY_RETENTION,
      revisions: revisions.map((entry) => ({ ...entry, hasDesignSummary: designs.has(entry.revision) })),
    }
  }

  async compareHistory(id: string, from: string, to: string) {
    const [before, after] = await Promise.all([this.readRevisionFiles(id, from), this.readRevisionFiles(id, to)])
    if (!before || !after) throw Object.assign(new Error("Project revision not found in project history"), { status: 404 })
    const changedPaths = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])]
      .filter((file) => before.files[file] !== after.files[file]).sort()
    const [beforeDesign, afterDesign] = await Promise.all([this.readDesignSummary(id, before.revision), this.readDesignSummary(id, after.revision)])
    const missing = [...(beforeDesign ? [] : [before.revision]), ...(afterDesign ? [] : [after.revision])]
    return {
      from: before.revision,
      to: after.revision,
      files: changedPaths.map((file) => ({ path: file, before: before.files[file] ?? null, after: after.files[file] ?? null })),
      design: beforeDesign && afterDesign ? diffDesignSummaries(beforeDesign, afterDesign) : designDiffUnavailable(missing),
    }
  }

  async restoreHistory(id: string, revision: string, expectedRevision: string) {
    return this.withWriteLock(id, async () => {
      const state = this.state(id)
      this.assertRevision(state.project, expectedRevision)
      await rm(path.join(this.projectDir(id), ".workbench", "imported-circuit.json"), { force: true })
      const snapshot = await this.readRevisionFiles(id, revision)
      if (!snapshot) throw Object.assign(new Error("Project revision not found in project history"), { status: 404 })
      const currentFiles = await this.getFileList(id)
      const currentContent = new Map<string, string>()
      for (const relative of currentFiles) currentContent.set(relative, await readFile(await this.safeFile(id, relative, false), "utf8"))
      const actualChangedFiles = [...new Set([...currentFiles, ...Object.keys(snapshot.files)])]
        .filter((relative) => currentContent.get(relative) !== snapshot.files[relative])
      for (const relative of Object.keys(snapshot.files)) {
        if (!actualChangedFiles.includes(relative)) continue
        const target = await this.safeFile(id, relative, true)
        await mkdir(path.dirname(target), { recursive: true })
        const temporary = target + "." + randomUUID() + ".tmp"
        await writeFile(temporary, snapshot.files[relative]!, "utf8")
        await rename(temporary, target)
        this.ownFileHashes.set(target, digest(snapshot.files[relative]!))
      }
      for (const relative of currentFiles) {
        if (Object.hasOwn(snapshot.files, relative)) continue
        const target = await this.safeFile(id, relative, false)
        this.ownFileDeletes.add(target)
        this.ownFileHashes.delete(target)
        await rm(target, { force: true })
      }
      state.project.revision = newRevision()
      await this.storeSnapshot(id, state.project.revision, actualChangedFiles)
      await this.persist(state)
      const result = { revision: state.project.revision, restoredFrom: snapshot.revision, changedFiles: actualChangedFiles.sort() }
      for (const relative of result.changedFiles) this.emit(id, "file", { path: relative, revision: result.revision })
      this.scheduleBuild(id, 250, undefined, result.revision)
      return result
    })
  }

  async preview(id: string) {
    const state = this.state(id)
    if (state.preview === undefined) {
      const error = new Error("No successful preview is available yet")
      Object.assign(error, { status: 404 })
      throw error
    }
    return { revision: state.project.previewRevision ?? state.project.revision, circuitJson: state.preview }
  }

  subscribe(id: string, response: Response) {
    this.state(id)
    let clients = this.eventClients.get(id)
    if (!clients) {
      clients = new Set()
      this.eventClients.set(id, clients)
    }
    clients.add(response)
    response.on("close", () => clients?.delete(response))
    this.send(response, "project", { project: this.state(id).project })
  }

  requestBuild(id: string) {
    const state = this.state(id)
    if (this.deletingProjects.has(id)) throw badRequest("Project is being deleted")
    const buildId = randomUUID()
    const revision = state.project.revision
    state.project.lastBuild = { buildId, revision, status: "compiling", diagnostics: [], updatedAt: new Date().toISOString() }
    this.persist(state).catch(() => undefined)
    this.emit(id, "build.status", { buildId, revision, status: "compiling", step: "compiling" })
    if (this.buildsRunning.has(id)) {
      this.queuedBuilds.set(id, { buildId, revision })
      this.rerunBuild.add(id)
    }
    else this.scheduleBuild(id, 0, buildId, revision)
    return { buildId, status: "compiling" }
  }

  async close() {
    for (const timer of this.timers.values()) clearTimeout(timer)
    await Promise.all([...this.watchers.values()].map((watcher) => watcher.close()))
    this.watchers.clear()
    while (this.buildsRunning.size > 0) await new Promise((resolve) => setTimeout(resolve, 10))
    await Promise.all(this.closeHandlers.map((close) => close()))
  }

  onClose(close: () => Promise<void>) {
    this.closeHandlers.push(close)
  }

  private async withWriteLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.writeQueues.get(id) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    this.writeQueues.set(id, current)
    await previous
    try {
      if (this.deletingProjects.has(id)) throw badRequest("Project is being deleted")
      return await operation()
    } finally {
      release()
      if (this.writeQueues.get(id) === current) this.writeQueues.delete(id)
    }
  }

  private assertRevision(project: ProjectData, expectedRevision: string) {
    if (!expectedRevision || expectedRevision !== project.revision) {
      const error = new Error("Project changed since this project was read")
      Object.assign(error, { status: 409, revision: project.revision })
      throw error
    }
  }

  private projectDir(id: string) {
    if (!isId(id)) {
      const error = new Error("Project not found")
      Object.assign(error, { status: 404 })
      throw error
    }
    return path.join(this.root, id)
  }

  private state(id: string) {
    const state = this.states.get(id)
    if (!state) {
      const error = new Error("Project not found")
      Object.assign(error, { status: 404 })
      throw error
    }
    return state
  }

  private async safeFile(id: string, input: string, forWrite: boolean) {
    const relative = cleanRelative(input)
    const projectRoot = this.projectDir(id)
    const absolute = path.resolve(projectRoot, relative)
    if (!absolute.startsWith(projectRoot + path.sep)) throw badRequest("Invalid project file path")
    let current = projectRoot
    const parts = relative.split("/")
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]!)
      try {
        const info = await lstat(current)
        if (info.isSymbolicLink()) throw badRequest("Symbolic links are not supported in project files")
        if (index < parts.length - 1 && !info.isDirectory()) throw badRequest("Invalid project file path")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && forWrite) break
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw Object.assign(new Error("File not found"), { status: 404 })
        throw error
      }
    }
    return absolute
  }

  private async load(id: string): Promise<ProjectState | undefined> {
    try {
      const raw = await readFile(path.join(this.projectDir(id), ".workbench", "project.json"), "utf8")
      const project = JSON.parse(raw) as ProjectData
      let preview: unknown
      try { preview = JSON.parse(await readFile(path.join(this.projectDir(id), ".workbench", "circuit.json"), "utf8")) } catch { /* No successful build yet. */ }
      return { project, preview }
    } catch { return undefined }
  }

  private async persist(state: ProjectState) {
    const metadataDir = path.join(this.projectDir(state.project.id), ".workbench")
    await mkdir(metadataDir, { recursive: true })
    const temporary = path.join(metadataDir, "project.json." + randomUUID() + ".tmp")
    await writeFile(temporary, JSON.stringify(state.project, null, 2))
    await rename(temporary, path.join(metadataDir, "project.json"))
  }

  private async storeSnapshot(id: string, revision: string, changedFiles: string[]) {
    const previous = await this.readSnapshots(id)
    const now = Date.now()
    const previousTime = previous[0] ? Date.parse(previous[0].createdAt) : 0
    const files = Object.create(null) as Record<string, string>
    for (const relative of await this.getFileList(id)) {
      try { files[relative] = await readFile(await this.safeFile(id, relative, false), "utf8") } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
    }
    const snapshot: ProjectSnapshot = {
      revision,
      createdAt: new Date(Math.max(now, previousTime + 1)).toISOString(),
      changedFiles: [...new Set(changedFiles)].sort(),
      sizeBytes: Object.entries(files).reduce((total, [name, content]) => total + Buffer.byteLength(name) + Buffer.byteLength(content), 0),
      files,
    }
    const historyDir = path.join(this.projectDir(id), ".workbench", "history")
    await mkdir(historyDir, { recursive: true })
    const temporary = path.join(historyDir, revision + ".json." + randomUUID() + ".tmp")
    await writeFile(temporary, JSON.stringify(snapshot))
    await rename(temporary, path.join(historyDir, revision + ".json"))
    const retained = await this.readSnapshots(id)
    for (const old of retained.slice(HISTORY_RETENTION)) await rm(path.join(historyDir, old.revision + ".json"), { force: true })
    try {
      await this.git.commitRevision(this.projectDir(id), revision, snapshot.changedFiles)
    } catch (error) {
      // History stays readable from snapshots when Git is unavailable or fails.
      console.error(`Git history commit failed for project ${id}`, error)
    }
  }

  /** Retain what a successful build produced, so two revisions can be compared later. */
  private async storeDesignSummary(id: string, revision: string, circuitJson: unknown) {
    try {
      const dir = path.join(this.projectDir(id), ".workbench", "designs")
      await mkdir(dir, { recursive: true })
      const summary = summarizeDesign(circuitJson, revision)
      const temporary = path.join(dir, revision + ".json." + randomUUID() + ".tmp")
      await writeFile(temporary, JSON.stringify(summary))
      await rename(temporary, path.join(dir, revision + ".json"))
      const names = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort()
      if (names.length > DESIGN_SUMMARY_RETENTION) {
        const summaries = await Promise.all(names.map(async (name) => ({ name, summary: await this.readDesignSummary(id, name.replace(/\.json$/, "")) })))
        const ordered = summaries.filter((item) => item.summary).sort((left, right) => (right.summary!.createdAt).localeCompare(left.summary!.createdAt))
        for (const old of ordered.slice(DESIGN_SUMMARY_RETENTION)) await rm(path.join(dir, old.name), { force: true })
      }
    } catch (error) {
      console.error(`Design summary could not be retained for project ${id}`, error)
    }
  }

  private async readDesignSummary(id: string, revision: string): Promise<DesignSummary | undefined> {
    try {
      const file = path.join(this.projectDir(id), ".workbench", "designs", revision + ".json")
      const summary = JSON.parse(await readFile(file, "utf8")) as DesignSummary
      return summary && Array.isArray(summary.components) ? summary : undefined
    } catch { return undefined }
  }

  /** Read a revision's files from its retained snapshot, or from Git when the snapshot has aged out. */
  private async readRevisionFiles(id: string, revision: string): Promise<{ revision: string; files: Record<string, string> } | undefined> {
    const snapshot = (await this.readSnapshots(id)).find((item) => item.revision === revision)
    if (snapshot) return { revision: snapshot.revision, files: snapshot.files }
    const commit = await this.git.resolveRevision(this.projectDir(id), revision)
    if (!commit) return undefined
    return { revision, files: await this.git.filesAt(this.projectDir(id), commit) }
  }

  private async readSnapshots(id: string): Promise<ProjectSnapshot[]> {
    const historyDir = path.join(this.projectDir(id), ".workbench", "history")
    let names: string[]
    try { names = (await readdir(historyDir)).filter((name) => name.endsWith(".json")) } catch { return [] }
    const snapshots: ProjectSnapshot[] = []
    for (const name of names) {
      try {
        const snapshot = JSON.parse(await readFile(path.join(historyDir, name), "utf8")) as ProjectSnapshot
        if (snapshot && typeof snapshot.revision === "string" && snapshot.files && typeof snapshot.files === "object") snapshots.push(snapshot)
      } catch { /* Ignore incomplete snapshot files. */ }
    }
    return snapshots.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  private async linkNodeModules(projectDir: string) {
    try { await access(path.join(projectDir, "node_modules")); return } catch { /* link shared pinned CLI packages */ }
    try { await symlink(this.appNodeModules, path.join(projectDir, "node_modules"), "dir") } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
  }

  private watch(id: string) {
    if (!this.watchFiles || this.watchers.has(id)) return
    const watcher = chokidar.watch(this.projectDir(id), {
      ignoreInitial: true,
      ignored: /(^|[/\\])(?:\.workbench|node_modules|dist|\.tscircuit|\.git)([/\\]|$)/,
      awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 30 },
    })
    this.watchers.set(id, watcher)
    watcher.on("all", (event, changedPath) => {
      if (event !== "add" && event !== "change" && event !== "unlink") return
      if (changedPath.endsWith(".tmp")) return
      const absolutePath = path.isAbsolute(changedPath) ? changedPath : path.resolve(this.projectDir(id), changedPath)
      if (event !== "unlink") {
        void readFile(absolutePath).then((contents) => {
          if (this.ownFileHashes.get(absolutePath) === digest(contents)) {
            this.ownFileHashes.delete(absolutePath)
            return
          }
          this.recordExternalChange(id, absolutePath)
        }).catch(() => this.recordExternalChange(id, absolutePath))
        return
      }
      if (this.ownFileDeletes.delete(absolutePath)) return
      this.recordExternalChange(id, absolutePath)
    })
  }

  private recordExternalChange(id: string, absolutePath: string) {
    const relative = path.relative(this.projectDir(id), absolutePath).split(path.sep).join("/")
    void this.withWriteLock(id, async () => {
      const state = this.states.get(id)
      if (!state) return
      await rm(path.join(this.projectDir(id), ".workbench", "imported-circuit.json"), { force: true })
      state.project.revision = newRevision()
      await this.storeSnapshot(id, state.project.revision, [relative])
      await this.persist(state)
      this.emit(id, "file", { path: relative, revision: state.project.revision })
      this.scheduleBuild(id, 300)
    })
  }

  private scheduleBuild(id: string, delay: number, buildId?: string, revision?: string) {
    if (this.deletingProjects.has(id)) return
    const old = this.timers.get(id)
    if (old) clearTimeout(old)
    const timer = setTimeout(() => {
      this.timers.delete(id)
      if (this.buildsRunning.has(id)) {
        if (buildId && revision) this.queuedBuilds.set(id, { buildId, revision })
        this.rerunBuild.add(id)
        return
      }
      void this.performBuild(id, buildId ?? randomUUID(), revision ?? this.state(id).project.revision)
    }, delay)
    this.timers.set(id, timer)
  }

  private async performBuild(id: string, buildId: string, revision: string) {
    this.buildsRunning.add(id)
    const state = this.state(id)
    state.project.lastBuild = { buildId, revision, status: "compiling", diagnostics: [], updatedAt: new Date().toISOString() }
    try {
      await this.persist(state)
      this.emit(id, "build.status", { buildId, revision, status: "compiling", step: "compiling" })
      let circuitJson: unknown
      let buildDiagnostics: Diagnostic[] = []
      try { circuitJson = JSON.parse(await readFile(path.join(this.projectDir(id), ".workbench", "imported-circuit.json"), "utf8")) }
      catch {
        const build = await this.executeBuild(this.projectDir(id), state.project.entrypoint)
        if (isIsolatedBuildResult(build)) {
          circuitJson = build.circuitJson
          if (build.isolation === "container-only") buildDiagnostics = [{ severity: "warning", message: `Build used standard ${build.runtime} container isolation only; this is not a strong sandbox for hostile project code. Configure the runsc runtime for the build worker.` }]
          else buildDiagnostics = [{ severity: "info", message: "Build ran in the configured runsc gVisor sandbox." }]
        } else circuitJson = build
      }
      if (state.project.revision !== revision) { this.rerunBuild.add(id); return }
      state.preview = circuitJson
      state.project.previewRevision = revision
      const previewFile = path.join(this.projectDir(id), ".workbench", "circuit.json")
      const temporary = previewFile + ".tmp"
      await writeFile(temporary, JSON.stringify(circuitJson))
      await rename(temporary, previewFile)
      const record: BuildRecord = { buildId, revision, status: "ready", diagnostics: buildDiagnostics, updatedAt: new Date().toISOString() }
      state.project.lastBuild = record
      await this.storeDesignSummary(id, revision, circuitJson)
      await this.persist(state)
      this.emit(id, "build.ready", { buildId, revision, artifacts: { circuitJsonUrl: `/api/projects/${id}/preview?kind=pcb` } })
    } catch (error) {
      const diagnostics = diagnosticsFrom(error)
      state.project.lastBuild = { buildId, revision, status: "failed", diagnostics, updatedAt: new Date().toISOString() }
      await this.persist(state)
      this.emit(id, "build.failed", { buildId, revision, diagnostics })
    } finally {
      this.buildsRunning.delete(id)
      if (this.rerunBuild.delete(id)) {
        const queuedBuild = this.queuedBuilds.get(id)
        this.queuedBuilds.delete(id)
        this.scheduleBuild(id, 0, queuedBuild?.buildId, queuedBuild?.revision)
      }
    }
  }

  private async executeBuild(projectDir: string, entrypoint: string): Promise<unknown | IsolatedBuildResult> {
    if (this.buildCircuit) return this.buildCircuit(projectDir, entrypoint)
    if (this.buildExecutionMode === "trusted-local") return runTscircuitBuild(projectDir, entrypoint)
    const files = await this.getFileList(path.basename(projectDir))
    const source = []
    let size = 0
    for (const file of files) {
      const content = await readFile(await this.safeFile(path.basename(projectDir), file, false), "utf8")
      size += Buffer.byteLength(file) + Buffer.byteLength(content)
      if (size > 8 * 1024 * 1024) throw new Error("Project source exceeds the isolated build size limit")
      source.push({ path: file, content })
    }
    const tokenFile = process.env.BUILD_RUNNER_TOKEN_FILE
    const token = tokenFile ? (await readFile(tokenFile, "utf8")).trim() : process.env.BUILD_RUNNER_TOKEN ?? ""
    return executeRemoteBuild({ entrypoint, files: source }, {
      url: this.buildRunner?.url ?? process.env.BUILD_RUNNER_URL ?? "http://build-runner:3020",
      token: this.buildRunner?.token ?? token,
    })
  }

  private emit(id: string, event: ServerEvent, data: unknown) {
    for (const response of this.eventClients.get(id) ?? []) this.send(response, event, data)
  }

  private send(response: Response, event: ServerEvent, data: unknown) {
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
}

export function createApp(options: AppOptions = {}): Express {
  const workbenchToken = options.workbenchAuthToken ?? process.env.WORKBENCH_AUTH_TOKEN
  if (workbenchToken && Buffer.byteLength(workbenchToken) < 32) {
    throw new Error("WORKBENCH_AUTH_TOKEN must contain at least 32 bytes")
  }
  const service = new ProjectService(options)
  const app = express()
  if (workbenchToken) {
    app.use((request, response, next) => {
      // MCP has its own bearer-token verifier. Keep health checks available to
      // container orchestrators; protect the browser, REST API, and assets.
      if (request.path === "/mcp" || (request.path === "/healthz" && request.method === "GET")) return next()
      if (!hasWorkbenchCredential(request.get("authorization"), workbenchToken)) {
        response.set("WWW-Authenticate", 'Basic realm="Wattful-Iron", charset="UTF-8"')
        response.status(401).json({ error: "Workbench authentication required" })
        return
      }
      next()
    })
  }
  app.use(express.json({ limit: "2mb" }))
  app.locals.projectService = service
  app.use(async (_request, _response, next) => {
    try { await service.ready; next() } catch (error) { next(error) }
  })

  app.get("/healthz", (_request, response) => response.json({ status: "ok" }))
  const token = options.mcpAuthToken ?? process.env.MCP_AUTH_TOKEN
  const sourcing = createConfiguredSourcing(options.componentSourcing)
  mountMcp(app, service, token, sourcing)
  mountManufacturingRoutes(app, service, sourcing)
  app.get("/api/components/:part", async (request, response, next) => {
    try {
      if (!sourcing) return response.status(503).json({ configured: false, error: "No component sourcing provider is configured. Set COMPONENT_SOURCING_URL to enable supplier lookups." })
      const part = normalizeLcscPartNumber(request.params.part)
      if (!part) throw badRequest("Component lookups take an LCSC part number such as C2040")
      const sourced = await sourcing.lookup(part)
      if (!sourced) return response.status(404).json({ configured: true, error: `The supplier index returned no part for ${part}` })
      response.json({ configured: true, provider: sourcing.provider, part: sourced })
    } catch (error) { next(error) }
  })
  app.get("/api/projects/:id/bom-cost", async (request, response, next) => {
    try {
      const preview = await service.preview(request.params.id!)
      if (!sourcing) return response.status(200).json({
        configured: false,
        revision: preview.revision,
        parts: listDesignParts(preview.circuitJson),
        message: "No component sourcing provider is configured, so no prices or stock were looked up. Set COMPONENT_SOURCING_URL to enable it.",
      })
      const boards = request.query.boards === undefined ? 1 : Number(request.query.boards)
      if (!Number.isInteger(boards)) throw badRequest("boards must be a whole number")
      response.json({ configured: true, provider: sourcing.provider, revision: preview.revision, ...await estimateBomCost(preview.circuitJson, sourcing, boards) })
    } catch (error) { next(error) }
  })
  app.get("/api/projects", async (_request, response, next) => {
    try { response.json(await service.list()) } catch (error) { next(error) }
  })
  app.get("/api/examples", (_request, response) => response.json(templates))
  app.post("/api/projects", async (request, response, next) => {
    try {
      const name = typeof request.body?.name === "string" ? request.body.name.trim() : ""
      if (!name || name.length > 100) throw badRequest("Project name must contain 1 to 100 characters")
      const templateId = request.body?.templateId
      if (templateId !== undefined && typeof templateId !== "string") throw badRequest("Project template must be a string")
      response.status(201).json(await service.create(name, templateId))
    } catch (error) { next(error) }
  })
  app.post("/api/projects/:id/duplicate", async (request, response, next) => {
    try {
      const name = typeof request.body?.name === "string" ? request.body.name.trim() : ""
      if (!name || name.length > 100) throw badRequest("Project name must contain 1 to 100 characters")
      const revision = request.get("If-Match")?.replace(/^"|"$/g, "") ?? ""
      response.status(201).json(await service.duplicateProject(request.params.id!, name, revision))
    } catch (error) { next(error) }
  })
  app.post("/api/projects/import", async (request, response, next) => {
    try {
      const name = typeof request.body?.name === "string" ? request.body.name.trim() : ""
      const files = request.body?.files
      if (!name || name.length > 100) throw badRequest("Project name must contain 1 to 100 characters")
      if (!Array.isArray(files) || files.length < 1 || files.length > 10) throw badRequest("Choose between 1 and 10 KiCad or EasyEDA Standard schematic files")
      let totalBytes = 0
      const normalized = files.map((file: unknown) => {
        const candidate = file as { name?: unknown; content?: unknown }
        if (typeof candidate.name !== "string" || typeof candidate.content !== "string") throw badRequest("Each schematic must include a filename and text content")
        const filename = path.basename(candidate.name)
        if (filename !== candidate.name || !/\.(kicad_sch|json)$/i.test(filename)) throw badRequest("Only KiCad .kicad_sch and EasyEDA Standard .json schematic files are supported")
        totalBytes += Buffer.byteLength(candidate.content)
        return { name: filename, content: candidate.content }
      })
      if (new Set(normalized.map((file) => file.name.toLowerCase())).size !== normalized.length) throw badRequest("Schematic filenames must be unique")
      if (totalBytes > 1_800_000) throw badRequest("Combined schematic size must be under 1.8 MB")
      response.status(201).json(await service.importSchematics(name, normalized))
    } catch (error) { next(error) }
  })
  app.get("/api/projects/:id/export", async (request, response, next) => {
    try {
      const archive = await service.exportArchive(request.params.id!)
      response.type("application/zip").set({
        "Content-Disposition": 'attachment; filename="project.zip"',
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      }).send(Buffer.from(archive))
    } catch (error) { next(error) }
  })
  app.post("/api/projects/import-archive", express.raw({ type: "application/zip", limit: "20mb" }), async (request, response, next) => {
    try {
      if (!Buffer.isBuffer(request.body)) throw badRequest("Send the project archive as application/zip bytes")
      let parsed: ReturnType<typeof parseProjectArchive>
      try { parsed = parseProjectArchive(request.body) } catch (error) { throw badRequest(error instanceof Error ? error.message : "Invalid project archive") }
      const requestedName = typeof request.query.name === "string" ? request.query.name.trim() : ""
      const name = requestedName || parsed.manifest.name
      if (!name || name.length > 100) throw badRequest("Project name must contain 1 to 100 characters")
      try {
        for (const file of parsed.files) cleanRelative(file.path)
        cleanRelative(parsed.manifest.entrypoint)
      } catch (error) { throw badRequest(error instanceof Error ? error.message : "Archive contains an invalid project path") }
      response.status(201).json(await service.importArchive(name, parsed.manifest.entrypoint, parsed.files))
    } catch (error) { next(error) }
  })
  app.post("/api/projects/import-pdf", express.raw({ type: "application/pdf", limit: "20mb" }), async (request, response, next) => {
    try {
      const name = typeof request.query.name === "string" ? request.query.name.trim() : ""
      const filename = typeof request.query.filename === "string" ? request.query.filename : ""
      if (!name || name.length > 100) throw badRequest("Project name must contain 1 to 100 characters")
      if (!filename || path.basename(filename) !== filename || !/\.pdf$/i.test(filename)) throw badRequest("A PDF filename is required")
      if (!Buffer.isBuffer(request.body) || request.body.length < 8 || request.body.toString("ascii", 0, 5) !== "%PDF-") throw badRequest("The uploaded file is not a valid PDF document")
      response.status(201).json(await service.importPdfReference(name, filename, request.body))
    } catch (error) { next(error) }
  })
  app.get("/api/projects/:id/references/:referenceId", async (request, response, next) => {
    try {
      const reference = await service.readReferencePdf(request.params.id!, request.params.referenceId!)
      response.type("application/pdf").set({
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(reference.name)}`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      }).send(reference.content)
    } catch (error) { next(error) }
  })
  app.get("/api/projects/:id", async (request, response, next) => {
    try { response.json(await service.get(request.params.id!)) } catch (error) { next(error) }
  })
  app.patch("/api/projects/:id", async (request, response, next) => {
    try {
      const name = typeof request.body?.name === "string" ? request.body.name.trim() : ""
      if (!name || name.length > 100) throw badRequest("Project name must contain 1 to 100 characters")
      const match = request.get("If-Match")?.replace(/^"|"$/g, "")
      response.json(await service.renameProject(request.params.id!, name, match ?? ""))
    } catch (error) { next(error) }
  })
  app.delete("/api/projects/:id", async (request, response, next) => {
    try {
      const match = request.get("If-Match")?.replace(/^"|"$/g, "")
      await service.deleteProject(request.params.id!, match ?? "", request.get("X-Confirm-Delete") ?? "")
      response.status(204).end()
    } catch (error) { next(error) }
  })
  app.get("/api/projects/:id/files", async (request, response, next) => {
    try {
      if (typeof request.query.path !== "string") throw badRequest("Query parameter path is required")
      response.json(await service.readFile(request.params.id!, request.query.path))
    } catch (error) { next(error) }
  })
  app.put("/api/projects/:id/files", async (request, response, next) => {
    try {
      if (typeof request.query.path !== "string") throw badRequest("Query parameter path is required")
      if (typeof request.body?.content !== "string") throw badRequest("File content must be a string")
      const match = request.get("If-Match")?.replace(/^"|"$/g, "")
      if (!match || request.body.revision !== match) throw badRequest("If-Match and body revision must match")
      response.json(await service.writeFile(request.params.id!, request.query.path, request.body.content, match))
    } catch (error) { next(error) }
  })
  app.post("/api/projects/:id/generate-pcb", async (request, response, next) => {
    try {
      const match = request.get("If-Match")?.replace(/^"|"$/g, "")
      if (!match) throw badRequest("If-Match is required to generate PCB placements")
      response.json(await service.generatePcbDraft(request.params.id!, match))
    } catch (error) { next(error) }
  })
  app.get("/api/projects/:id/file-list", async (request, response, next) => {
    try { response.json(await service.getFileList(request.params.id!)) } catch (error) { next(error) }
  })
  app.get("/api/projects/:id/history", async (request, response, next) => {
    try { response.json(await service.listHistory(request.params.id!)) } catch (error) { next(error) }
  })
  app.get("/api/projects/:id/history/compare", async (request, response, next) => {
    try {
      if (typeof request.query.from !== "string" || typeof request.query.to !== "string") throw badRequest("Query parameters from and to are required")
      response.json(await service.compareHistory(request.params.id!, request.query.from, request.query.to))
    } catch (error) { next(error) }
  })
  app.post("/api/projects/:id/history/:revision/restore", async (request, response, next) => {
    try {
      const match = request.get("If-Match")?.replace(/^"|"$/g, "")
      if (!match) throw badRequest("If-Match is required to restore project history")
      response.json(await service.restoreHistory(request.params.id!, request.params.revision!, match))
    } catch (error) { next(error) }
  })
  app.post("/api/projects/:id/build", (request, response, next) => {
    try { response.status(202).json(service.requestBuild(request.params.id!)) } catch (error) { next(error) }
  })
  app.get("/api/projects/:id/events", (request, response, next) => {
    try {
      response.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" })
      response.flushHeaders()
      service.subscribe(request.params.id!, response)
    } catch (error) { next(error) }
  })
  app.get("/api/projects/:id/preview", async (request, response, next) => {
    try {
      const kind = request.query.kind
      if (!["schematic", "pcb", "3d"].includes(String(kind))) throw badRequest("kind must be schematic, pcb, or 3d")
      const preview = await service.preview(request.params.id!)
      response.json({ ...preview, kind })
    } catch (error) { next(error) }
  })
  app.get("/api/projects/:id/simulation", async (request, response, next) => {
    try {
      const preview = await service.preview(request.params.id!)
      response.json({ revision: preview.revision, ...getSimulationResults(preview.circuitJson) })
    } catch (error) { next(error) }
  })
  app.get("/api/projects/:id/power", async (request, response, next) => {
    try {
      const numeric = (value: unknown, label: string) => {
        if (value === undefined) return undefined
        const parsed = Number(value)
        if (!Number.isFinite(parsed)) throw badRequest(`${label} must be a number`)
        return parsed
      }
      const preview = await service.preview(request.params.id!)
      const analysis = analyzePower(preview.circuitJson, {
        temperatureRiseC: numeric(request.query.temperatureRiseC, "temperatureRiseC"),
        copperOunces: numeric(request.query.copperOunces, "copperOunces"),
      })
      response.json({ revision: preview.revision, ...analysis })
    } catch (error) { next(error) }
  })
  app.get("/api/projects/:id/nets", async (request, response, next) => {
    try {
      const preview = await service.preview(request.params.id!)
      response.json({ revision: preview.revision, ...buildNetTraceIndex(preview.circuitJson) })
    } catch (error) { next(error) }
  })
  app.get("/api/projects/:id/requirements", async (request, response, next) => {
    try {
      const files = await service.getFileList(request.params.id!)
      const project = await service.get(request.params.id!)
      if (!files.includes("requirements.json")) return response.json({ configured: false, revision: project.revision, requirements: null })
      const file = await service.readFile(request.params.id!, "requirements.json")
      response.json({ configured: true, ...file, requirements: parseRequirements(file.content) })
    } catch (error) { next(error) }
  })
  app.put("/api/projects/:id/requirements", async (request, response, next) => {
    try {
      const match = request.get("If-Match")?.replace(/^"|"$/g, "")
      if (!match || request.body?.revision !== match) throw badRequest("If-Match and body revision must match")
      const content = JSON.stringify(request.body?.requirements, null, 2) + "\n"
      const requirements = parseRequirements(content)
      const saved = await service.writeFile(request.params.id!, "requirements.json", JSON.stringify(requirements, null, 2) + "\n", match)
      response.json({ configured: true, path: saved.path, revision: saved.revision, requirements })
    } catch (error) { next(error) }
  })
  app.get("/api/projects/:id/requirements/validate", async (request, response, next) => {
    try {
      const project = await service.get(request.params.id!)
      const files = await service.getFileList(request.params.id!)
      if (!files.includes("requirements.json")) return response.json({ configured: false, revision: project.revision, checks: [] })
      const [file, preview] = await Promise.all([
        service.readFile(request.params.id!, "requirements.json"),
        service.preview(request.params.id!),
      ])
      if (file.revision !== project.revision || preview.revision !== project.revision) return response.json({
        configured: true, stale: true, revision: project.revision, previewRevision: preview.revision,
        checks: [], message: "The project or latest successful build changed during validation; rebuild before validating requirements.",
      })
      const validation = validateRequirements(parseRequirements(file.content), preview.circuitJson)
      response.json({ configured: true, stale: false, revision: project.revision, previewRevision: preview.revision, ...validation })
    } catch (error) { next(error) }
  })

  const webDist = options.webDist ?? path.resolve(process.cwd(), "web/dist")
  app.use(express.static(webDist))
  app.get("*path", async (request, response, next) => {
    if (request.path.startsWith("/api/")) return next()
    try { response.sendFile(path.join(webDist, "index.html")) } catch (error) { next(error) }
  })
  app.use((error: unknown, _request: Request, response: Response, _next: (error?: unknown) => void) => {
    const status = Number((error as { status?: number })?.status ?? 500)
    response.status(status).json({ error: error instanceof Error ? error.message : "Internal server error", ...(status === 409 ? { revision: (error as { revision?: string }).revision } : {}) })
  })
  return app
}

function hasWorkbenchCredential(header: string | undefined, expected: string) {
  if (!header) return false
  let candidate: string | undefined
  if (header.startsWith("Bearer ")) candidate = header.slice("Bearer ".length)
  else if (header.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8")
      const separator = decoded.indexOf(":")
      if (separator >= 0 && decoded.slice(0, separator) === "workbench") candidate = decoded.slice(separator + 1)
    } catch { return false }
  }
  if (candidate === undefined) return false
  const actual = Buffer.from(candidate)
  const wanted = Buffer.from(expected)
  return actual.length === wanted.length && timingSafeEqual(actual, wanted)
}

async function runTscircuitBuild(projectDir: string, entrypoint: string): Promise<unknown> {
  const executable = path.resolve(process.cwd(), "node_modules/tscircuit/cli.mjs")
  const result = await runCommand(process.env.BUN_BINARY ?? "bun", [executable, "build", entrypoint], {
    cwd: projectDir,
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: projectDir,
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      CI: "1",
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    },
    timeoutMs: 120_000,
  })
  if (result.timedOut) throw new Error((result.stderr + "\n" + result.stdout).trim() || "tsci build exceeded its 120 second time limit")
  if (result.exitCode !== 0) throw new Error((result.stderr + "\n" + result.stdout).trim() || `tsci build exited ${result.exitCode}`)
  const dist = path.join(projectDir, "dist")
  const files = await findFiles(dist, "circuit.json")
  for (const filename of files) {
    try { return JSON.parse(await readFile(filename, "utf8")) } catch { /* Try other build output files. */ }
  }
  throw new Error(`tsci build succeeded but did not produce Circuit JSON. ${result.stderr}\n${result.stdout}`)
}

async function findFiles(directory: string, target: string): Promise<string[]> {
  try {
    const result: string[] = []
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name)
      if (entry.isDirectory()) result.push(...await findFiles(child, target))
      else if (entry.isFile() && entry.name === target) result.push(child)
    }
    return result
  } catch { return [] }
}

function diagnosticsFrom(error: unknown): Diagnostic[] {
  const message = error instanceof Error ? error.message : String(error)
  const lines = message.split(/\r?\n/).filter(Boolean)
  if (lines.length === 0) return [{ severity: "error", message: "Build failed" }]
  return lines.slice(-50).map((line) => {
    const match = /([^\s:]+):(\d+):(\d+):\s*(.*)/.exec(line)
    return match
      ? { severity: "error" as const, path: match[1], line: Number(match[2]), column: Number(match[3]), message: match[4] || line }
      : { severity: "error" as const, message: line.slice(0, 2000) }
  })
}

function isIsolatedBuildResult(value: unknown): value is IsolatedBuildResult {
  return typeof value === "object" && value !== null && "circuitJson" in value && "isolation" in value && "runtime" in value
}

function cleanRelative(input: string) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters in a project path is the point of this check
  if (typeof input !== "string" || !input || /[\u0000-\u001f\u007f]/.test(input) || input.includes("\\") || input.startsWith("/") || /^[a-zA-Z]:/.test(input)) throw badRequest("Invalid project file path")
  const pieces = input.split("/")
  if (pieces.some((part) => !part || part === "." || part === ".." || part.startsWith("."))) throw badRequest("Invalid project file path")
  if ([".workbench", "node_modules", "dist", ".tscircuit", ".git"].includes(pieces[0]!)) throw badRequest("This project path is reserved by the server")
  return pieces.join("/")
}
function isId(id: string) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) }
function newRevision() { return randomUUID() }
/**
 * Build the supplier lookup client from an injected client, explicit options, or
 * COMPONENT_SOURCING_URL. Sourcing stays off unless one of those is present, so the
 * workbench makes no outbound supplier requests by default.
 */
function createConfiguredSourcing(option: AppOptions["componentSourcing"]): SourcingClient | undefined {
  if (option && "lookup" in option) return option
  const baseUrl = option?.baseUrl ?? process.env.COMPONENT_SOURCING_URL
  if (!baseUrl) return undefined
  const timeoutMs = Number(process.env.COMPONENT_SOURCING_TIMEOUT_MS)
  try {
    return createSourcingClient({
      baseUrl,
      provider: option?.provider ?? process.env.COMPONENT_SOURCING_PROVIDER ?? "jlcsearch",
      ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {}),
    })
  } catch (error) {
    console.error("Component sourcing is disabled because its configuration is invalid", error)
    return undefined
  }
}

function badRequest(message: string) { return Object.assign(new Error(message), { status: 400 }) }
function digest(value: string | Buffer) { return createHash("sha256").update(value).digest("hex") }
function safePackageName(name: string) { return name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "circuit-project" }
