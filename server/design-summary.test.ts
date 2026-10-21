import assert from "node:assert/strict"
import { test } from "node:test"
import { designDiffUnavailable, diffDesignSummaries, summarizeDesign } from "./design-summary.js"

const build = (overrides: { boardWidth?: number; resistance?: number; extra?: Array<Record<string, unknown>> } = {}) => [
  { type: "pcb_board", pcb_board_id: "b1", width: overrides.boardWidth ?? 26, height: 14, num_layers: 2 },
  { type: "source_component", source_component_id: "sc1", name: "R1", ftype: "simple_resistor", resistance: overrides.resistance ?? 10000, display_resistance: `${(overrides.resistance ?? 10000) / 1000}kΩ` },
  { type: "source_component", source_component_id: "sc2", name: "R2", ftype: "simple_resistor", display_resistance: "10kΩ" },
  { type: "source_port", source_port_id: "sp1", source_component_id: "sc1", name: "pin1", subcircuit_connectivity_map_key: "net1" },
  { type: "source_port", source_port_id: "sp2", source_component_id: "sc2", name: "pin1", subcircuit_connectivity_map_key: "net1" },
  { type: "source_trace", source_trace_id: "st1", name: "SENSE", connected_source_port_ids: ["sp1", "sp2"], connected_source_net_ids: [], subcircuit_connectivity_map_key: "net1" },
  { type: "pcb_component", pcb_component_id: "pc1", source_component_id: "sc1", footprint: "0603" },
  { type: "pcb_smtpad", pcb_smtpad_id: "pad1", pcb_port_id: "pp1" },
  ...(overrides.extra ?? []),
]

test("summarizes the board, components, nets, and counts a build produced", () => {
  const summary = summarizeDesign(build(), "rev-1", "2026-10-20T00:00:00.000Z")
  assert.deepEqual(summary.board, { widthMm: 26, heightMm: 14, layers: 2 })
  assert.deepEqual(summary.components.map(({ name, value, footprint, pinCount }) => [name, value, footprint, pinCount]), [
    ["R1", "10kΩ", "0603", 1],
    ["R2", "10kΩ", undefined, 1],
  ])
  assert.deepEqual(summary.nets, [{ name: "SENSE", pinCount: 2, routing: "unrouted" }])
  assert.deepEqual(summary.counts, { components: 2, nets: 1, pcbTraces: 0, vias: 0, pads: 1, unroutedNets: 1 })
  assert.equal(summary.simulation.status, "not_configured")
  assert.equal(summary.revision, "rev-1")
})

test("reports what changed between two builds rather than only the source text", () => {
  const before = summarizeDesign(build(), "rev-1")
  const after = summarizeDesign(build({
    boardWidth: 30,
    resistance: 22000,
    extra: [
      { type: "source_component", source_component_id: "sc3", name: "C1", ftype: "simple_capacitor", display_capacitance: "100nF" },
      { type: "pcb_trace", pcb_trace_id: "pt1", connection_name: "st1", connectsTo: ["pp1"], route: [{ route_type: "wire", x: 0, y: 0, width: 0.2, layer: "top" }] },
    ],
  }), "rev-2")
  const diff = diffDesignSummaries(before, after)

  assert.deepEqual(diff.board, [{ property: "widthMm", before: 26, after: 30 }])
  assert.deepEqual(diff.components.added.map(({ name }) => name), ["C1"])
  assert.deepEqual(diff.components.removed, [])
  assert.deepEqual(diff.components.changed, [{ name: "R1", changes: [{ property: "value", before: "10kΩ", after: "22kΩ" }] }])
  assert.deepEqual(diff.counts.find(({ metric }) => metric === "components"), { metric: "components", before: 2, after: 3 })
  assert.deepEqual(diff.counts.find(({ metric }) => metric === "pcbTraces"), { metric: "pcbTraces", before: 0, after: 1 })
  assert.ok(diff.limitations.some((item) => item.includes("Rendered schematic, PCB, and 3D images are not compared")))
})

test("reports a removed component and a net whose routing changed", () => {
  const before = summarizeDesign(build(), "rev-1")
  const after = summarizeDesign(build().filter((element) => element.source_component_id !== "sc2"), "rev-2")
  const diff = diffDesignSummaries(before, after)
  assert.deepEqual(diff.components.removed.map(({ name }) => name), ["R2"])
  assert.deepEqual(diff.nets.changed, [{ name: "SENSE", changes: [{ property: "pinCount", before: 2, after: 1 }, { property: "routing", before: "unrouted", after: "not-applicable" }] }])
})

test("says why a design comparison is unavailable instead of showing no changes", () => {
  const unavailable = designDiffUnavailable(["rev-1"])
  assert.equal(unavailable.available, false)
  assert.match(unavailable.reason, /No retained build summary for revision rev-1/)
  assert.match(unavailable.reason, /summaries are written when a build succeeds/)
})
