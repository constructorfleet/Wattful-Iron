import assert from "node:assert/strict"
import test from "node:test"
import { runCircuitDesignChecks } from "./circuit-design-checks.js"

test("design checks report a required floating pin as an error with its source reference", async () => {
  const result = await runCircuitDesignChecks([
    { type: "source_component", source_component_id: "s1", name: "U1" },
    { type: "source_port", source_component_id: "s1", source_port_id: "p1", name: "VIN", must_be_connected: true },
    { type: "pcb_board", pcb_board_id: "b1", center: { x: 0, y: 0 }, width: 20, height: 10 },
  ])

  assert.equal(result.status, "fail")
  assert.equal(result.issues.length, 1)
  assert.equal(result.issues[0]?.severity, "error")
  assert.equal(result.issues[0]?.type, "source_pin_must_be_connected_error")
  assert.deepEqual(result.issues[0]?.affectedIds, ["s1", "p1"])
  assert.match(result.issues[0]?.message ?? "", /VIN.*floating/)
})

test("design checks do not claim a pass when Circuit JSON has no checkable design data", async () => {
  const result = await runCircuitDesignChecks([])
  assert.equal(result.status, "not-evaluated")
  assert.equal(result.issues.length, 0)
})

test("a checkable board with no findings passes the supported tscircuit checks", async () => {
  const result = await runCircuitDesignChecks([
    { type: "pcb_board", pcb_board_id: "b1", center: { x: 0, y: 0 }, width: 20, height: 10 },
  ])
  assert.equal(result.status, "pass")
  assert.equal(result.issues.length, 0)
})
