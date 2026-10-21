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
