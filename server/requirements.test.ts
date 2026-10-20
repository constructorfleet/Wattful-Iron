import assert from "node:assert/strict"
import test from "node:test"
import { parseRequirements, validateRequirements } from "./requirements.js"

test("parses versioned engineering requirements and rejects invalid dimensions", () => {
  assert.deepEqual(parseRequirements(JSON.stringify({
    version: 1,
    project: { name: "sensor-board" },
    requirements: { board: { width_mm: 50, height_mm: 35, layers: 4 } },
  })).requirements.board, { width_mm: 50, height_mm: 35, layers: 4 })
  assert.throws(() => parseRequirements(JSON.stringify({ version: 1, requirements: { board: { width_mm: -1 } } })), /requirements/i)
})

test("validates measurable board requirements and marks unsupported requirements not evaluated", () => {
  const requirements = parseRequirements(JSON.stringify({
    version: 1,
    requirements: {
      board: { width_mm: 50, height_mm: 35, layers: 4 },
      power: { input: "usb-c", voltage: 5, max_current_ma: 500 },
      interfaces: [{ type: "i2c", count: 2 }],
      manufacturing: { assembler: "jlcpcb" },
    },
  }))
  const result = validateRequirements(requirements, [
    { type: "pcb_board", width: 50, height: 35, num_layers: 4 },
  ])
  assert.deepEqual(result.checks.slice(0, 3).map(({ status }) => status), ["pass", "pass", "pass"])
  assert.deepEqual(result.checks.slice(3).map(({ status }) => status), ["not-evaluated", "not-evaluated", "not-evaluated"])
})

test("reports failed board requirements and missing board properties without claiming a pass", () => {
  const requirements = parseRequirements(JSON.stringify({ version: 1, requirements: { board: { width_mm: 50, height_mm: 35, layers: 4 } } }))
  const result = validateRequirements(requirements, [{ type: "pcb_board", width: 48 }])
  assert.deepEqual(result.checks.map(({ status }) => status), ["fail", "not-evaluated", "not-evaluated"])
})

test("reports a known mismatch as failed even if another board omits the property", () => {
  const requirements = parseRequirements(JSON.stringify({ version: 1, requirements: { board: { width_mm: 50 } } }))
  const result = validateRequirements(requirements, [
    { type: "pcb_board", width: 48 },
    { type: "pcb_board" },
  ])
  assert.equal(result.checks[0]?.status, "fail")
})

test("validates explicit required component references and named nets", () => {
  const requirements = parseRequirements(JSON.stringify({ version: 1, requirements: {
    components: ["U1", "R7"],
    nets: ["GND", "SDA"],
  } }))
  const result = validateRequirements(requirements, [
    { type: "source_component", name: "U1" },
    { type: "source_trace", name: "GND", connected_source_port_ids: ["port-1", "port-2"] },
  ])
  assert.deepEqual(result.checks.map(({ id, status }) => [id, status]), [
    ["component-U1", "pass"], ["component-R7", "fail"], ["net-GND", "pass"], ["net-SDA", "fail"],
  ])
  assert.deepEqual([result.passed, result.failed], [2, 2])
})

test("requires named nets to connect at least two source ports", () => {
  const requirements = parseRequirements(JSON.stringify({ version: 1, requirements: { nets: ["GND", "VCC", "UNKNOWN"] } }))
  const result = validateRequirements(requirements, [
    { type: "source_trace", name: "GND", connected_source_port_ids: ["port-1"] },
    { type: "source_trace", name: "VCC", connected_source_port_ids: ["port-2", "port-3"] },
    { type: "source_trace", name: "UNKNOWN" },
  ])

  assert.deepEqual(result.checks.map(({ id, status }) => [id, status]), [
    ["net-GND", "fail"],
    ["net-VCC", "pass"],
    ["net-UNKNOWN", "not-evaluated"],
  ])
  assert.match(result.checks[0]?.message ?? "", /only 1 connected source port/)
  assert.match(result.checks[2]?.message ?? "", /does not report connected source ports/)
})

test("does not pass required references when Circuit JSON evidence is absent", () => {
  const requirements = parseRequirements(JSON.stringify({ version: 1, requirements: { components: ["U1"], nets: ["GND"] } }))
  const result = validateRequirements(requirements, undefined)
  assert.deepEqual(result.checks.map(({ status }) => status), ["not-evaluated", "not-evaluated"])
})

test("rejects malformed required component references and nets", () => {
  assert.throws(() => parseRequirements(JSON.stringify({ version: 1, requirements: { components: [" "] } })), /requirements/i)
  assert.throws(() => parseRequirements(JSON.stringify({ version: 1, requirements: { nets: ["GND", "GND"] } })), /requirements/i)
})
