import assert from "node:assert/strict"
import { test } from "node:test"
import { checkRouting, runDesignRuleCheck, runElectricalRuleCheck } from "./rule-checks.js"

test("reports non-circuit input as not evaluated instead of passing", async () => {
  for (const run of [runElectricalRuleCheck, runDesignRuleCheck, checkRouting]) {
    const report = await run([{ type: "not_circuit_json" }])
    assert.equal(report.status, "not-evaluated")
    assert.deepEqual(report.issues, [])
    assert.ok(report.notEvaluated.length > 0)
  }
})

test("each report names the checks it does not evaluate with a reason", async () => {
  const erc = await runElectricalRuleCheck([{ type: "source_component", name: "R1" }])
  assert.deepEqual(erc.categories, ["netlist", "pin_specification", "source"])
  assert.ok(erc.notEvaluated.some((item) => item.check === "Component rating violations"))
  for (const item of erc.notEvaluated) assert.ok(item.reason.length > 20, item.check)

  const drc = await runDesignRuleCheck([{ type: "source_component", name: "R1" }])
  assert.deepEqual(drc.categories, ["placement", "routing"])
  assert.ok(drc.notEvaluated.some((item) => item.check.includes("Footprint compatibility")))

  const routing = await checkRouting([{ type: "source_component", name: "R1" }])
  assert.deepEqual(routing.categories, ["routing"])
  assert.ok(routing.notEvaluated.some((item) => item.check.includes("Impedance")))
})

test("separates electrical findings from board findings", async () => {
  // A source trace with no matching PCB trace is a routing finding, not an electrical one.
  const circuitJson = [
    { type: "source_component", source_component_id: "sc1", name: "R1", ftype: "simple_resistor", resistance: 1000 },
    { type: "source_component", source_component_id: "sc2", name: "R2", ftype: "simple_resistor", resistance: 1000 },
    { type: "source_port", source_port_id: "sp1", source_component_id: "sc1", name: "pin1", pin_number: 1 },
    { type: "source_port", source_port_id: "sp2", source_component_id: "sc2", name: "pin1", pin_number: 1 },
    { type: "source_trace", source_trace_id: "st1", connected_source_port_ids: ["sp1", "sp2"], connected_source_net_ids: [] },
    { type: "pcb_board", pcb_board_id: "board1", width: 20, height: 20, center: { x: 0, y: 0 }, thickness: 1.6, num_layers: 2 },
  ]
  const erc = await runElectricalRuleCheck(circuitJson)
  const drc = await runDesignRuleCheck(circuitJson)
  const routing = await checkRouting(circuitJson)

  for (const report of [erc, drc, routing]) assert.notEqual(report.status, "not-evaluated")
  for (const issue of erc.issues) assert.ok(["netlist", "pin_specification", "source"].includes(issue.category), issue.category)
  for (const issue of drc.issues) assert.ok(["placement", "routing"].includes(issue.category), issue.category)
  for (const issue of routing.issues) assert.equal(issue.category, "routing")
  // Routing findings are a subset of the board report.
  assert.ok(routing.issues.length <= drc.issues.length)
  assert.equal(routing.issues.every((issue) => drc.issues.some((other) => other.type === issue.type)), true)
})

test("a status reflects the worst finding severity in that report", async () => {
  const report = await runDesignRuleCheck([
    { type: "source_component", source_component_id: "sc1", name: "R1" },
    { type: "pcb_component", pcb_component_id: "pc1", source_component_id: "sc1", center: { x: 400, y: 400 }, width: 2, height: 1, rotation: 0, layer: "top" },
    { type: "pcb_board", pcb_board_id: "board1", width: 20, height: 20, center: { x: 0, y: 0 }, thickness: 1.6, num_layers: 2 },
  ])
  // A component placed far outside the board outline is a placement error.
  assert.equal(report.status, "fail")
  assert.ok(report.issues.some((issue) => issue.severity === "error"))
})
