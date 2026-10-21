import { buildNetTraceIndex } from "./net-trace.js"
import { getSimulationResults } from "./simulation.js"

type Element = Record<string, unknown> & { type?: string }

export type DesignComponentSummary = {
  name: string
  ftype?: string
  value?: string
  manufacturerPartNumber?: string
  footprint?: string
  pinCount: number
}

export type DesignNetSummary = { name: string; pinCount: number; routing: string }

/** What one build produced, kept per revision so two revisions can be compared later. */
export type DesignSummary = {
  revision: string
  createdAt: string
  /** How many findings the supported tscircuit design checks reported for this build. */
  designCheckFindings?: number
  board?: { widthMm?: number; heightMm?: number; layers?: number }
  components: DesignComponentSummary[]
  nets: DesignNetSummary[]
  counts: { components: number; nets: number; pcbTraces: number; vias: number; pads: number; unroutedNets: number }
  simulation: { status: string; signals: number; operatingPoints: number; sweeps: number }
}

export type DesignDiff = {
  available: true
  board: Array<{ property: string; before?: number; after?: number }>
  components: {
    added: DesignComponentSummary[]
    removed: DesignComponentSummary[]
    changed: Array<{ name: string; changes: Array<{ property: string; before?: string | number; after?: string | number }> }>
  }
  nets: {
    added: DesignNetSummary[]
    removed: DesignNetSummary[]
    changed: Array<{ name: string; changes: Array<{ property: string; before?: string | number; after?: string | number }> }>
  }
  counts: Array<{ metric: string; before: number; after: number }>
  designCheckFindings?: { before?: number; after?: number }
  simulation: Array<{ property: string; before: string | number; after: string | number }>
  limitations: string[]
}

export type DesignDiffUnavailable = { available: false; reason: string }

const DIFF_LIMITATIONS = [
  "Compares the design each revision's successful build produced. A revision with no retained build summary cannot be compared.",
  "Component and net changes are matched by name. A renamed component reads as one removal and one addition.",
  "Rendered schematic, PCB, and 3D images are not compared; this is a structural comparison of Circuit JSON.",
]

/** Summarize a build's Circuit JSON into the fields worth comparing between revisions. */
export function summarizeDesign(circuitJson: unknown, revision: string, createdAt = new Date().toISOString(), designCheckFindings?: number): DesignSummary {
  const elements = Array.isArray(circuitJson) ? circuitJson.filter(isElement) : []
  const board = elements.find((element) => element.type === "pcb_board")
  const sourceComponents = elements.filter((element) => element.type === "source_component")
  const ports = elements.filter((element) => element.type === "source_port")
  const pcbComponents = new Map(elements.filter((element) => element.type === "pcb_component")
    .map((element) => [String(element.source_component_id), element]))
  const index = buildNetTraceIndex(elements)
  const simulation = getSimulationResults(elements)

  const components = sourceComponents.map((component): DesignComponentSummary => {
    const id = String(component.source_component_id)
    const placement = pcbComponents.get(id)
    return {
      name: text(component.name) ?? text(component.reference_designator) ?? id,
      ftype: text(component.ftype),
      value: text(component.display_value) ?? text(component.value) ?? displayedValue(component),
      manufacturerPartNumber: text(component.manufacturer_part_number),
      footprint: text(placement?.footprint) ?? text(component.footprint),
      pinCount: ports.filter((port) => port.source_component_id === id).length,
    }
  }).sort((left, right) => left.name.localeCompare(right.name))

  const nets = index.nets.map((net): DesignNetSummary => ({ name: net.name, pinCount: net.pins.length, routing: net.routing }))

  return {
    revision,
    createdAt,
    ...(designCheckFindings === undefined ? {} : { designCheckFindings }),
    ...(board ? {
      board: {
        ...(finite(board.width) === undefined ? {} : { widthMm: finite(board.width) }),
        ...(finite(board.height) === undefined ? {} : { heightMm: finite(board.height) }),
        ...(finite(board.num_layers) === undefined ? {} : { layers: finite(board.num_layers) }),
      },
    } : {}),
    components,
    nets,
    counts: {
      components: components.length,
      nets: nets.length,
      pcbTraces: elements.filter((element) => element.type === "pcb_trace").length,
      vias: elements.filter((element) => element.type === "pcb_via").length,
      pads: elements.filter((element) => element.type === "pcb_smtpad" || element.type === "pcb_plated_hole").length,
      unroutedNets: nets.filter((net) => net.routing === "unrouted" || net.routing === "partially-routed").length,
    },
    simulation: {
      status: simulation.status,
      signals: simulation.signals.length,
      operatingPoints: simulation.operatingPoints.length,
      sweeps: simulation.sweeps.length,
    },
  }
}

/** Compare two build summaries, reporting what changed in the design rather than in the source text. */
export function diffDesignSummaries(before: DesignSummary, after: DesignSummary): DesignDiff {
  const beforeComponents = new Map(before.components.map((component) => [component.name, component]))
  const afterComponents = new Map(after.components.map((component) => [component.name, component]))
  const beforeNets = new Map(before.nets.map((net) => [net.name, net]))
  const afterNets = new Map(after.nets.map((net) => [net.name, net]))

  const componentFields = ["ftype", "value", "manufacturerPartNumber", "footprint", "pinCount"] as const
  const netFields = ["pinCount", "routing"] as const

  return {
    available: true,
    board: (["widthMm", "heightMm", "layers"] as const).flatMap((property) => {
      const first = before.board?.[property]
      const second = after.board?.[property]
      return first === second ? [] : [{ property, ...(first === undefined ? {} : { before: first }), ...(second === undefined ? {} : { after: second }) }]
    }),
    components: {
      added: after.components.filter((component) => !beforeComponents.has(component.name)),
      removed: before.components.filter((component) => !afterComponents.has(component.name)),
      changed: [...afterComponents.values()].flatMap((component) => {
        const previous = beforeComponents.get(component.name)
        if (!previous) return []
        const changes = componentFields.flatMap((property) => previous[property] === component[property]
          ? []
          : [{ property, ...(previous[property] === undefined ? {} : { before: previous[property] }), ...(component[property] === undefined ? {} : { after: component[property] }) }])
        return changes.length ? [{ name: component.name, changes }] : []
      }),
    },
    nets: {
      added: after.nets.filter((net) => !beforeNets.has(net.name)),
      removed: before.nets.filter((net) => !afterNets.has(net.name)),
      changed: [...afterNets.values()].flatMap((net) => {
        const previous = beforeNets.get(net.name)
        if (!previous) return []
        const changes = netFields.flatMap((property) => previous[property] === net[property]
          ? []
          : [{ property, before: previous[property], after: net[property] }])
        return changes.length ? [{ name: net.name, changes }] : []
      }),
    },
    ...(before.designCheckFindings === after.designCheckFindings ? {} : {
      designCheckFindings: {
        ...(before.designCheckFindings === undefined ? {} : { before: before.designCheckFindings }),
        ...(after.designCheckFindings === undefined ? {} : { after: after.designCheckFindings }),
      },
    }),
    counts: (Object.keys(after.counts) as Array<keyof DesignSummary["counts"]>)
      .flatMap((metric) => before.counts[metric] === after.counts[metric] ? [] : [{ metric, before: before.counts[metric], after: after.counts[metric] }]),
    simulation: (Object.keys(after.simulation) as Array<keyof DesignSummary["simulation"]>)
      .flatMap((property) => before.simulation[property] === after.simulation[property]
        ? []
        : [{ property, before: before.simulation[property], after: after.simulation[property] }]),
    limitations: DIFF_LIMITATIONS,
  }
}

/** Build the reason a comparison is unavailable, so callers never show an empty diff as "no changes". */
export function designDiffUnavailable(missing: string[]): DesignDiffUnavailable {
  return {
    available: false,
    reason: `No retained build summary for revision ${missing.join(" and ")}. Build those revisions to compare their designs; summaries are written when a build succeeds.`,
  }
}

function displayedValue(component: Element) {
  for (const key of ["display_resistance", "display_capacitance", "display_inductance", "display_voltage"]) {
    const value = text(component[key])
    if (value) return value
  }
  return undefined
}

function isElement(value: unknown): value is Element {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
function text(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}
function finite(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}
