import assert from "node:assert/strict"
import test from "node:test"
import { enrichEasyedaComponentMetadata } from "./easyeda-component-metadata.js"

test("preserves EasyEDA reference, component value, package, and actual MPN on its matching source part", () => {
  const circuit = [
    { type: "source_component", source_component_id: "u1", name: "Hunter:U_F5D31827", manufacturer_part_number: "Lolin D1 Mini" },
    { type: "schematic_component", schematic_component_id: "symbol-u1", source_component_id: "u1", center: { x: 2.2286666666666672, y: 20.568 }, symbol_display_value: "Lolin D1 Mini" },
  ]
  const document = { schematics: [{ dataStr: { shape: [
    "LIB~545~-630~package`LOLIN D1 MINI`Manufacturer Part``#@$T~N~548~-631~0~#000080~Arial~~~~~comment~Lolin D1 Mini~1~start~gge385~0#@$T~P~549~-641~0~#000080~Arial~~~~~comment~U1~1~start~gge391~0",
  ] } }] }
  const component = (enrichEasyedaComponentMetadata(circuit, [document]) as Array<Record<string, unknown>>).find((item) => item.type === "source_component")!
  assert.equal(component.name, "U1")
  assert.equal(component.display_name, "Lolin D1 Mini")
  assert.equal(component.display_value, "Lolin D1 Mini")
  assert.equal(component.manufacturer_part_number, undefined)
  assert.equal(component.easyeda_package, "LOLIN D1 MINI")
})
