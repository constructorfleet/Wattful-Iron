import { getFullConnectivityMapFromCircuitJson } from "circuit-json-to-connectivity-map"
import { getSimulationResults } from "./simulation.js"

type Element = Record<string, unknown> & { type?: string }

export type NetPin = {
  sourcePortId: string
  pinName: string
  pinNumber?: number
  sourceComponentId?: string
  componentName?: string
  pcbPortId?: string
  routed: boolean
}
export type NetCopperTrace = { pcbTraceId: string; layers: string[]; widthMm?: number; lengthMm: number; connectedPcbPortIds: string[] }
export type NetVia = { pcbViaId: string; x: number; y: number; fromLayer?: string; toLayer?: string }
export type NetSchematicTrace = { schematicTraceId: string; edgeCount: number }
export type NetSimulationSignal = { id: string; name: string; unit: "V" | "A" }
/** How much of a net's pin-to-pin connectivity is present as copper in this build. */
export type NetRouting = "routed" | "partially-routed" | "unrouted" | "not-applicable"

export type TracedNet = {
  id: string
  name: string
  names: string[]
  connectivityKey?: string
  sourceTraceIds: string[]
  pins: NetPin[]
  schematicTraces: NetSchematicTrace[]
  copperTraces: NetCopperTrace[]
  vias: NetVia[]
  simulationSignals: NetSimulationSignal[]
  routing: NetRouting
}

export type NetTraceIndex = {
  nets: TracedNet[]
  uncorrelatedSimulationSignals: NetSimulationSignal[]
  limitations: string[]
}

const LIMITATIONS = [
  "Nets are grouped by the Circuit JSON connectivity map emitted by the build. Design intent is not inferred.",
  "Schematic wires, copper traces, and vias are reported by element ID and geometry. The embedded schematic, PCB, and 3D viewers expose no highlight API, so a selected net is not drawn highlighted in those canvases.",
  "Simulation correlation uses the net reference emitted on each tscircuit probe. Probes without a net reference are listed as uncorrelated.",
  "Connectivity tracing is not signal propagation: a net being routed says nothing about its electrical behavior.",
]

/**
 * Group a build's Circuit JSON into nets that span source ports, schematic wires, copper
 * traces, vias, and simulation signals, so one selection can be followed across views.
 */
export function buildNetTraceIndex(input: unknown): NetTraceIndex {
  const elements = toElements(input)
  if (!elements.length) return { nets: [], uncorrelatedSimulationSignals: [], limitations: LIMITATIONS }
  const map = getFullConnectivityMapFromCircuitJson(elements as never)

  const groups = new Map<string, TracedNet>()
  const keyToNetId = new Map<string, string>()
  const netIdForKey = (key: unknown) => typeof key === "string" ? keyToNetId.get(key) : undefined

  const group = (netId: string) => {
    const existing = groups.get(netId)
    if (existing) return existing
    const created: TracedNet = {
      id: netId, name: netId, names: [], sourceTraceIds: [], pins: [],
      schematicTraces: [], copperTraces: [], vias: [], simulationSignals: [], routing: "not-applicable",
    }
    groups.set(netId, created)
    return created
  }
  const groupFor = (id: unknown) => {
    const netId = typeof id === "string" ? map.getNetConnectedToId(id) : undefined
    return netId ? group(netId) : undefined
  }

  for (const element of elements) {
    const netId = element.type === "source_trace" || element.type === "source_port"
      ? map.getNetConnectedToId(String(element.source_trace_id ?? element.source_port_id ?? ""))
      : undefined
    const key = element.subcircuit_connectivity_map_key
    if (netId && typeof key === "string" && !keyToNetId.has(key)) keyToNetId.set(key, netId)
  }

  const components = new Map(elements.filter((element) => element.type === "source_component")
    .map((element) => [String(element.source_component_id), element]))
  const pcbPortsBySourcePort = new Map(elements.filter((element) => element.type === "pcb_port")
    .map((element) => [String(element.source_port_id), String(element.pcb_port_id)]))

  for (const element of elements) {
    if (element.type === "source_trace") {
      const net = groupFor(element.source_trace_id)
      if (!net) continue
      net.sourceTraceIds.push(String(element.source_trace_id))
      addName(net, element.name)
      net.connectivityKey ??= text(element.subcircuit_connectivity_map_key)
      continue
    }
    if (element.type === "source_port") {
      const net = groupFor(element.source_port_id)
      if (!net) continue
      const component = components.get(String(element.source_component_id))
      net.connectivityKey ??= text(element.subcircuit_connectivity_map_key)
      net.pins.push({
        sourcePortId: String(element.source_port_id),
        pinName: text(element.name) ?? (typeof element.pin_number === "number" ? `Pin ${element.pin_number}` : String(element.source_port_id)),
        pinNumber: typeof element.pin_number === "number" ? element.pin_number : undefined,
        sourceComponentId: text(element.source_component_id),
        componentName: text(component?.name) ?? text(component?.reference_designator),
        pcbPortId: pcbPortsBySourcePort.get(String(element.source_port_id)),
        routed: false,
      })
      continue
    }
    if (element.type === "pcb_trace") {
      const net = groupFor(element.pcb_trace_id) ?? groupFor(element.source_trace_id) ?? groupFor(element.connection_name)
      if (!net) continue
      net.copperTraces.push(copperTrace(element))
      continue
    }
    if (element.type === "pcb_via") {
      const net = groupFor(element.pcb_via_id) ?? groupFor(element.pcb_trace_id)
        ?? idGroup(groups, netIdForKey(element.subcircuit_connectivity_map_key))
      if (!net) continue
      net.vias.push({
        pcbViaId: String(element.pcb_via_id),
        x: finite(element.x) ?? 0,
        y: finite(element.y) ?? 0,
        fromLayer: text(element.from_layer),
        toLayer: text(element.to_layer),
      })
      continue
    }
    if (element.type === "schematic_trace") {
      const net = groupFor(element.source_trace_id) ?? idGroup(groups, netIdForKey(element.subcircuit_connectivity_map_key))
      if (!net) continue
      net.schematicTraces.push({
        schematicTraceId: String(element.schematic_trace_id),
        edgeCount: Array.isArray(element.edges) ? element.edges.length : 0,
      })
      continue
    }
    if (element.type === "schematic_net_label" || element.type === "source_net") {
      const net = groupFor(element.source_net_id) ?? idGroup(groups, netIdForKey(element.source_net_id))
      if (!net) continue
      addName(net, element.text ?? element.name)
    }
  }

  const simulation = getSimulationResults(elements)
  const uncorrelatedSimulationSignals: NetSimulationSignal[] = []
  for (const signal of simulation.signals) {
    const net = groupFor(signal.netId) ?? idGroup(groups, netIdForKey(signal.netId))
    const entry = { id: signal.id, name: signal.name, unit: signal.unit }
    if (net) net.simulationSignals.push(entry)
    else uncorrelatedSimulationSignals.push(entry)
  }

  const nets = [...groups.values()].map(finishNet).sort((left, right) => left.name.localeCompare(right.name))
  return { nets, uncorrelatedSimulationSignals, limitations: LIMITATIONS }
}

/** Return the net a source port belongs to, for cross-probing from a selected pin. */
export function findNetForPort(index: NetTraceIndex, sourcePortId: string) {
  return index.nets.find((net) => net.pins.some((pin) => pin.sourcePortId === sourcePortId))
}

/** Look a net up by the ID, connectivity key, or name an agent or the browser passed in. */
export function findNet(index: NetTraceIndex, reference: string) {
  const match = index.nets.find((net) => net.id === reference || net.connectivityKey === reference
    || net.sourceTraceIds.includes(reference) || net.names.includes(reference))
  if (!match) throw new Error(`No net in the latest successful build matches '${reference}'`)
  return match
}

function finishNet(net: TracedNet): TracedNet {
  const routedPortIds = new Set(net.copperTraces.flatMap((trace) => trace.connectedPcbPortIds))
  const pins = net.pins.map((pin) => ({ ...pin, routed: Boolean(pin.pcbPortId && routedPortIds.has(pin.pcbPortId)) }))
  const placedPins = pins.filter((pin) => pin.pcbPortId)
  const routing: NetRouting = pins.length < 2 ? "not-applicable"
    : net.copperTraces.length === 0 ? "unrouted"
      : placedPins.length === pins.length && placedPins.every((pin) => pin.routed) ? "routed" : "partially-routed"
  return {
    ...net,
    pins,
    routing,
    name: net.names[0] ?? net.connectivityKey ?? net.id,
    id: net.connectivityKey ?? net.id,
  }
}

function copperTrace(element: Element): NetCopperTrace {
  const route = Array.isArray(element.route) ? element.route.filter(isElement) : []
  const wires = route.filter((point) => point.route_type === "wire")
  const layers = [...new Set(wires.map((point) => text(point.layer)).filter((layer): layer is string => Boolean(layer)))]
  const widths = wires.map((point) => finite(point.width)).filter((width): width is number => width !== undefined)
  let lengthMm = 0
  for (let index = 1; index < wires.length; index += 1) {
    const previous = wires[index - 1]!
    const current = wires[index]!
    if (text(previous.layer) !== text(current.layer)) continue
    lengthMm += Math.hypot((finite(current.x) ?? 0) - (finite(previous.x) ?? 0), (finite(current.y) ?? 0) - (finite(previous.y) ?? 0))
  }
  const endpointIds = [
    ...wires.flatMap((point) => [text(point.start_pcb_port_id), text(point.end_pcb_port_id)]),
    ...(Array.isArray(element.connectsTo) ? element.connectsTo.map(text) : [text(element.connectsTo)]),
  ].filter((id): id is string => Boolean(id))
  return {
    pcbTraceId: String(element.pcb_trace_id),
    connectedPcbPortIds: [...new Set(endpointIds)],
    layers,
    widthMm: widths.length ? Math.min(...widths) : undefined,
    lengthMm: Math.round(lengthMm * 1000) / 1000,
  }
}

function idGroup(groups: Map<string, TracedNet>, netId?: string) {
  return netId ? groups.get(netId) : undefined
}

function addName(net: TracedNet, value: unknown) {
  const name = text(value)
  if (name && !net.names.includes(name)) net.names.push(name)
}

function toElements(input: unknown): Element[] {
  return Array.isArray(input) ? input.filter(isElement) : []
}
function isElement(value: unknown): value is Element {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
function text(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined
}
function finite(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}
