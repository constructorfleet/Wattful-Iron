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

test("reads DC operating-point node voltages and branch currents", () => {
  const result = getSimulationResults([
    { type: "simulation_experiment", simulation_experiment_id: "e1", name: "Operating point", experiment_type: "spice_dc_operating_point" },
    { type: "simulation_voltage_probe", simulation_voltage_probe_id: "vp1", name: "VOUT", signal_input_source_net_id: "net1" },
    { type: "simulation_current_probe", simulation_current_probe_id: "cp1", name: "Supply", source_component_id: "sc-v1", positive_source_net_id: "net0" },
    { type: "simulation_dc_operating_point_voltage", simulation_dc_operating_point_voltage_id: "opv1", simulation_experiment_id: "e1", simulation_voltage_probe_id: "vp1", voltage: 3.3 },
    { type: "simulation_dc_operating_point_current", simulation_dc_operating_point_current_id: "opc1", simulation_experiment_id: "e1", simulation_current_probe_id: "cp1", current: -0.25 },
  ])

  assert.equal(result.status, "complete")
  assert.deepEqual(result.operatingPoints, [
    { id: "opv1", name: "VOUT", unit: "V", value: 3.3, netId: "net1", sourceComponentId: undefined, experimentId: "e1" },
    { id: "opc1", name: "Supply", unit: "A", value: -0.25, netId: "net0", sourceComponentId: "sc-v1", experimentId: "e1" },
  ])
  assert.deepEqual(result.analyses.find(({ type }) => type === "spice_dc_operating_point"), { type: "spice_dc_operating_point", experiments: 1, resultCount: 2 })
})

test("reads a DC sweep with the swept value on the x axis", () => {
  const result = getSimulationResults([
    { type: "simulation_experiment", simulation_experiment_id: "e1", name: "Sweep", experiment_type: "spice_dc_sweep" },
    { type: "simulation_voltage_probe", simulation_voltage_probe_id: "vp1", name: "VOUT" },
    { type: "simulation_dc_sweep_voltage_graph", simulation_dc_sweep_voltage_graph_id: "dc1", simulation_experiment_id: "e1", simulation_voltage_probe_id: "vp1", sweep_values: [0, 1, 2], sweep_unit: "V", voltage_levels: [0, 0.5, 1] },
  ])

  const [sweep] = result.sweeps
  assert.equal(sweep?.kind, "dc")
  assert.equal(sweep?.name, "VOUT")
  assert.equal(sweep?.xLabel, "Sweep (V)")
  assert.deepEqual(sweep?.samples, [{ x: 0, y: 0 }, { x: 1, y: 0.5 }, { x: 2, y: 1 }])
})

test("reads an AC sweep as magnitude, magnitude in dB, and phase in degrees", () => {
  const result = getSimulationResults([
    { type: "simulation_experiment", simulation_experiment_id: "e1", name: "AC", experiment_type: "spice_ac_analysis" },
    { type: "simulation_voltage_probe", simulation_voltage_probe_id: "vp1", name: "VOUT" },
    { type: "simulation_ac_sweep_voltage_graph", simulation_ac_sweep_voltage_graph_id: "ac1", simulation_experiment_id: "e1", simulation_voltage_probe_id: "vp1", frequencies_hz: [100, 1000], complex_voltages: [{ re: 1, im: 0 }, { re: 0, im: -0.5 }] },
  ])

  const [sweep] = result.sweeps
  assert.equal(sweep?.kind, "ac")
  assert.equal(sweep?.xLabel, "Frequency (Hz)")
  assert.deepEqual(sweep?.samples, [{ x: 100, y: 1 }, { x: 1000, y: 0.5 }])
  // 1.0 is 0 dB; 0.5 is about -6.02 dB with a -90 degree phase.
  assert.deepEqual(sweep?.magnitudeDb, [{ x: 100, y: 0 }, { x: 1000, y: -6.021 }])
  assert.deepEqual(sweep?.phaseDeg, [{ x: 100, y: 0 }, { x: 1000, y: -90 }])
})

test("names the analysis modes a build did not emit instead of implying coverage", () => {
  const result = getSimulationResults([])
  const analyses = result.notEvaluated.map(({ analysis }) => analysis)
  assert.deepEqual(analyses, [
    "Transient analysis",
    "DC operating point",
    "DC sweep",
    "AC analysis",
    "Temperature sweep",
    "Monte Carlo tolerance analysis",
    "Digital and mixed-signal simulation",
  ])
  for (const item of result.notEvaluated) assert.ok(item.reason.length > 20, item.analysis)
})
