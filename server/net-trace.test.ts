import assert from "node:assert/strict"
import { test } from "node:test"
import { buildNetTraceIndex, findNet, findNetForPort } from "./net-trace.js"

const divider = [
  { type: "source_component", source_component_id: "sc1", name: "R1", ftype: "simple_resistor" },
  { type: "source_component", source_component_id: "sc2", name: "R2", ftype: "simple_resistor" },
  { type: "source_component", source_component_id: "sc3", name: "C1", ftype: "simple_capacitor" },
  { type: "source_port", source_port_id: "sp1", name: "pin1", pin_number: 1, source_component_id: "sc1", subcircuit_connectivity_map_key: "board_connectivity_net0" },
  { type: "source_port", source_port_id: "sp2", name: "pin2", pin_number: 2, source_component_id: "sc1", subcircuit_connectivity_map_key: "board_connectivity_net1" },
  { type: "source_port", source_port_id: "sp3", name: "pin1", pin_number: 1, source_component_id: "sc2", subcircuit_connectivity_map_key: "board_connectivity_net1" },
  { type: "source_port", source_port_id: "sp4", name: "pin1", pin_number: 1, source_component_id: "sc3", subcircuit_connectivity_map_key: "board_connectivity_net1" },
  { type: "source_trace", source_trace_id: "st1", name: "VCC", connected_source_port_ids: ["sp1"], connected_source_net_ids: [], subcircuit_connectivity_map_key: "board_connectivity_net0" },
  { type: "source_trace", source_trace_id: "st2", name: "SENSE", connected_source_port_ids: ["sp2", "sp3"], connected_source_net_ids: [], subcircuit_connectivity_map_key: "board_connectivity_net1" },
  { type: "source_trace", source_trace_id: "st3", name: "SENSE", connected_source_port_ids: ["sp4", "sp2"], connected_source_net_ids: [], subcircuit_connectivity_map_key: "board_connectivity_net1" },
  { type: "pcb_port", pcb_port_id: "pp2", source_port_id: "sp2", layers: ["top"], x: 0, y: 0 },
  { type: "pcb_port", pcb_port_id: "pp3", source_port_id: "sp3", layers: ["top"], x: 3, y: 0 },
  { type: "pcb_port", pcb_port_id: "pp4", source_port_id: "sp4", layers: ["top"], x: 3, y: 4 },
  {
    type: "pcb_trace",
    pcb_trace_id: "pt1",
    connection_name: "st2",
    connectsTo: ["pp2", "pp3"],
    route: [
      { route_type: "wire", x: 0, y: 0, width: 0.15, layer: "top", start_pcb_port_id: "pp2" },
      { route_type: "wire", x: 3, y: 0, width: 0.15, layer: "top" },
      { route_type: "via", x: 3, y: 0, from_layer: "top", to_layer: "bottom" },
      { route_type: "wire", x: 3, y: 4, width: 0.2, layer: "bottom", end_pcb_port_id: "pp3" },
    ],
  },
  { type: "pcb_via", pcb_via_id: "pv1", pcb_trace_id: "pt1", x: 3, y: 0, from_layer: "top", to_layer: "bottom", layers: ["top", "bottom"], subcircuit_connectivity_map_key: "board_connectivity_net1" },
  { type: "schematic_trace", schematic_trace_id: "scht1", source_trace_id: "schematic_port_1-schematic_port_2", edges: [{ from: { x: 0, y: 0 }, to: { x: 1, y: 0 } }], subcircuit_connectivity_map_key: "board_connectivity_net1" },
]

test("groups source traces that share a port into one net across views", () => {
  const index = buildNetTraceIndex(divider)
  const sense = findNet(index, "SENSE")

  assert.equal(sense.name, "SENSE")
  assert.deepEqual(sense.sourceTraceIds.sort(), ["st2", "st3"])
  assert.deepEqual(sense.pins.map((pin) => `${pin.componentName}.${pin.pinName}`).sort(), ["C1.pin1", "R1.pin2", "R2.pin1"])
  assert.deepEqual(sense.schematicTraces, [{ schematicTraceId: "scht1", edgeCount: 1 }])
  assert.equal(sense.vias.length, 1)
  assert.deepEqual(sense.vias[0], { pcbViaId: "pv1", x: 3, y: 0, fromLayer: "top", toLayer: "bottom" })
})

test("reports copper geometry per net and the narrowest routed width", () => {
  const [copper] = findNet(buildNetTraceIndex(divider), "SENSE").copperTraces
  assert.equal(copper?.pcbTraceId, "pt1")
  assert.deepEqual(copper?.layers, ["top", "bottom"])
  assert.equal(copper?.widthMm, 0.15)
  // Only the 3 mm same-layer segment contributes; the layer change through the via does not.
  assert.equal(copper?.lengthMm, 3)
  assert.deepEqual(copper?.connectedPcbPortIds.sort(), ["pp2", "pp3"])
})

test("separates routed, partially routed, and unroutable nets", () => {
  const index = buildNetTraceIndex(divider)
  // C1.pin1 has a PCB port with no copper reaching it, so the net is only partially routed.
  assert.equal(findNet(index, "SENSE").routing, "partially-routed")
  // VCC has a single pin, so pin-to-pin routing does not apply.
  assert.equal(findNet(index, "VCC").routing, "not-applicable")

  const unrouted = buildNetTraceIndex(divider.filter((element) => element.type !== "pcb_trace" && element.type !== "pcb_via"))
  assert.equal(findNet(unrouted, "SENSE").routing, "unrouted")
  assert.deepEqual(findNet(unrouted, "SENSE").copperTraces, [])
})

test("correlates simulation signals with nets and lists the rest as uncorrelated", () => {
  const index = buildNetTraceIndex([
    ...divider,
    { type: "simulation_experiment", simulation_experiment_id: "se1", name: "Transient", experiment_type: "spice_transient_analysis" },
    { type: "simulation_voltage_probe", simulation_voltage_probe_id: "p1", name: "SENSE", signal_input_source_net_id: "board_connectivity_net1" },
    { type: "simulation_voltage_probe", simulation_voltage_probe_id: "p2", name: "FLOATING" },
    { type: "simulation_transient_voltage_graph", simulation_transient_voltage_graph_id: "g1", simulation_voltage_probe_id: "p1", start_time_ms: 0, time_per_step: 1, voltage_levels: [0, 1] },
    { type: "simulation_transient_voltage_graph", simulation_transient_voltage_graph_id: "g2", simulation_voltage_probe_id: "p2", start_time_ms: 0, time_per_step: 1, voltage_levels: [2, 3] },
  ])

  assert.deepEqual(findNet(index, "SENSE").simulationSignals, [{ id: "g1", name: "SENSE", unit: "V" }])
  assert.deepEqual(index.uncorrelatedSimulationSignals, [{ id: "g2", name: "FLOATING", unit: "V" }])
})

test("finds the net a selected pin belongs to", () => {
  const index = buildNetTraceIndex(divider)
  assert.equal(findNetForPort(index, "sp3")?.name, "SENSE")
  assert.equal(findNetForPort(index, "missing-port"), undefined)
})

test("names its limitations instead of reporting an empty pass", () => {
  const index = buildNetTraceIndex([{ type: "not_circuit_json" }])
  assert.deepEqual(index.nets, [])
  assert.ok(index.limitations.some((item) => item.includes("no highlight API")))
  assert.ok(index.limitations.some((item) => item.includes("not signal propagation")))
  assert.throws(() => findNet(index, "VCC"), /No net in the latest successful build matches 'VCC'/)
})
