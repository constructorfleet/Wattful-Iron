export type CircuitRecord = Record<string, unknown>

export type InspectedComponent = {
  id: string
  name: string
  properties: Array<[string, unknown]>
  placement?: CircuitRecord
  pins: Array<{ id: string; name: string; connections: string[] }>
}

const isRecord = (value: unknown): value is CircuitRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function getInspectedComponents(circuitJson: unknown): InspectedComponent[] {
  if (!Array.isArray(circuitJson)) return []
  const records = circuitJson.filter(isRecord)
  const sourceComponents = records.filter((item) => item.type === 'source_component' && typeof item.source_component_id === 'string')

  return sourceComponents.map((component) => {
    const id = component.source_component_id as string
    const ports = records.filter((item) => item.type === 'source_port' && item.source_component_id === id)
    const traces = records.filter((item) => item.type === 'source_trace')
    const properties = Object.entries(component).filter(([key, value]) =>
      !['type', 'source_component_id', 'name'].includes(key) && value !== undefined && value !== null,
    )
    return {
      id,
      name: typeof component.name === 'string' && component.name ? component.name : id,
      properties,
      placement: records.find((item) => item.type === 'pcb_component' && item.source_component_id === id),
      pins: ports.map((port) => {
        const pinId = typeof port.source_port_id === 'string' ? port.source_port_id : ''
        const matches = traces.filter((trace) => Array.isArray(trace.connected_source_port_ids) && trace.connected_source_port_ids.includes(pinId))
        return {
          id: pinId,
          name: typeof port.name === 'string' ? port.name : typeof port.pin_number === 'number' ? `Pin ${port.pin_number}` : pinId || 'Unnamed pin',
          connections: matches.map((trace) => typeof trace.name === 'string' && trace.name ? trace.name : String(trace.source_trace_id ?? 'Unnamed net')),
        }
      }),
    }
  })
}
