import { buildNetTraceIndex } from "./net-trace.js"
import { getSimulationResults } from "./simulation.js"

type JsonElement = Record<string, unknown> & { type?: string }

export type TraceCapacity = {
  pcbTraceId?: string
  widthMm: number
  layers: string[]
  maxCurrentA: number
}

/** A node voltage read from a DC operating point. */
export type NodeVoltage = { name: string; voltageV: number; netId?: string }
/** A branch current read from a DC operating point. */
export type BranchCurrent = { name: string; currentA: number; netId?: string; sourceComponentId?: string; componentName?: string }
/** Power dissipated by one component, with the calculation it came from. */
export type ComponentPower = { sourceComponentId: string; name: string; ftype?: string; dissipationW: number; method: "I2R" | "V2R" }
/** Current drawn from one supply component, and its power when the supply voltage is declared. */
export type SupplyLoad = { sourceComponentId?: string; name: string; currentA: number; voltageV?: number; powerW?: number }
/** Measured current on a routed trace against its IPC-2221 capacity. */
export type TraceLoad = {
  pcbTraceId?: string
  netId?: string
  netName?: string
  currentA: number
  maxCurrentA: number
  utilization: number
  status: "ok" | "over-capacity"
}

export type PowerAnalysis = {
  status: "complete" | "partial" | "not-evaluated"
  assumptions: string[]
  traceCapacity: TraceCapacity[]
  narrowestTrace?: TraceCapacity
  nodeVoltages: NodeVoltage[]
  branchCurrents: BranchCurrent[]
  componentPower: ComponentPower[]
  supplyLoads: SupplyLoad[]
  traceLoads: TraceLoad[]
  totalSupplyCurrentA?: number
  totalDissipationW?: number
  notEvaluated: Array<{ quantity: string; reason: string }>
}

/** Component types whose branch current is the current drawn from a supply. */
const SUPPLY_FTYPES = ["simple_power_source", "simple_battery", "simple_voltage_source"]

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
  const operating = readOperatingPointLoads(elements)
  const assumptions = [
    `IPC-2221 current capacity at a ${temperatureRiseC} degree Celsius temperature rise.`,
    `${copperOunces} ounce copper, so ${(copperOunces * ONE_OUNCE_COPPER_MIL).toFixed(3)} mil finished thickness.`,
    "Trace capacity is a geometric limit for an isolated trace. It does not account for adjacent copper, planes, vias, or ambient temperature.",
    ...(operating.nodeVoltages.length || operating.branchCurrents.length
      ? ["Operating-point values come from the DC operating point emitted by the tscircuit SPICE run in this build, at its configured source values only."]
      : []),
  ]

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

  const traceLoads = readTraceLoads(circuitJson, operating.branchCurrents, capacity)
  const totalSupplyCurrentA = operating.supplyLoads.length
    ? roundFine(operating.supplyLoads.reduce((total, load) => total + Math.abs(load.currentA), 0))
    : undefined
  const totalDissipationW = operating.componentPower.length
    ? roundFine(operating.componentPower.reduce((total, component) => total + component.dissipationW, 0))
    : undefined

  const notEvaluated = [
    ...(capacity.length ? [] : [{
      quantity: "Trace current capacity",
      reason: traces.length
        ? "The emitted pcb_trace elements carry no segment width, so no capacity can be calculated."
        : "This build emitted no pcb_trace elements, so there is no routed copper to measure.",
    }]),
    ...(operating.supplyLoads.length ? [] : [{
      quantity: "Total current requirement",
      reason: "No supply branch current was emitted. Add a tscircuit current probe on a power source, battery, or voltage source and run a DC operating point.",
    }]),
    { quantity: "Regulator loading", reason: "Requires a regulator model and its declared limits, neither of which is present in Circuit JSON." },
    ...(operating.componentPower.length ? [] : [{
      quantity: "Component power dissipation",
      reason: "Requires a branch current through, or a voltage across, a component with a declared resistance from a DC operating point. None was emitted in this build.",
    }]),
    { quantity: "Resistor power rating headroom", reason: "Circuit JSON records resistance but no power rating, so dissipation cannot be compared with a rating." },
    ...(traceLoads.length ? [] : [{
      quantity: "Trace current loading",
      reason: "Comparing measured current with trace capacity needs a branch current whose net carries routed copper. None was available in this build.",
    }]),
    { quantity: "Thermal rise of components and planes", reason: "Not implemented. No thermal model or copper area analysis is performed." },
  ]

  const base = {
    assumptions,
    traceCapacity: capacity,
    ...(capacity.length ? { narrowestTrace: capacity.reduce((narrowest, trace) => trace.maxCurrentA < narrowest.maxCurrentA ? trace : narrowest) } : {}),
    nodeVoltages: operating.nodeVoltages,
    branchCurrents: operating.branchCurrents,
    componentPower: operating.componentPower,
    supplyLoads: operating.supplyLoads,
    traceLoads,
    ...(totalSupplyCurrentA === undefined ? {} : { totalSupplyCurrentA }),
    ...(totalDissipationW === undefined ? {} : { totalDissipationW }),
    notEvaluated,
  }
  const evaluatedAnything = capacity.length > 0 || operating.nodeVoltages.length > 0 || operating.branchCurrents.length > 0
  return { status: evaluatedAnything ? "partial" : "not-evaluated", ...base }
}

/**
 * Derive node voltages, branch currents, component dissipation, and supply load from the
 * DC operating point this build emitted. Nothing here is estimated: a quantity is reported
 * only when the simulator produced the value it needs.
 */
function readOperatingPointLoads(elements: JsonElement[]) {
  const simulation = getSimulationResults(elements)
  const components = new Map(elements.filter((element) => element.type === "source_component" && typeof element.source_component_id === "string")
    .map((element) => [String(element.source_component_id), element]))
  const componentIdByPort = new Map(elements.filter((element) => element.type === "source_port")
    .map((element) => [String(element.source_port_id), String(element.source_component_id)]))
  const probes = new Map(elements.filter((element) => element.type === "simulation_voltage_probe" || element.type === "simulation_current_probe")
    .map((element) => [String(element.simulation_voltage_probe_id ?? element.simulation_current_probe_id), element]))

  const nodeVoltages: NodeVoltage[] = []
  const branchCurrents: BranchCurrent[] = []
  for (const point of simulation.operatingPoints) {
    if (point.unit === "V") {
      nodeVoltages.push({ name: point.name, voltageV: roundFine(point.value), netId: point.netId })
      continue
    }
    const component = point.sourceComponentId ? components.get(point.sourceComponentId) : undefined
    branchCurrents.push({
      name: point.name,
      currentA: roundFine(point.value),
      netId: point.netId,
      sourceComponentId: point.sourceComponentId,
      componentName: typeof component?.name === "string" ? component.name : undefined,
    })
  }

  const componentPower: ComponentPower[] = []
  for (const branch of branchCurrents) {
    const component = branch.sourceComponentId ? components.get(branch.sourceComponentId) : undefined
    const resistance = finite(component?.resistance)
    if (!component || resistance === undefined || resistance <= 0) continue
    componentPower.push({
      sourceComponentId: branch.sourceComponentId!,
      name: String(component.name ?? branch.sourceComponentId),
      ftype: typeof component.ftype === "string" ? component.ftype : undefined,
      dissipationW: roundFine(branch.currentA * branch.currentA * resistance),
      method: "I2R",
    })
  }
  // A voltage probe measuring both terminals of a resistor gives V^2/R without a current probe.
  for (const element of elements) {
    if (element.type !== "simulation_dc_operating_point_voltage") continue
    const probe = probes.get(String(element.simulation_voltage_probe_id ?? ""))
    const signalComponent = componentIdByPort.get(String(probe?.signal_input_source_port_id ?? ""))
    const referenceComponent = componentIdByPort.get(String(probe?.reference_input_source_port_id ?? ""))
    if (!signalComponent || signalComponent !== referenceComponent) continue
    if (componentPower.some((entry) => entry.sourceComponentId === signalComponent)) continue
    const component = components.get(signalComponent)
    const resistance = finite(component?.resistance)
    const voltage = finite(element.voltage)
    if (!component || resistance === undefined || resistance <= 0 || voltage === undefined) continue
    componentPower.push({
      sourceComponentId: signalComponent,
      name: String(component.name ?? signalComponent),
      ftype: typeof component.ftype === "string" ? component.ftype : undefined,
      dissipationW: roundFine(voltage * voltage / resistance),
      method: "V2R",
    })
  }

  const supplyLoads: SupplyLoad[] = branchCurrents.flatMap((branch) => {
    const component = branch.sourceComponentId ? components.get(branch.sourceComponentId) : undefined
    if (!component || !SUPPLY_FTYPES.includes(String(component.ftype))) return []
    const voltageV = finite(component.voltage)
    return [{
      sourceComponentId: branch.sourceComponentId,
      name: String(component.name ?? branch.name),
      currentA: branch.currentA,
      ...(voltageV === undefined ? {} : { voltageV, powerW: roundFine(Math.abs(branch.currentA) * voltageV) }),
    }]
  })

  return { nodeVoltages, branchCurrents, componentPower, supplyLoads }
}

/** Compare each measured branch current with the capacity of the copper carrying its net. */
function readTraceLoads(circuitJson: unknown, branchCurrents: BranchCurrent[], capacity: TraceCapacity[]): TraceLoad[] {
  const currents = branchCurrents.filter((branch) => branch.netId)
  if (!currents.length || !capacity.length) return []
  const index = buildNetTraceIndex(circuitJson)
  const capacityById = new Map(capacity.filter((trace) => trace.pcbTraceId).map((trace) => [trace.pcbTraceId!, trace]))
  const loads: TraceLoad[] = []
  for (const branch of currents) {
    const net = index.nets.find((item) => item.id === branch.netId || item.connectivityKey === branch.netId
      || item.pins.some((pin) => pin.sourcePortId === branch.netId))
    if (!net) continue
    for (const copper of net.copperTraces) {
      const limit = capacityById.get(copper.pcbTraceId)
      if (!limit) continue
      const currentA = Math.abs(branch.currentA)
      const utilization = round(currentA / limit.maxCurrentA)
      loads.push({
        pcbTraceId: copper.pcbTraceId,
        netId: net.id,
        netName: net.name,
        currentA,
        maxCurrentA: limit.maxCurrentA,
        utilization,
        status: currentA > limit.maxCurrentA ? "over-capacity" : "ok",
      })
    }
  }
  return loads
}

function finite(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : undefined }
function round(value: number) { return Math.round(value * 1000) / 1000 }
/** Power and current values are kept to microwatt/microamp resolution so small loads survive rounding. */
function roundFine(value: number) { return Math.round(value * 1e6) / 1e6 }

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
