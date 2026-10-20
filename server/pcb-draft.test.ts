import assert from "node:assert/strict"
import test from "node:test"
import { convertCircuitJsonToTscircuit } from "circuit-json-to-tscircuit"
import { withGeneratedPcbDraft } from "./pcb-draft.js"

test("draft conversion places each imported component independently and preserves the schematic", () => {
  const input = [
    { type: "source_component", source_component_id: "r1", name: "R1", ftype: "simple_resistor", manufacturer_part_number: "10k" },
    { type: "source_component", source_component_id: "c1", name: "C1", ftype: "simple_capacitor", manufacturer_part_number: "100nF" },
    { type: "source_port", source_port_id: "r1p1", source_component_id: "r1", name: "1", pin_number: 1 },
    { type: "source_port", source_port_id: "r1p2", source_component_id: "r1", name: "2", pin_number: 2 },
    { type: "source_port", source_port_id: "c1p1", source_component_id: "c1", name: "1", pin_number: 1 },
    { type: "source_port", source_port_id: "c1p2", source_component_id: "c1", name: "2", pin_number: 2 },
    { type: "schematic_component", schematic_component_id: "rs", source_component_id: "r1", center: { x: 0, y: 0 }, size: { width: 2, height: 1 } },
    { type: "schematic_text", schematic_text_id: "rt", text: "R1", schematic_component_id: "rs", position: { x: 5, y: 1 } },
    { type: "schematic_component", schematic_component_id: "cs", source_component_id: "c1", center: { x: 5, y: 0 }, size: { width: 2, height: 1 }, symbol_display_value: "LOLIN D1 MINI" },
    { type: "schematic_text", schematic_text_id: "ct", text: "C1", schematic_component_id: "cs", position: { x: 0, y: 1 } },
    { type: "source_trace", source_trace_id: "net", name: "NET", connected_source_port_ids: ["r1p1", "c1p1"], connected_source_net_ids: [] },
    { type: "schematic_line", schematic_line_id: "wire", x1: 0, y1: 0, x2: 5, y2: 0 },
  ]
  const draft = withGeneratedPcbDraft(input)
  assert.equal(draft.placements, 2)
  assert.equal(draft.circuitJson.filter((item) => item.type === "pcb_component").length, 2)
  assert.equal(draft.circuitJson.filter((item) => item.type === "pcb_smtpad").length, 4)
  assert.equal(draft.circuitJson.filter((item) => item.type === "pcb_port").length, 4)
  assert.equal(draft.circuitJson.find((item) => item.type === "source_component" && item.source_component_id === "c1")?.display_name, "LOLIN D1 MINI")
  const source = convertCircuitJsonToTscircuit(draft.circuitJson as never, { componentName: "DraftBoard" })
  assert.match(source, /<chip name="R1"/)
  assert.match(source, /<chip name="C1"/)
  assert.match(source, /<schematicline/)
})
