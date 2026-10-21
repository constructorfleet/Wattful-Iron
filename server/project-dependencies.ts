import { readFile } from "node:fs/promises"
import path from "node:path"

export type ProjectDependencies = {
  /** What the project's own package.json declares. */
  declared: Record<string, string>
  /** What a build actually resolves, and where it comes from. */
  effective: Array<{ name: string; version: string; source: string }>
  /** Whether the declared versions change what a build uses. */
  declaredVersionsApply: boolean
  notes: string[]
}

const APPLY_NOTE = "Builds run the workbench's own pinned tscircuit from the build image, not a per-project install: the project's package.json dependency versions are recorded for reference and do not change what a build resolves."
const CHANGE_NOTE = "To change the tscircuit version a project builds against, upgrade the workbench image. There is no per-project dependency install, so a project cannot pin a different version."
const ADD_NOTE = "Imports that are not satisfied by the workbench's own dependencies will fail to build, because build containers have no network to install packages."

/**
 * Report both the dependency versions a project declares and the versions a build actually
 * uses. The two can disagree, and reporting only the declared ones would be misleading.
 */
export async function readProjectDependencies(projectDir: string, runtimeModulesDir: string): Promise<ProjectDependencies> {
  const declared = await readDeclared(projectDir)
  const effective: ProjectDependencies["effective"] = []
  for (const name of new Set(["tscircuit", ...Object.keys(declared)])) {
    const version = await readInstalledVersion(runtimeModulesDir, name)
    if (version) effective.push({ name, version, source: "workbench runtime" })
    else effective.push({ name, version: "not installed", source: "unavailable to builds" })
  }
  return {
    declared,
    effective: effective.sort((left, right) => left.name.localeCompare(right.name)),
    declaredVersionsApply: false,
    notes: [APPLY_NOTE, CHANGE_NOTE, ADD_NOTE],
  }
}

async function readDeclared(projectDir: string): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse(await readFile(path.join(projectDir, "package.json"), "utf8")) as { dependencies?: Record<string, unknown> }
    const dependencies = parsed.dependencies ?? {}
    return Object.fromEntries(Object.entries(dependencies)
      .filter(([name, version]) => typeof name === "string" && typeof version === "string")
      .map(([name, version]) => [name, version as string]))
  } catch { return {} }
}

async function readInstalledVersion(modulesDir: string, name: string) {
  if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(name)) return undefined
  try {
    const parsed = JSON.parse(await readFile(path.join(modulesDir, name, "package.json"), "utf8")) as { version?: unknown }
    return typeof parsed.version === "string" ? parsed.version : undefined
  } catch { return undefined }
}
