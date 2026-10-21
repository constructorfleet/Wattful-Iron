import assert from "node:assert/strict"
import { test } from "node:test"
import { addComponent, connectComponents, listSourceComponents, removeComponent, setBoardDimensions, setComponentProperties } from "./circuit-source.js"

const divider = `export default () => (
  <board name="Filtered voltage divider" width="26mm" height="14mm">
    <resistor name="R1" resistance="10k" footprint="0603" pcbX={-3} pcbY={0} />
    <resistor name="R2" resistance="10k" footprint="0603" pcbX={2} pcbY={0} />
    <trace from=".R1 > .pin2" to=".R2 > .pin1" name="SENSE" />
    <schematicsheet name="Divider" displayName="Divider" sheetIndex={0}>
      <schematictext text="1:2 divider" schX={0} schY={6} />
    </schematicsheet>
  </board>
)
`

const blank = `export default () => (
  <board width="20mm" height="20mm" routingDisabled>
    <schematicsheet name="Main" displayName="Main" sheetIndex={0}>
      <schematictext text="New circuit" schX={0} schY={0} />
    </schematicsheet>
  </board>
)
`

test("replaces existing board dimensions and leaves other properties alone", () => {
  const updated = setBoardDimensions(divider, { width: "30mm", height: "18mm" })
  assert.match(updated, /<board name="Filtered voltage divider" width="30mm" height="18mm">/)
  assert.equal(updated.includes('width="26mm"'), false)
})

test("adds board properties that are not present yet", () => {
  const updated = setBoardDimensions(blank, { layers: 4 })
  assert.match(updated, /<board width="20mm" height="20mm" routingDisabled layers=\{4\}>/)
})

test("rejects dimensions without a unit and layer counts that are not whole numbers", () => {
  assert.throws(() => setBoardDimensions(divider, { width: "30" }), /length with a unit/)
  assert.throws(() => setBoardDimensions(divider, { layers: 2.5 }), /whole number/)
  assert.throws(() => setBoardDimensions(divider, {}), /at least one/)
})

test("sets, replaces, and removes component properties", () => {
  const updated = setComponentProperties(divider, "R1", { resistance: "4.7k", schX: -2, footprint: null })
  assert.match(updated, /<resistor name="R1" resistance="4.7k" pcbX=\{-3\} pcbY=\{0\} schX=\{-2\} \/>/)
})

test("reports a component that does not exist", () => {
  assert.throws(() => setComponentProperties(divider, "R9", { resistance: "1k" }), /No component named R9/)
  assert.throws(() => setComponentProperties(divider, "R1", { resistance: null, footprint: null, missing: null }), /no missing property/)
})

test("appends a component after the last component and before the traces", () => {
  const updated = addComponent(divider, { element: "capacitor", name: "C1", props: { capacitance: "100nF", footprint: "0603", pcbX: 8 } })
  const lines = updated.split("\n")
  const added = lines.findIndex((line) => line.includes('name="C1"'))
  const lastResistor = lines.findIndex((line) => line.includes('name="R2"'))
  const firstTrace = lines.findIndex((line) => line.includes("<trace"))
  assert.equal(added, lastResistor + 1)
  assert.ok(added < firstTrace)
  assert.match(updated, / {4}<capacitor name="C1" capacitance="100nF" footprint="0603" pcbX=\{8\} \/>/)
})

test("adds the first component of an empty board above its schematic sheet", () => {
  const updated = addComponent(blank, { element: "resistor", name: "R1", props: { resistance: "1k" } })
  const lines = updated.split("\n")
  assert.ok(lines.findIndex((line) => line.includes("<resistor")) < lines.findIndex((line) => line.includes("<schematicsheet")))
  assert.match(updated, / {4}<resistor name="R1" resistance="1k" \/>\n {4}<schematicsheet/)
})

test("refuses duplicate names, connection elements, and unsafe element or property values", () => {
  assert.throws(() => addComponent(divider, { element: "resistor", name: "R1" }), /already exists/)
  assert.throws(() => addComponent(divider, { element: "trace", name: "T1" }), /dedicated tool/)
  assert.throws(() => addComponent(divider, { element: "Resistor", name: "R3" }), /lowercase tscircuit element/)
  assert.throws(() => addComponent(divider, { element: "resistor", name: "R3", props: { footprint: '0603" onClick="x' } }), /must not contain quotes/)
})

test("removes a component together with the traces that reference it", () => {
  const updated = removeComponent(divider, "R2")
  assert.equal(updated.includes('name="R2"'), false)
  assert.equal(updated.includes("<trace"), false)
  assert.match(updated, /<resistor name="R1"/)
  assert.deepEqual(listSourceComponents(updated), [{ element: "resistor", name: "R1" }])
})

test("connects two ports with a trace after the existing traces", () => {
  const updated = connectComponents(divider, { from: ".R2 > .pin2", to: ".R1 > .pin1", name: "GND" })
  assert.match(updated, / {4}<trace from=".R2 > .pin2" to=".R1 > .pin1" name="GND" \/>/)
  const lines = updated.split("\n")
  assert.equal(lines.findIndex((line) => line.includes('name="GND"')), lines.findIndex((line) => line.includes('name="SENSE"')) + 1)
})

test("refuses traces to unknown components, duplicate traces, and malformed selectors", () => {
  assert.throws(() => connectComponents(divider, { from: ".R9 > .pin1", to: ".R1 > .pin1" }), /No component named R9/)
  assert.throws(() => connectComponents(divider, { from: ".R1 > .pin2", to: ".R2 > .pin1" }), /already connects/)
  assert.throws(() => connectComponents(divider, { from: ".R1 > .pin1", to: ".R1 > .pin1" }), /two different selectors/)
  assert.throws(() => connectComponents(divider, { from: "R1", to: ".R2 > .pin1" }), /not a valid tscircuit selector/)
})

test("reports sources it cannot edit structurally", () => {
  assert.throws(() => setBoardDimensions("export default () => <div />\n", { width: "10mm" }), /does not contain a <board>/)
  const twoBoards = "export default () => (<group><board width=\"5mm\" /><board width=\"6mm\" /></group>)\n"
  assert.throws(() => setBoardDimensions(twoBoards, { width: "10mm" }), /more than one <board>/)
  assert.throws(() => addComponent('export default () => <board width="5mm" />\n', { element: "resistor", name: "R1" }), /no children/)
})
