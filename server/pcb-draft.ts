type Item = Record<string, any>

const refPattern = /^[A-Z]+\d+$/

/** Add provisional board, component, port, and pad records to an imported schematic. */
export function withGeneratedPcbDraft(input: unknown): { circuitJson: Item[]; placements: number } {
  if (!Array.isArray(input)) throw new Error("Imported schematic data is unavailable")
  const circuit = input as Item[]
  const components = circuit.filter((item) => item.type === "source_component")
  if (!components.length) throw new Error("No schematic components are available to place")
  if (circuit.some((item) => item.type === "pcb_component")) throw new Error("PCB placements already exist")
  const symbols = circuit.filter((item) => item.type === "schematic_component")
  const labels = circuit.filter((item) => item.type === "schematic_text" && refPattern.test(item.text ?? ""))
  const usedRefs = new Set<string>()
  const placements: Item[] = []
  const ports: Item[] = []
  const pads: Item[] = []
  const refdesBySourceId = new Map<string, string>()
  const columns = Math.max(1, Math.ceil(Math.sqrt(components.length)))
  const rows = Math.ceil(components.length / columns)
  const width = Math.max(20, columns * 6 + 8)
  const height = Math.max(15, rows * 6 + 8)
  const pcbIds = new Map<string, string>()
  components.forEach((component, index) => {
    const id = String(component.source_component_id)
    const symbol = symbols.find((item) => item.source_component_id === id)
    const center = symbol?.center ?? { x: 0, y: 0 }
    const nearest = labels.filter((item) => !usedRefs.has(item.text)).sort((a, b) =>
      Math.hypot(a.position.x - center.x, a.position.y - center.y) - Math.hypot(b.position.x - center.x, b.position.y - center.y))[0]
    const prefix = component.ftype === "simple_resistor" ? "R" : component.ftype === "simple_capacitor" ? "C" : component.ftype === "simple_diode" ? "D" : "U"
    const ref = nearest?.text ?? `${prefix}${index + 1}`
    usedRefs.add(ref)
    refdesBySourceId.set(id, ref)
    const pcbId = `generated_pcb_component_${index}`
    pcbIds.set(id, pcbId)
    const x = (index % columns - (columns - 1) / 2) * 6
    const y = (Math.floor(index / columns) - (rows - 1) / 2) * 6
    const componentPorts = circuit.filter((item) => item.type === "source_port" && item.source_component_id === id)
    const padWidth = componentPorts.length === 2 ? 1.4 : 1.2
    componentPorts.forEach((sourcePort, portIndex) => {
      const angle = (2 * Math.PI * portIndex) / Math.max(componentPorts.length, 2)
      const px = x + Math.cos(angle) * 1.8
      const py = y + Math.sin(angle) * 1.8
      const portId = `${pcbId}_port_${portIndex}`
      ports.push({ type: "pcb_port", pcb_port_id: portId, source_port_id: sourcePort.source_port_id, pcb_component_id: pcbId, x: px, y: py, layers: ["top"] })
      pads.push({ type: "pcb_smtpad", pcb_smtpad_id: `${pcbId}_pad_${portIndex}`, pcb_port_id: portId, pcb_component_id: pcbId, shape: "rect", x: px, y: py, width: padWidth, height: 1.8, layer: "top", port_hints: [String(sourcePort.pin_number ?? sourcePort.name ?? portIndex + 1)] })
    })
    placements.push({ type: "pcb_component", pcb_component_id: pcbId, source_component_id: id, center: { x, y }, width: 4, height: 4, rotation: 0, layer: "top" })
    labels.push({ type: "schematic_text", text: ref, position: center })
  })
  const board = { type: "pcb_board", pcb_board_id: "generated_pcb_board", center: { x: 0, y: 0 }, width, height, thickness: 1.6, num_layers: 2, material: "fr4" }
  const namedCircuit = circuit.map((item) => item.type === "source_component" && refdesBySourceId.has(String(item.source_component_id))
    ? { ...item, name: refdesBySourceId.get(String(item.source_component_id)) }
    : item)
  return { circuitJson: [...namedCircuit, board, ...placements, ...ports, ...pads], placements: placements.length }
}
