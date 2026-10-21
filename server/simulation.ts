type JsonElement = Record<string, unknown> & { type?: string }

export type SimulationSignal = {
  id: string
  name: string
  unit: "V" | "A"
  netId?: string
  samples: Array<{ x: number; y: number }>
}

/** One DC operating-point value emitted for a probe, in volts or amps. */
export type SimulationOperatingPoint = {
  id: string
  name: string
  unit: "V" | "A"
  value: number
  netId?: string
  sourceComponentId?: string
  experimentId?: string
}

export type SimulationSweepPoint = { x: number; y: number }

/** A DC or AC sweep result. AC sweeps also carry magnitude in dB and phase in degrees. */
export type SimulationSweep = {
  id: string
  name: string
  kind: "dc" | "ac"
  unit: "V" | "A"
  xLabel: string
  netId?: string
  samples: SimulationSweepPoint[]
  magnitudeDb?: SimulationSweepPoint[]
  phaseDeg?: SimulationSweepPoint[]
}

export type SimulationAnalysis = { type: string; experiments: number; resultCount: number }

export type SimulationResults = {
  status: "complete" | "failed" | "not_configured"
  experiments: Array<{ id: string; name: string; type: string }>
  signals: SimulationSignal[]
  operatingPoints: SimulationOperatingPoint[]
  sweeps: SimulationSweep[]
  analyses: SimulationAnalysis[]
  diagnostics: Array<{ message: string; severity: "error" }>
  notEvaluated: Array<{ analysis: string; reason: string }>
}

/** Analysis modes tscircuit emits Circuit JSON results for, with the elements that carry them. */
const SUPPORTED_ANALYSES = [
  { type: "spice_transient_analysis", label: "Transient analysis", element: "simulation_transient_voltage_graph or simulation_transient_current_graph" },
  { type: "spice_dc_operating_point", label: "DC operating point", element: "simulation_dc_operating_point_voltage or simulation_dc_operating_point_current" },
  { type: "spice_dc_sweep", label: "DC sweep", element: "simulation_dc_sweep_voltage_graph or simulation_dc_sweep_current_graph" },
  { type: "spice_ac_analysis", label: "AC analysis", element: "simulation_ac_sweep_voltage_graph or simulation_ac_sweep_current_graph" },
] as const

/** Analysis modes the workbench cannot report at all, because nothing emits them. */
const UNSUPPORTED_ANALYSES = [
  { analysis: "Temperature sweep", reason: "tscircuit emits no temperature-sweep elements in Circuit JSON, so temperature variation is not evaluated." },
  { analysis: "Monte Carlo tolerance analysis", reason: "tscircuit emits no Monte Carlo elements in Circuit JSON. Component tolerance spread is not evaluated." },
  { analysis: "Digital and mixed-signal simulation", reason: "Not integrated. SPICE results cannot stand in for firmware or digital logic behavior." },
]

export function getSimulationResults(input: unknown): SimulationResults {
  const elements = Array.isArray(input) ? input.filter(isElement) : []
  const experiments = elements.filter((element) => element.type === "simulation_experiment")
  const probes = new Map(elements.filter((element) => element.type === "simulation_voltage_probe" || element.type === "simulation_current_probe")
    .map((element) => [String(element.simulation_voltage_probe_id ?? element.simulation_current_probe_id), element]))
  const traces = new Map(elements.filter((element) => element.type === "simulation_oscilloscope_trace")
    .flatMap((element) => {
      const graphId = element.simulation_transient_voltage_graph_id ?? element.simulation_transient_current_graph_id
      const probeId = element.simulation_voltage_probe_id ?? element.simulation_current_probe_id
      return typeof graphId === "string" && typeof probeId === "string" ? [[graphId, probeId] as const] : []
    }))
  const errorElements = elements.filter((element) => element.type === "simulation_unknown_experiment_error")
  const signals: SimulationSignal[] = []

  for (const graph of elements) {
    const voltage = graph.type === "simulation_transient_voltage_graph"
    const current = graph.type === "simulation_transient_current_graph"
    if (!voltage && !current) continue
    const graphId = String(graph.simulation_transient_voltage_graph_id ?? graph.simulation_transient_current_graph_id ?? "")
    const probeId = String(traces.get(graphId) ?? graph.simulation_voltage_probe_id ?? graph.simulation_current_probe_id ?? "")
    const probe = probes.get(probeId)
    const ys = numberArray(graph.voltage_levels ?? graph.current_levels)
    const xs = numberArray(graph.timestamps_ms)
    const start = finite(graph.start_time_ms) ?? 0
    const step = finite(graph.time_per_step) ?? 0
    signals.push({
      id: String(graph.simulation_transient_voltage_graph_id ?? graph.simulation_transient_current_graph_id ?? `signal-${signals.length}`),
      name: String(probe?.name ?? graph.name ?? (voltage ? `Voltage ${signals.length + 1}` : `Current ${signals.length + 1}`)),
      unit: voltage ? "V" : "A",
      netId: typeof probe?.signal_input_source_net_id === "string" ? probe.signal_input_source_net_id : undefined,
      samples: ys.map((y, index) => ({ x: xs[index] ?? start + index * step, y })),
    })
  }

  const operatingPoints = readOperatingPoints(elements, probes)
  const sweeps = [...readDcSweeps(elements, probes), ...readAcSweeps(elements, probes)]
  const analyses = readAnalyses(elements, experiments)
  const resultCount = signals.length + operatingPoints.length + sweeps.length

  const diagnostics = errorElements.map((element) => ({
    message: `The tscircuit SPICE engine reported an error for experiment ${String(element.simulation_experiment_id ?? "unknown")}.`,
    severity: "error" as const,
  }))
  const status = errorElements.length ? "failed" : experiments.length ? resultCount ? "complete" : "failed" : "not_configured"
  if (experiments.length && !resultCount && !diagnostics.length) {
    diagnostics.push({ message: "Simulation is configured but no waveform, operating-point, or sweep results were produced. Check the build diagnostics and supported SPICE models.", severity: "error" })
  }

  return {
    status,
    experiments: experiments.map((experiment) => ({ id: String(experiment.simulation_experiment_id ?? ""), name: String(experiment.name ?? "Simulation"), type: String(experiment.experiment_type ?? "unknown") })),
    signals,
    operatingPoints,
    sweeps,
    analyses,
    diagnostics,
    notEvaluated: [
      ...SUPPORTED_ANALYSES
        .filter(({ type }) => !analyses.some((analysis) => analysis.type === type && analysis.resultCount > 0))
        .map(({ label, element }) => ({ analysis: label, reason: `This build emitted no ${element} elements. Configure that analysis in the circuit source to read its results.` })),
      ...UNSUPPORTED_ANALYSES,
    ],
  }
}

/** Read DC operating-point node voltages and branch currents emitted for probes. */
function readOperatingPoints(elements: JsonElement[], probes: Map<string, JsonElement>): SimulationOperatingPoint[] {
  return elements.flatMap((element, index) => {
    const voltage = element.type === "simulation_dc_operating_point_voltage"
    const current = element.type === "simulation_dc_operating_point_current"
    if (!voltage && !current) return []
    const value = finite(voltage ? element.voltage : element.current)
    if (value === undefined) return []
    const probe = probes.get(String(element.simulation_voltage_probe_id ?? element.simulation_current_probe_id ?? ""))
    return [{
      id: String(element.simulation_dc_operating_point_voltage_id ?? element.simulation_dc_operating_point_current_id ?? `operating-point-${index}`),
      name: String(element.name ?? probe?.name ?? (voltage ? `Node voltage ${index + 1}` : `Branch current ${index + 1}`)),
      unit: voltage ? "V" as const : "A" as const,
      value,
      netId: probeNetId(probe, voltage),
      sourceComponentId: typeof probe?.source_component_id === "string" ? probe.source_component_id : undefined,
      experimentId: typeof element.simulation_experiment_id === "string" ? element.simulation_experiment_id : undefined,
    }]
  })
}

/** Read DC sweep graphs, keeping the swept value as the x axis. */
function readDcSweeps(elements: JsonElement[], probes: Map<string, JsonElement>): SimulationSweep[] {
  return elements.flatMap((element, index): SimulationSweep[] => {
    const voltage = element.type === "simulation_dc_sweep_voltage_graph"
    const current = element.type === "simulation_dc_sweep_current_graph"
    if (!voltage && !current) return []
    const xs = numberArray(element.sweep_values)
    const ys = numberArray(voltage ? element.voltage_levels : element.current_levels)
    if (!xs.length || !ys.length) return []
    const probe = probes.get(String(element.simulation_voltage_probe_id ?? element.simulation_current_probe_id ?? ""))
    const sweepUnit = typeof element.sweep_unit === "string" ? element.sweep_unit : "V"
    return [{
      id: String(element.simulation_dc_sweep_voltage_graph_id ?? element.simulation_dc_sweep_current_graph_id ?? `dc-sweep-${index}`),
      name: String(element.name ?? probe?.name ?? `DC sweep ${index + 1}`),
      kind: "dc",
      unit: voltage ? "V" : "A",
      xLabel: `Sweep (${sweepUnit})`,
      netId: probeNetId(probe, voltage),
      samples: ys.map((y, sample) => ({ x: xs[sample] ?? sample, y })),
    }]
  })
}

/** Read AC sweep graphs, reporting magnitude, magnitude in dB, and phase in degrees. */
function readAcSweeps(elements: JsonElement[], probes: Map<string, JsonElement>): SimulationSweep[] {
  return elements.flatMap((element, index): SimulationSweep[] => {
    const voltage = element.type === "simulation_ac_sweep_voltage_graph"
    const current = element.type === "simulation_ac_sweep_current_graph"
    if (!voltage && !current) return []
    const frequencies = numberArray(element.frequencies_hz)
    const complex = Array.isArray(voltage ? element.complex_voltages : element.complex_currents)
      ? (voltage ? element.complex_voltages : element.complex_currents) as unknown[]
      : []
    const samples: SimulationSweepPoint[] = []
    const magnitudeDb: SimulationSweepPoint[] = []
    const phaseDeg: SimulationSweepPoint[] = []
    complex.forEach((sample, sampleIndex) => {
      if (!isElement(sample)) return
      const re = finite(sample.re)
      const im = finite(sample.im)
      if (re === undefined || im === undefined) return
      const frequency = frequencies[sampleIndex] ?? sampleIndex
      const magnitude = Math.hypot(re, im)
      samples.push({ x: frequency, y: magnitude })
      magnitudeDb.push({ x: frequency, y: magnitude > 0 ? round(20 * Math.log10(magnitude)) : Number.NEGATIVE_INFINITY })
      phaseDeg.push({ x: frequency, y: round(Math.atan2(im, re) * 180 / Math.PI) })
    })
    if (!samples.length) return []
    const probe = probes.get(String(element.simulation_voltage_probe_id ?? element.simulation_current_probe_id ?? ""))
    return [{
      id: String(element.simulation_ac_sweep_voltage_graph_id ?? element.simulation_ac_sweep_current_graph_id ?? `ac-sweep-${index}`),
      name: String(element.name ?? probe?.name ?? `AC sweep ${index + 1}`),
      kind: "ac",
      unit: voltage ? "V" : "A",
      xLabel: "Frequency (Hz)",
      netId: probeNetId(probe, voltage),
      samples,
      magnitudeDb,
      phaseDeg,
    }]
  })
}

/** Count the experiments and results present for each analysis mode in this build. */
function readAnalyses(elements: JsonElement[], experiments: JsonElement[]): SimulationAnalysis[] {
  const resultTypes: Record<string, string[]> = {
    spice_transient_analysis: ["simulation_transient_voltage_graph", "simulation_transient_current_graph"],
    spice_dc_operating_point: ["simulation_dc_operating_point_voltage", "simulation_dc_operating_point_current"],
    spice_dc_sweep: ["simulation_dc_sweep_voltage_graph", "simulation_dc_sweep_current_graph"],
    spice_ac_analysis: ["simulation_ac_sweep_voltage_graph", "simulation_ac_sweep_current_graph"],
  }
  return SUPPORTED_ANALYSES.map(({ type }) => ({
    type,
    experiments: experiments.filter((experiment) => experiment.experiment_type === type).length,
    resultCount: elements.filter((element) => resultTypes[type]?.includes(String(element.type))).length,
  }))
}

function probeNetId(probe: JsonElement | undefined, voltage: boolean) {
  const value = voltage ? probe?.signal_input_source_net_id : probe?.positive_source_net_id ?? probe?.negative_source_net_id
  return typeof value === "string" ? value : undefined
}

function isElement(value: unknown): value is JsonElement {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
function finite(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : undefined }
function round(value: number) { return Math.round(value * 1000) / 1000 }
function numberArray(value: unknown): number[] { return Array.isArray(value) ? value.filter((item): item is number => typeof item === "number" && Number.isFinite(item)) : [] }
