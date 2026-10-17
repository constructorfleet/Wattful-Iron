import assert from "node:assert/strict"
import test from "node:test"
import { getSimulationResults } from "./simulation.js"

test("simulation results correlate voltage traces with their net and probe", () => {
  const result = getSimulationResults([
    { type: "simulation_experiment", simulation_experiment_id: "e1", name: "Transient", experiment_type: "transient" },
    { type: "simulation_voltage_probe", simulation_voltage_probe_id: "p1", name: "OUT", signal_input_source_net_id: "net1" },
    { type: "simulation_transient_voltage_graph", simulation_transient_voltage_graph_id: "g1", simulation_experiment_id: "e1", timestamps_ms: [0, 1], voltage_levels: [0, 5], time_per_step: 1, start_time_ms: 0, end_time_ms: 1 },
    { type: "simulation_oscilloscope_trace", simulation_oscilloscope_trace_id: "t1", simulation_transient_voltage_graph_id: "g1", simulation_voltage_probe_id: "p1", display_name: "OUT" },
  ])
  assert.equal(result.status, "complete")
  assert.equal(result.signals[0]?.netId, "net1")
  assert.equal(result.signals[0]?.name, "OUT")
  assert.deepEqual(result.signals[0]?.samples, [{ x: 0, y: 0 }, { x: 1, y: 5 }])
})

test("simulation results surface simulator errors and explain missing simulation data", () => {
  assert.equal(getSimulationResults([]).status, "not_configured")
  const failed = getSimulationResults([{ type: "simulation_unknown_experiment_error", simulation_unknown_experiment_error_id: "err", error_type: "simulation_unknown_experiment_error", simulation_experiment_id: "e1" }])
  assert.equal(failed.status, "failed")
  assert.match(failed.diagnostics[0]!.message, /SPICE engine/)
})
