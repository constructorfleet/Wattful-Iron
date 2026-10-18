type Element = Record<string, unknown> & { type?: string }

function elements(input: unknown): Element[] {
  return Array.isArray(input) ? input.filter((item): item is Element => typeof item === "object" && item !== null && !Array.isArray(item)) : []
}

export function listComponents(input: unknown) {
  const all = elements(input)
  const placements = new Map(all.filter((item) => item.type === "pcb_component").map((item) => [item.source_component_id, item]))
  return all.filter((item) => item.type === "source_component").map((component) => ({
    ...component,
    pcb: placements.get(component.source_component_id),
  }))
}

export function getComponent(input: unknown, reference: string) {
  const all = elements(input)
  const matches = all.filter((item) => item.type === "source_component" && (
    item.source_component_id === reference || item.name === reference || item.reference_designator === reference
  ))
  if (matches.length === 0) throw new Error(`No Circuit JSON source_component matches '${reference}'`)
  if (matches.length > 1) throw new Error(`More than one Circuit JSON source_component matches '${reference}'`)
  const component = matches[0]!
  const componentId = component.source_component_id
  const placement = all.find((item) => item.type === "pcb_component" && item.source_component_id === componentId)
  const ports = all.filter((item) => item.type === "source_port" && item.source_component_id === componentId)
  const traces = all.filter((item) => item.type === "source_trace")
  return {
    ...component,
    ...(placement ? { pcb: placement } : {}),
    pins: ports.map((port) => ({
      ...port,
      connections: traces.filter((trace) => stringArray(trace.connected_source_port_ids).includes(String(port.source_port_id)))
        .map((trace) => ({ source_trace_id: trace.source_trace_id, name: trace.name })),
    })),
  }
}

export function listNets(input: unknown) {
  const all = elements(input)
  const ports = new Map(all.filter((item) => item.type === "source_port").map((item) => [item.source_port_id, item]))
  return all.filter((item) => item.type === "source_trace").map((trace) => ({
    id: trace.source_trace_id,
    name: trace.name,
    ports: stringArray(trace.connected_source_port_ids),
    connections: stringArray(trace.connected_source_port_ids).map((id) => {
      const port = ports.get(id)
      return port ? { ...port } : { source_port_id: id }
    }),
  }))
}

export function traceNet(input: unknown, net: string) {
  const all = elements(input)
  const matches = all.filter((item) => item.type === "source_trace" && (item.name === net || item.source_trace_id === net))
  if (matches.length === 0) throw new Error(`No Circuit JSON source_trace matches '${net}'`)
  const ports = new Map(all.filter((item) => item.type === "source_port").map((item) => [item.source_port_id, item]))
  const components = new Map(all.filter((item) => item.type === "source_component").map((item) => [item.source_component_id, item]))
  const pcbTraces = all.filter((item) => item.type === "pcb_trace")
  return matches.map((sourceTrace) => {
    const connectedPorts = stringArray(sourceTrace.connected_source_port_ids).map((id) => ports.get(id)).filter((port): port is Element => port !== undefined)
    return {
      sourceTrace,
      connections: connectedPorts.map((port) => ({ port, component: components.get(port.source_component_id) })),
      pcbTraces: pcbTraces.filter((item) => item.source_trace_id === sourceTrace.source_trace_id),
    }
  })
}

export function getPinConnections(input: unknown, component: string) {
  const all = elements(input)
  const components = new Map(all.filter((item) => item.type === "source_component").map((item) => [item.source_component_id, item]))
  const selected = [...components.values()].find((item) => item.source_component_id === component || item.name === component)
  if (!selected) throw new Error(`No Circuit JSON source_component matches '${component}'`)
  const ports = all.filter((item) => item.type === "source_port" && item.source_component_id === selected.source_component_id)
  const traces = all.filter((item) => item.type === "source_trace")
  return ports.map((port) => ({
    ...port,
    connectedNets: traces.filter((trace) => stringArray(trace.connected_source_port_ids).includes(String(port.source_port_id))).map((trace) => trace.name ?? trace.source_trace_id),
  }))
}

export function getBoardProperties(input: unknown) {
  const boards = elements(input).filter((item) => item.type === "pcb_board")
  if (!boards.length) throw new Error("Circuit JSON contains no pcb_board")
  return boards
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}
