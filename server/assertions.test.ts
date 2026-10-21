import assert from "node:assert/strict"
import { test } from "node:test"
import { evaluateAssertions, parseAssertions } from "./assertions.js"
import { summarizeDesign } from "./design-summary.js"
import type { PowerAnalysis } from "./power-analysis.js"
import type { BomCostEstimate } from "./component-sourcing.js"

const circuit = [
  { type: "source_component", source_component_id: "sc1", name: "R1", ftype: "simple_resistor", resistance: 220 },
  { type: "source_component", source_component_id: "sc2", name: "D1", ftype: "simple_led" },
  { type: "source_port", source_port_id: "sp1", source_component_id: "sc1", name: "pin2", subcircuit_connectivity_map_key: "net1" },
  { type: "source_port", source_port_id: "sp2", source_component_id: "sc2", name: "anode", subcircuit_connectivity_map_key: "net1" },
  { type: "source_port", source_port_id: "sp3", source_component_id: "sc2", name: "cathode", subcircuit_connectivity_map_key: "net2" },
  { type: "source_trace", source_trace_id: "st1", name: "SIGNAL", connected_source_port_ids: ["sp1", "sp2"], connected_source_net_ids: [], subcircuit_connectivity_map_key: "net1" },
  { type: "source_trace", source_trace_id: "st2", name: "GND", connected_source_port_ids: ["sp3"], connected_source_net_ids: [], subcircuit_connectivity_map_key: "net2" },
  { type: "simulation_experiment", simulation_experiment_id: "e1", name: "Operating point", experiment_type: "spice_dc_operating_point" },
  { type: "simulation_voltage_probe", simulation_voltage_probe_id: "vp1", name: "VOUT", signal_input_source_net_id: "net1" },
  { type: "simulation_dc_operating_point_voltage", simulation_dc_operating_point_voltage_id: "opv1", simulation_experiment_id: "e1", simulation_voltage_probe_id: "vp1", voltage: 3.3 },
]

const document = (assertions: Record<string, unknown>) => parseAssertions(JSON.stringify({ version: 1, assertions }))

const power = (overrides: Partial<PowerAnalysis> = {}): PowerAnalysis => ({
  status: "partial",
  assumptions: [],
  traceCapacity: [],
  nodeVoltages: [],
  branchCurrents: [],
  componentPower: [],
  supplyLoads: [],
  traceLoads: [],
  notEvaluated: [],
  ...overrides,
})

const bomCost = (overrides: Partial<BomCostEstimate> = {}): BomCostEstimate => ({
  boards: 1,
  lines: [],
  unpriced: [],
  limitations: [],
  ...overrides,
})

test("rejects an assertion document that is not valid or not supported", () => {
  assert.throws(() => parseAssertions("not json"), /Assertions must be valid JSON/)
  assert.throws(() => parseAssertions(JSON.stringify({ version: 2, assertions: {} })), /Invalid project assertions/)
  assert.throws(() => parseAssertions(JSON.stringify({ version: 1, assertions: { unknown_rule: true } })), /Invalid project assertions/)
  assert.throws(() => parseAssertions(JSON.stringify({ version: 1, assertions: { simulation: [{ signal: "VOUT" }] } })), /needs a min, a max, or both/)
  assert.throws(() => parseAssertions(JSON.stringify({ version: 1, assertions: { nets_connected: ["GND", "GND"] } })), /must not contain duplicates/)
  assert.deepEqual(parseAssertions(JSON.stringify({ version: 1, assertions: { max_dissipation_w: 1.5 } })).assertions, { max_dissipation_w: 1.5 })
})

test("passes a connected net and fails one that is missing or has a single pin", () => {
  const report = evaluateAssertions(document({ nets_connected: ["SIGNAL", "GND", "VBUS"] }), { circuitJson: circuit })
  assert.deepEqual(report.results.map(({ id, status }) => [id, status]), [
    ["net-connected-SIGNAL", "pass"],
    ["net-connected-GND", "fail"],
    ["net-connected-VBUS", "fail"],
  ])
  assert.match(report.results[0]!.message, /connects 2 component pins \(R1\.pin2, D1\.anode\)/)
  assert.match(report.results[1]!.message, /reaches only 1 component pin/)
  assert.match(report.results[2]!.message, /is not present in the latest successful build/)
  assert.deepEqual([report.passed, report.failed, report.notEvaluated], [1, 2, 0])
})

test("checks required components by name", () => {
  const report = evaluateAssertions(document({ components_present: ["R1", "U7"] }), { circuitJson: circuit })
  assert.deepEqual(report.results.map(({ id, status }) => [id, status]), [["component-present-R1", "pass"], ["component-present-U7", "fail"]])
})

test("checks supply current and dissipation against the operating point, or says why it cannot", () => {
  const measured = evaluateAssertions(
    document({ max_supply_current_a: 0.5, max_dissipation_w: 0.01 }),
    { circuitJson: circuit, power: power({ totalSupplyCurrentA: 0.25, totalDissipationW: 0.0495 }) },
  )
  assert.deepEqual(measured.results.map(({ id, status }) => [id, status]), [["max-supply-current", "pass"], ["max-dissipation", "fail"]])
  assert.match(measured.results[1]!.message, /0\.0495 W, above the limit of 0\.01 W/)

  const unmeasured = evaluateAssertions(document({ max_supply_current_a: 0.5 }), { circuitJson: circuit, power: power() })
  assert.equal(unmeasured.results[0]?.status, "not-evaluated")
  assert.match(unmeasured.results[0]!.message, /no supply branch current was emitted/)
})

test("fails when design check findings increase and needs a baseline to compare with", () => {
  const baseline = summarizeDesign(circuit, "rev-1", "2026-10-20T00:00:00.000Z", 2)
  const worse = evaluateAssertions(document({ design_check_findings_must_not_increase: true }), { circuitJson: circuit, baseline, designCheckFindings: 5 })
  assert.equal(worse.results[0]?.status, "fail")
  assert.match(worse.results[0]!.message, /rose from 2 to 5 since revision rev-1/)
  assert.equal(worse.baselineRevision, "rev-1")

  const better = evaluateAssertions(document({ design_check_findings_must_not_increase: true }), { circuitJson: circuit, baseline, designCheckFindings: 1 })
  assert.equal(better.results[0]?.status, "pass")

  const noBaseline = evaluateAssertions(document({ design_check_findings_must_not_increase: true }), { circuitJson: circuit, designCheckFindings: 1 })
  assert.equal(noBaseline.results[0]?.status, "not-evaluated")
  assert.match(noBaseline.results[0]!.message, /no earlier build summary is retained/)
})

test("treats an incomplete component cost as not evaluated instead of within budget", () => {
  const within = evaluateAssertions(
    document({ max_component_cost_usd: 10, cost_board_quantity: 5 }),
    { circuitJson: circuit, sourcingConfigured: true, bomCost: bomCost({ boards: 5, componentCostUsd: 4 }) },
  )
  assert.equal(within.results[0]?.status, "pass")

  const over = evaluateAssertions(
    document({ max_component_cost_usd: 10 }),
    { circuitJson: circuit, sourcingConfigured: true, bomCost: bomCost({ componentCostUsd: 12.5 }) },
  )
  assert.equal(over.results[0]?.status, "fail")

  const partial = evaluateAssertions(
    document({ max_component_cost_usd: 10 }),
    { circuitJson: circuit, sourcingConfigured: true, bomCost: bomCost({ componentCostUsd: 4, unpriced: [{ name: "D1", reason: "no price" }] }) },
  )
  assert.equal(partial.results[0]?.status, "not-evaluated")
  assert.match(partial.results[0]!.message, /1 part could not be priced: D1/)

  const unconfigured = evaluateAssertions(document({ max_component_cost_usd: 10 }), { circuitJson: circuit })
  assert.equal(unconfigured.results[0]?.status, "not-evaluated")
  assert.match(unconfigured.results[0]!.message, /COMPONENT_SOURCING_URL/)
})

test("checks simulation values against an asserted range", () => {
  const report = evaluateAssertions(document({ simulation: [{ signal: "VOUT", min: 3.1, max: 3.5 }, { signal: "VOUT", min: 4 }, { signal: "VSENSE", max: 1 }] }), { circuitJson: circuit })
  assert.deepEqual(report.results.map(({ status }) => status), ["pass", "fail", "not-evaluated"])
  assert.match(report.results[0]!.message, /Operating point 'VOUT' is 3\.3 V, within the asserted range 3\.1 to 3\.5/)
  assert.match(report.results[2]!.message, /produced no operating-point value or waveform/)
})

test("checks a transient waveform across all of its samples", () => {
  const waveform = [
    { type: "simulation_experiment", simulation_experiment_id: "e1", name: "Transient", experiment_type: "spice_transient_analysis" },
    { type: "simulation_voltage_probe", simulation_voltage_probe_id: "vp1", name: "VRAIL" },
    { type: "simulation_transient_voltage_graph", simulation_transient_voltage_graph_id: "g1", simulation_voltage_probe_id: "vp1", start_time_ms: 0, time_per_step: 1, voltage_levels: [0, 3.2, 5.4] },
  ]
  const report = evaluateAssertions(document({ simulation: [{ signal: "VRAIL", max: 5 }] }), { circuitJson: waveform })
  assert.equal(report.results[0]?.status, "fail")
  assert.match(report.results[0]!.message, /spans 0 to 5\.4 V over 3 samples, outside the asserted range -inf to 5/)
})

test("evaluates nothing when the project has no successful build", () => {
  const report = evaluateAssertions(document({ nets_connected: ["GND"], components_present: ["R1"], simulation: [{ signal: "VOUT", min: 1 }] }), { circuitJson: [] })
  assert.deepEqual(report.results.map(({ status }) => status), ["not-evaluated", "not-evaluated", "not-evaluated"])
  assert.equal(report.passed, 0)
  assert.equal(report.failed, 0)
})
