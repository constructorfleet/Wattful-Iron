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

test("each report names the checks it covers and where they come from", async () => {
  const circuit = [{ type: "source_component", name: "R1" }]
  const erc = await runElectricalRuleCheck(circuit)
  assert.ok(erc.coverage.length > 5)
  assert.ok(erc.coverage.every((item) => ["tscircuit-checks", "fabricator-profile", "workbench"].includes(item.source)))
  // A voltage compatibility pass must carry its caveat, because most builds emit no pin attributes.
  const voltage = erc.coverage.find(({ check }) => check.includes("voltage compatibility"))
  assert.equal(voltage?.source, "tscircuit-checks")
  assert.match(voltage?.caveat ?? "", /emits no pin attributes/)

  const drc = await runDesignRuleCheck(circuit)
  // Clearance checks are run by the upstream suite, so they must not be listed as unevaluated.
  assert.ok(drc.coverage.some(({ check }) => check.includes("Pad-to-pad and pad-to-trace clearance")))
  assert.ok(drc.coverage.some(({ check }) => check.includes("Via-to-pad, via-to-trace, and different-net via spacing")))
  assert.ok(!drc.notEvaluated.some(({ check }) => /clearance/i.test(check)))
  const profileChecks = drc.coverage.find(({ source }) => source === "fabricator-profile")
  assert.match(profileChecks?.check ?? "", /via hole, via diameter, and annular ring/)

  const routing = await checkRouting(circuit)
  assert.ok(routing.coverage.some(({ check }) => check.includes("Trace contiguity")))
  assert.ok(routing.coverage.some(({ source }) => source === "workbench"))
})

test("each report names the checks it does not evaluate with a reason", async () => {
  const erc = await runElectricalRuleCheck([{ type: "source_component", name: "R1" }])
  assert.deepEqual(erc.categories, ["netlist", "pin_specification", "source"])
  assert.ok(erc.notEvaluated.some((item) => item.check === "Component rating violations"))
  // Voltage domains and driver conflicts need pin attributes Circuit JSON omits, and the
  // reason has to say that rather than implying the check exists.
  const domains = erc.notEvaluated.find(({ check }) => check.includes("Voltage-domain conflicts"))
  assert.match(domains?.reason ?? "", /pin voltage attributes/)
  assert.ok(erc.notEvaluated.some(({ check }) => check === "Output driver conflicts"))
  assert.ok(erc.notEvaluated.some(({ reason }) => /not used here rather than parsed heuristically/.test(reason)))
  for (const item of erc.notEvaluated) assert.ok(item.reason.length > 20, item.check)

  const drc = await runDesignRuleCheck([{ type: "source_component", name: "R1" }])
  assert.deepEqual(drc.categories, ["placement", "routing"])
  assert.ok(drc.notEvaluated.some((item) => item.check.includes("Footprint compatibility")))
  assert.ok(drc.notEvaluated.some((item) => item.check.includes("Soldermask and silkscreen")))

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
