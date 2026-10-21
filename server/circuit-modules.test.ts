import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { listCircuitModules, moduleImportLine, readCircuitModule } from "./circuit-modules.js"
import { runCircuitDesignChecks } from "./circuit-design-checks.js"
import { runCommand } from "./build-process.js"

const shippedModules = path.resolve("modules")

test("every shipped module declares the metadata the library depends on", async () => {
  const modules = await listCircuitModules(shippedModules)
  assert.ok(modules.length >= 5, `expected the shipped library, saw ${modules.length}`)
  for (const module of modules) {
    assert.match(module.id, /^[a-z0-9-]+$/, module.id)
    assert.ok(module.name.length > 3, module.id)
    assert.ok(module.description.length > 20, module.id)
    assert.ok(module.component.length > 2, module.id)
    assert.equal(module.path, `modules/${module.id}.tsx`)
    assert.ok(module.terminals.length > 0, `${module.id} must name its terminals`)
    assert.ok(module.usage.includes(module.component), module.id)
    // Each module says what it does not do, so inserting one is not mistaken for a design.
    assert.ok(module.notes.length > 0, `${module.id} must carry notes`)
    for (const note of module.notes) assert.ok(note.length > 20, `${module.id}: ${note}`)
    // Position parameters let a module be placed without editing its source.
    for (const parameter of ["pcbX", "pcbY", "schX", "schY"]) {
      assert.ok(module.parameters.some(({ name }) => name === parameter), `${module.id} is missing ${parameter}`)
    }
  }
  assert.deepEqual(modules.map(({ id }) => id).sort(), ["i2c-pullups", "led-indicator", "power-input", "rc-low-pass", "resistor-divider"])
})

test("reads a module's source and the import line a project needs", async () => {
  const { module, source } = await readCircuitModule(shippedModules, "power-input")
  assert.equal(module.component, "PowerInput")
  assert.match(source, /export const PowerInput/)
  assert.match(source, /pinrow2/)
  assert.equal(moduleImportLine(module), 'import { PowerInput } from "./modules/power-input"')
})

test("rejects an unknown module and anything that is not an id", async () => {
  await assert.rejects(() => readCircuitModule(shippedModules, "buck-converter"), /No circuit module named 'buck-converter'/)
  for (const id of ["../examples", "Power-Input", "with space", ""]) {
    await assert.rejects(() => readCircuitModule(shippedModules, id), /is not a circuit module id/, id)
  }
})

test("ignores directories that are not modules", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "circuits-modules-"))
  try {
    await mkdir(path.join(dir, "no-metadata"), { recursive: true })
    await mkdir(path.join(dir, "mismatched"), { recursive: true })
    await writeFile(path.join(dir, "mismatched", "module.json"), JSON.stringify({ id: "other", name: "Other", component: "Other" }))
    await mkdir(path.join(dir, "broken"), { recursive: true })
    await writeFile(path.join(dir, "broken", "module.json"), "{ not json")
    assert.deepEqual(await listCircuitModules(dir), [])
    assert.deepEqual(await listCircuitModules(path.join(dir, "missing")), [])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

/**
 * The library's whole claim is that these modules build. Compose every module onto one
 * board and run the real tscircuit CLI over it, then run the design checks on the result.
 */
test("every shipped module builds and routes on a real board", async (t) => {
  const bun = await runCommand(process.env.BUN_BINARY ?? "bun", ["--version"], { cwd: process.cwd(), env: process.env, timeoutMs: 20_000 }).catch(() => undefined)
  if (!bun || bun.exitCode !== 0) return t.skip("bun is required to build circuits and is not installed here")
  const modules = await listCircuitModules(shippedModules)
  const workspace = await mkdtemp(path.join(tmpdir(), "circuits-module-build-"))
  try {
    await mkdir(path.join(workspace, "modules"), { recursive: true })
    for (const module of modules) {
      const { source } = await readCircuitModule(shippedModules, module.id)
      await writeFile(path.join(workspace, module.path), source, "utf8")
    }
    // Lay the modules out in a row with enough spacing that no courtyards overlap, giving
    // each one unique reference designators so the whole library can coexist on one board.
    const assignedRefs: string[] = []
    const placements = modules.map((module, index) => {
      const refs = module.parameters
        .filter(({ name }) => name.endsWith("Ref"))
        .map(({ name }, refIndex) => {
          const value = `${defaultRefLetter(module.parameters, name)}${index * 4 + refIndex + 1}`
          assignedRefs.push(value)
          return [name, value] as const
        })
      const props = refs.map(([name, value]) => `${name}="${value}"`).join(" ")
      return `    <${module.component} ${props} pcbX={${index * 22 - 44}} pcbY={0} schX={${index * 14 - 28}} schY={0} />`
    })
    const entrypoint = [
      ...modules.map((module) => moduleImportLine(module)),
      "",
      "export default () => (",
      '  <board name="module library" width="130mm" height="30mm">',
      ...placements,
      '    <schematicsheet name="Main" displayName="Main" sheetIndex={0} />',
      "  </board>",
      ")",
      "",
    ].join("\n")
    await writeFile(path.join(workspace, "index.circuit.tsx"), entrypoint, "utf8")
    await writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "module-library-check", private: true }) + "\n", "utf8")
    const { symlink } = await import("node:fs/promises")
    await symlink(path.resolve("node_modules"), path.join(workspace, "node_modules"), "dir").catch(() => undefined)

    // Build the way the workbench does: the tscircuit CLI under bun.
    const built = await runCommand(process.env.BUN_BINARY ?? "bun", [
      path.resolve("node_modules/tscircuit/cli.mjs"), "build", "index.circuit.tsx",
    ], { cwd: workspace, env: { ...process.env, HOME: workspace }, timeoutMs: 240_000 })
    assert.equal(built.timedOut, false, built.stderr)
    assert.equal(built.exitCode, 0, `${built.stdout}\n${built.stderr}`)

    const circuitJson = JSON.parse(await (await import("node:fs/promises")).readFile(path.join(workspace, "dist/index/circuit.json"), "utf8")) as Array<Record<string, unknown>>
    const errors = circuitJson.filter((element) => typeof element.type === "string" && element.type.endsWith("_error"))
    assert.deepEqual(errors.map((element) => element.message ?? element.type), [], "the composed module board must build without errors")

    // Every component each module declares reaches the board under the ref it was given,
    // every module emits its own group, and the traces inside the modules are routed.
    const componentNames = circuitJson.filter((element) => element.type === "source_component").map((element) => String(element.name))
    for (const ref of assignedRefs) assert.ok(componentNames.includes(ref), `${ref} is missing from the built board`)
    const groups = circuitJson.filter((element) => element.type === "source_group" && typeof element.name === "string")
    assert.ok(groups.length > modules.length, `expected a group per module plus the board, saw ${groups.length}`)
    assert.ok(circuitJson.filter((element) => element.type === "pcb_trace").length >= modules.length, "each module's internal traces should route")

    const checks = await runCircuitDesignChecks(circuitJson)
    assert.deepEqual(checks.issues.filter(({ severity }) => severity === "error"), [], "the composed board must pass the design checks")
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

/** Reference designators follow tscircuit's convention, which the first default encodes. */
function defaultRefLetter(parameters: Array<{ name: string; default?: string }>, name: string) {
  const parameter = parameters.find((candidate) => candidate.name === name)
  return (parameter?.default ?? "U1").replace(/[0-9]+$/, "")
}
