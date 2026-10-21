import { readFile, readdir } from "node:fs/promises"
import path from "node:path"

export type ModuleParameter = { name: string; type: string; default?: string; description?: string }

export type CircuitModule = {
  id: string
  name: string
  component: string
  description: string
  parameters: ModuleParameter[]
  terminals: string[]
  usage: string
  /** What the module does not do, so an insertion is not mistaken for a verified design. */
  notes: string[]
  /** Where the module lands inside a project. */
  path: string
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,48}$/

/** List the reusable circuit modules this workbench ships, ignoring malformed entries. */
export async function listCircuitModules(dir: string): Promise<CircuitModule[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const modules: CircuitModule[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) continue
    const parsed = await readModuleMetadata(dir, entry.name)
    if (parsed) modules.push(parsed)
  }
  return modules.sort((left, right) => left.name.localeCompare(right.name))
}

/** Read one module's metadata and its source, for inspection or insertion into a project. */
export async function readCircuitModule(dir: string, id: string): Promise<{ module: CircuitModule; source: string }> {
  if (!ID_PATTERN.test(id)) throw Object.assign(new Error(`'${id}' is not a circuit module id`), { status: 400 })
  const metadata = await readModuleMetadata(dir, id)
  if (!metadata) throw Object.assign(new Error(`No circuit module named '${id}'`), { status: 404 })
  const source = await readFile(path.join(dir, id, "index.tsx"), "utf8")
  return { module: metadata, source }
}

async function readModuleMetadata(dir: string, id: string): Promise<CircuitModule | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path.join(dir, id, "module.json"), "utf8")) as Partial<CircuitModule>
    if (parsed.id !== id || typeof parsed.name !== "string" || typeof parsed.component !== "string") return undefined
    return {
      id,
      name: parsed.name,
      component: parsed.component,
      description: typeof parsed.description === "string" ? parsed.description : "",
      parameters: Array.isArray(parsed.parameters) ? parsed.parameters.filter(isParameter) : [],
      terminals: Array.isArray(parsed.terminals) ? parsed.terminals.filter((value): value is string => typeof value === "string") : [],
      usage: typeof parsed.usage === "string" ? parsed.usage : `<${parsed.component} />`,
      notes: Array.isArray(parsed.notes) ? parsed.notes.filter((value): value is string => typeof value === "string") : [],
      path: `modules/${id}.tsx`,
    }
  } catch { return undefined }
}

/** The import line a project needs after a module file is added. */
export function moduleImportLine(module: CircuitModule) {
  return `import { ${module.component} } from "./modules/${module.id}"`
}

function isParameter(value: unknown): value is ModuleParameter {
  return typeof value === "object" && value !== null
    && typeof (value as ModuleParameter).name === "string"
    && typeof (value as ModuleParameter).type === "string"
}
