import assert from "node:assert/strict"
import { test } from "node:test"
import { analyzePower, traceCurrentCapacityA } from "./power-analysis.js"

test("trace capacity follows the published IPC-2221 curves", () => {
  // A 10 mil (0.254 mm) one-ounce external trace carries about 0.9 A at a 10 C rise.
  assert.ok(Math.abs(traceCurrentCapacityA(0.254, ["top"], 10, 1) - 0.9) < 0.05)
  // The same trace carries about 1.2 A when a 20 C rise is allowed.
  assert.ok(Math.abs(traceCurrentCapacityA(0.254, ["top"], 20, 1) - 1.2) < 0.05)
  // Internal layers use the lower constant, which is half of the external one.
  // Results are rounded to milliamps, so compare within that rounding.
  assert.ok(Math.abs(traceCurrentCapacityA(0.5, ["inner1"], 10, 1) - traceCurrentCapacityA(0.5, ["top"], 10, 1) / 2) <= 0.001)
  // Capacity rises with copper weight and width.
  assert.ok(traceCurrentCapacityA(0.5, ["top"], 10, 2) > traceCurrentCapacityA(0.5, ["top"], 10, 1))
  assert.ok(traceCurrentCapacityA(1, ["top"], 10, 1) > traceCurrentCapacityA(0.5, ["top"], 10, 1))
})

test("reports capacity per routed trace and identifies the narrowest one", () => {
  const analysis = analyzePower([
    { type: "pcb_trace", pcb_trace_id: "wide", route: [{ width: 0.8, layer: "top" }, { width: 0.8, layer: "top" }] },
    { type: "pcb_trace", pcb_trace_id: "narrow", route: [{ width: 0.8, layer: "top" }, { width: 0.15, layer: "top" }] },
    { type: "source_component", name: "R1" },
  ])
  assert.equal(analysis.status, "partial")
  assert.equal(analysis.traceCapacity.length, 2)
  assert.equal(analysis.narrowestTrace?.pcbTraceId, "narrow")
  // The narrowest segment governs the whole trace.
  assert.equal(analysis.narrowestTrace?.widthMm, 0.15)
  assert.ok(analysis.assumptions.some((note) => note.includes("IPC-2221")))
})

test("marks operating-point quantities as not evaluated rather than estimating them", () => {
  const analysis = analyzePower([{ type: "pcb_trace", pcb_trace_id: "t1", route: [{ width: 0.5, layer: "top" }] }])
  const quantities = analysis.notEvaluated.map((item) => item.quantity)
  assert.deepEqual(quantities, [
    "Total current requirement",
    "Regulator loading",
    "Component power dissipation",
    "Resistor power rating headroom",
    "Trace current loading",
    "Thermal rise of components and planes",
  ])
  for (const item of analysis.notEvaluated) assert.ok(item.reason.length > 20)
})

test("reports an unrouted or widthless build as not evaluated", () => {
  const unrouted = analyzePower([{ type: "source_component", name: "R1" }])
  assert.equal(unrouted.status, "not-evaluated")
  assert.equal(unrouted.notEvaluated[0]?.quantity, "Trace current capacity")
  assert.match(unrouted.notEvaluated[0]?.reason ?? "", /no pcb_trace elements/)
  const widthless = analyzePower([{ type: "pcb_trace", pcb_trace_id: "t1", route: [{ layer: "top" }] }])
  assert.equal(widthless.status, "not-evaluated")
  assert.match(widthless.notEvaluated[0]?.reason ?? "", /no segment width/)
  assert.equal(analyzePower("not circuit json").status, "not-evaluated")
})

test("rejects temperature rise and copper weight outside the supported range", () => {
  assert.throws(() => analyzePower([], { temperatureRiseC: 0 }), /Temperature rise/)
  assert.throws(() => analyzePower([], { temperatureRiseC: 200 }), /Temperature rise/)
  assert.throws(() => analyzePower([], { copperOunces: 0 }), /Copper weight/)
})

const operatingPointBuild = [
  { type: "source_component", source_component_id: "sc-v1", name: "V1", ftype: "simple_voltage_source", voltage: 5 },
  { type: "source_component", source_component_id: "sc-r1", name: "R1", ftype: "simple_resistor", resistance: 100 },
  { type: "source_component", source_component_id: "sc-r2", name: "R2", ftype: "simple_resistor", resistance: 220 },
  { type: "source_port", source_port_id: "sp-r2-1", source_component_id: "sc-r2", name: "pin1", subcircuit_connectivity_map_key: "net1" },
  { type: "source_port", source_port_id: "sp-r2-2", source_component_id: "sc-r2", name: "pin2", subcircuit_connectivity_map_key: "net1" },
  { type: "source_trace", source_trace_id: "st1", name: "VCC", connected_source_port_ids: ["sp-r2-1", "sp-r2-2"], connected_source_net_ids: [], subcircuit_connectivity_map_key: "net1" },
  { type: "pcb_port", pcb_port_id: "pp1", source_port_id: "sp-r2-1", layers: ["top"], x: 0, y: 0 },
  { type: "pcb_port", pcb_port_id: "pp2", source_port_id: "sp-r2-2", layers: ["top"], x: 2, y: 0 },
  { type: "pcb_trace", pcb_trace_id: "pt-thin", connection_name: "st1", connectsTo: ["pp1", "pp2"], route: [
    { route_type: "wire", x: 0, y: 0, width: 0.15, layer: "top", start_pcb_port_id: "pp1" },
    { route_type: "wire", x: 2, y: 0, width: 0.15, layer: "top", end_pcb_port_id: "pp2" },
  ] },
  { type: "simulation_experiment", simulation_experiment_id: "e1", name: "Operating point", experiment_type: "spice_dc_operating_point" },
  { type: "simulation_voltage_probe", simulation_voltage_probe_id: "vp1", name: "VOUT", signal_input_source_net_id: "net1" },
  { type: "simulation_voltage_probe", simulation_voltage_probe_id: "vp2", name: "R1 across", signal_input_source_port_id: "sp-r1-1", reference_input_source_port_id: "sp-r1-2" },
  { type: "source_port", source_port_id: "sp-r1-1", source_component_id: "sc-r1", name: "pin1" },
  { type: "source_port", source_port_id: "sp-r1-2", source_component_id: "sc-r1", name: "pin2" },
  { type: "simulation_current_probe", simulation_current_probe_id: "cp1", name: "R2 branch", source_component_id: "sc-r2", positive_source_net_id: "net1" },
  { type: "simulation_current_probe", simulation_current_probe_id: "cp2", name: "Supply", source_component_id: "sc-v1" },
  { type: "simulation_dc_operating_point_voltage", simulation_dc_operating_point_voltage_id: "opv1", simulation_experiment_id: "e1", simulation_voltage_probe_id: "vp1", voltage: 3.3 },
  { type: "simulation_dc_operating_point_voltage", simulation_dc_operating_point_voltage_id: "opv2", simulation_experiment_id: "e1", simulation_voltage_probe_id: "vp2", voltage: 2 },
  { type: "simulation_dc_operating_point_current", simulation_dc_operating_point_current_id: "opc1", simulation_experiment_id: "e1", simulation_current_probe_id: "cp1", current: 0.015 },
  { type: "simulation_dc_operating_point_current", simulation_dc_operating_point_current_id: "opc2", simulation_experiment_id: "e1", simulation_current_probe_id: "cp2", current: 0.25 },
]

test("reads node voltages and branch currents from the emitted DC operating point", () => {
  const analysis = analyzePower(operatingPointBuild)
  assert.deepEqual(analysis.nodeVoltages, [
    { name: "VOUT", voltageV: 3.3, netId: "net1" },
    { name: "R1 across", voltageV: 2, netId: undefined },
  ])
  assert.deepEqual(analysis.branchCurrents.map(({ name, currentA, componentName }) => [name, currentA, componentName]), [
    ["R2 branch", 0.015, "R2"],
    ["Supply", 0.25, "V1"],
  ])
  assert.ok(analysis.assumptions.some((note) => note.includes("DC operating point emitted by the tscircuit SPICE run")))
})

test("calculates component dissipation from current through or voltage across a resistance", () => {
  const analysis = analyzePower(operatingPointBuild)
  // R2 carries 15 mA through 220 ohms: I^2R = 0.0495 W.
  assert.deepEqual(analysis.componentPower.find(({ name }) => name === "R2"), {
    sourceComponentId: "sc-r2", name: "R2", ftype: "simple_resistor", dissipationW: 0.0495, method: "I2R",
  })
  // R1 has 2 V across 100 ohms with no current probe: V^2/R = 0.04 W.
  assert.deepEqual(analysis.componentPower.find(({ name }) => name === "R1"), {
    sourceComponentId: "sc-r1", name: "R1", ftype: "simple_resistor", dissipationW: 0.04, method: "V2R",
  })
  assert.equal(analysis.totalDissipationW, 0.0895)
  assert.ok(!analysis.notEvaluated.some(({ quantity }) => quantity === "Component power dissipation"))
})

test("reports supply current and compares measured current with trace capacity", () => {
  const analysis = analyzePower(operatingPointBuild)
  assert.deepEqual(analysis.supplyLoads, [{ sourceComponentId: "sc-v1", name: "V1", currentA: 0.25, voltageV: 5, powerW: 1.25 }])
  assert.equal(analysis.totalSupplyCurrentA, 0.25)
  const [load] = analysis.traceLoads
  assert.equal(load?.pcbTraceId, "pt-thin")
  assert.equal(load?.netName, "VCC")
  assert.equal(load?.currentA, 0.015)
  assert.equal(load?.status, "ok")
  assert.ok(load && load.utilization > 0 && load.utilization < 1)
  assert.ok(!analysis.notEvaluated.some(({ quantity }) => quantity === "Total current requirement"))
  assert.ok(!analysis.notEvaluated.some(({ quantity }) => quantity === "Trace current loading"))
})

test("flags a measured current above the capacity of the copper carrying it", () => {
  const overloaded = analyzePower(operatingPointBuild.map((element) => element.type === "simulation_dc_operating_point_current" && element.simulation_dc_operating_point_current_id === "opc1"
    ? { ...element, current: 5 }
    : element))
  const [load] = overloaded.traceLoads
  assert.equal(load?.status, "over-capacity")
  assert.ok(load && load.utilization > 1)
})

test("still names what an operating point cannot provide", () => {
  const analysis = analyzePower(operatingPointBuild)
  const quantities = analysis.notEvaluated.map(({ quantity }) => quantity)
  assert.deepEqual(quantities, ["Regulator loading", "Resistor power rating headroom", "Thermal rise of components and planes"])
  for (const item of analysis.notEvaluated) assert.ok(item.reason.length > 20, item.quantity)
})
