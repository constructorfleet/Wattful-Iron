type JsonElement = Record<string, unknown> & { type?: string }

export type TraceCapacity = {
  pcbTraceId?: string
  widthMm: number
  layers: string[]
  maxCurrentA: number
}

export type PowerAnalysis = {
  status: "complete" | "partial" | "not-evaluated"
  assumptions: string[]
  traceCapacity: TraceCapacity[]
  narrowestTrace?: TraceCapacity
  notEvaluated: Array<{ quantity: string; reason: string }>
}

/** IPC-2221 constants for the external and internal copper-layer current curves. */
const IPC_2221 = { external: 0.048, internal: 0.024, temperatureExponent: 0.44, areaExponent: 0.725 }
/** Thickness of one ounce of copper, the common default finish for a two-layer board. */
const ONE_OUNCE_COPPER_MIL = 1.378
const MM_PER_MIL = 0.0254
const DEFAULT_TEMPERATURE_RISE_C = 10

const isElement = (value: unknown): value is JsonElement => typeof value === "object" && value !== null

/**
 * Report the current each routed trace can carry, using the IPC-2221 external and
 * internal curves. Everything that needs operating-point values is reported as not
 * evaluated rather than estimated.
 */
export function analyzePower(circuitJson: unknown, options: { temperatureRiseC?: number; copperOunces?: number } = {}): PowerAnalysis {
  const temperatureRiseC = options.temperatureRiseC ?? DEFAULT_TEMPERATURE_RISE_C
  const copperOunces = options.copperOunces ?? 1
  if (!(temperatureRiseC > 0 && temperatureRiseC <= 100)) throw new Error("Temperature rise must be above 0 and at most 100 degrees Celsius")
  if (!(copperOunces > 0 && copperOunces <= 10)) throw new Error("Copper weight must be above 0 and at most 10 ounces")

  const elements = Array.isArray(circuitJson) ? circuitJson.filter(isElement) : []
  const traces = elements.filter((element) => element.type === "pcb_trace")
  const notEvaluated = [
    { quantity: "Total current requirement", reason: "No operating-point data. Circuit JSON carries no load currents, and no simulation result provides them." },
    { quantity: "Regulator loading", reason: "Requires declared load currents and a regulator model, neither of which is present in Circuit JSON." },
    { quantity: "Component power dissipation", reason: "Requires node voltages or branch currents from a simulation. Configure a tscircuit analog simulation and read its results." },
    { quantity: "Resistor power rating headroom", reason: "Circuit JSON records resistance but not a power rating, and dissipation needs an operating point." },
    { quantity: "Thermal rise of components and planes", reason: "Not implemented. No thermal model or copper area analysis is performed." },
  ]
  const assumptions = [
    `IPC-2221 current capacity at a ${temperatureRiseC} degree Celsius temperature rise.`,
    `${copperOunces} ounce copper, so ${(copperOunces * ONE_OUNCE_COPPER_MIL).toFixed(3)} mil finished thickness.`,
    "Trace capacity is a geometric limit for an isolated trace. It does not account for adjacent copper, planes, vias, or ambient temperature.",
  ]

  if (!traces.length) {
    return {
      status: "not-evaluated",
      assumptions,
      traceCapacity: [],
      notEvaluated: [{ quantity: "Trace current capacity", reason: "This build emitted no pcb_trace elements, so there is no routed copper to measure." }, ...notEvaluated],
    }
  }

  const capacity = traces.flatMap((trace): TraceCapacity[] => {
    const segments = Array.isArray(trace.route) ? trace.route.filter(isElement) : []
    const widths = segments.flatMap((segment) => typeof segment.width === "number" && segment.width > 0 ? [segment.width] : [])
    if (!widths.length) return []
    const widthMm = Math.min(...widths)
    const layers = [...new Set(segments.flatMap((segment) => typeof segment.layer === "string" ? [segment.layer] : []))].sort()
    return [{
      pcbTraceId: typeof trace.pcb_trace_id === "string" ? trace.pcb_trace_id : undefined,
      widthMm,
      layers,
      maxCurrentA: traceCurrentCapacityA(widthMm, layers, temperatureRiseC, copperOunces),
    }]
  })

  if (!capacity.length) {
    return {
      status: "not-evaluated",
      assumptions,
      traceCapacity: [],
      notEvaluated: [{ quantity: "Trace current capacity", reason: "The emitted pcb_trace elements carry no segment width, so no capacity can be calculated." }, ...notEvaluated],
    }
  }

  const narrowestTrace = capacity.reduce((narrowest, trace) => trace.maxCurrentA < narrowest.maxCurrentA ? trace : narrowest)
  return { status: "partial", assumptions, traceCapacity: capacity, narrowestTrace, notEvaluated }
}

/**
 * IPC-2221 current capacity: I = k * dT^0.44 * A^0.725, with cross-sectional area in
 * square mil. Internal layers use the lower constant because they dissipate less heat.
 */
export function traceCurrentCapacityA(widthMm: number, layers: string[], temperatureRiseC: number, copperOunces: number) {
  const widthMil = widthMm / MM_PER_MIL
  const thicknessMil = copperOunces * ONE_OUNCE_COPPER_MIL
  const areaSquareMil = widthMil * thicknessMil
  const internal = layers.length > 0 && layers.every((layer) => layer !== "top" && layer !== "bottom")
  const k = internal ? IPC_2221.internal : IPC_2221.external
  const current = k * temperatureRiseC ** IPC_2221.temperatureExponent * areaSquareMil ** IPC_2221.areaExponent
  return Math.round(current * 1000) / 1000
}
