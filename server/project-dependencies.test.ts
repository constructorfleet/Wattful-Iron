import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import { readProjectDependencies } from "./project-dependencies.js"

async function fixture(declared: Record<string, string>, installed: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), "circuits-deps-"))
  const projectDir = path.join(root, "project")
  const modulesDir = path.join(root, "node_modules")
  await mkdir(projectDir, { recursive: true })
  await writeFile(path.join(projectDir, "package.json"), JSON.stringify({ name: "p", private: true, dependencies: declared }))
  for (const [name, version] of Object.entries(installed)) {
    await mkdir(path.join(modulesDir, name), { recursive: true })
    await writeFile(path.join(modulesDir, name, "package.json"), JSON.stringify({ name, version }))
  }
  return { projectDir, modulesDir, cleanup: () => rm(root, { recursive: true, force: true }) }
}

test("reports the declared version alongside the version a build actually uses", async () => {
  const f = await fixture({ tscircuit: "0.0.2930" }, { tscircuit: "0.0.3000" })
  try {
    const result = await readProjectDependencies(f.projectDir, f.modulesDir)
    assert.deepEqual(result.declared, { tscircuit: "0.0.2930" })
    assert.deepEqual(result.effective, [{ name: "tscircuit", version: "0.0.3000", source: "workbench runtime" }])
    // The declared pin is reference only, and the report must say so rather than imply it applies.
    assert.equal(result.declaredVersionsApply, false)
    assert.ok(result.notes.some((note) => note.includes("do not change what a build resolves")))
    assert.ok(result.notes.some((note) => note.includes("upgrade the workbench image")))
    assert.ok(result.notes.some((note) => note.includes("no network to install packages")))
  } finally { await f.cleanup() }
})

test("marks a declared dependency the runtime does not provide as unavailable", async () => {
  const f = await fixture({ tscircuit: "0.0.2930", "some-helper": "^1.0.0" }, { tscircuit: "0.0.2930" })
  try {
    const result = await readProjectDependencies(f.projectDir, f.modulesDir)
    assert.deepEqual(result.effective, [
      { name: "some-helper", version: "not installed", source: "unavailable to builds" },
      { name: "tscircuit", version: "0.0.2930", source: "workbench runtime" },
    ])
  } finally { await f.cleanup() }
})

test("still reports the runtime tscircuit when a project declares nothing", async () => {
  const f = await fixture({}, { tscircuit: "0.0.2930" })
  try {
    const result = await readProjectDependencies(f.projectDir, f.modulesDir)
    assert.deepEqual(result.declared, {})
    assert.deepEqual(result.effective, [{ name: "tscircuit", version: "0.0.2930", source: "workbench runtime" }])
  } finally { await f.cleanup() }
})

test("survives a missing or malformed project package.json", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "circuits-deps-bad-"))
  try {
    const result = await readProjectDependencies(path.join(root, "missing"), path.join(root, "node_modules"))
    assert.deepEqual(result.declared, {})
    assert.deepEqual(result.effective, [{ name: "tscircuit", version: "not installed", source: "unavailable to builds" }])

    await mkdir(path.join(root, "project"), { recursive: true })
    await writeFile(path.join(root, "project", "package.json"), "{ not json")
    assert.deepEqual((await readProjectDependencies(path.join(root, "project"), root)).declared, {})
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("reads the real workbench runtime for this repository", async () => {
  const result = await readProjectDependencies(process.cwd(), path.resolve("node_modules"))
  const tscircuit = result.effective.find(({ name }) => name === "tscircuit")
  assert.match(tscircuit?.version ?? "", /^\d+\.\d+\.\d+/, "the installed tscircuit version should be reported")
  assert.equal(tscircuit?.source, "workbench runtime")
})
