type JsonElement = Record<string, unknown> & { type?: string }

export type SimulationSignal = {
  id: string
  name: string
  unit: "V" | "A"
  netId?: string
  samples: Array<{ x: number; y: number }>
}

export type SimulationResults = {
  status: "complete" | "failed" | "not_configured"
  experiments: Array<{ id: string; name: string; type: string }>
  signals: SimulationSignal[]
  diagnostics: Array<{ message: string; severity: "error" }>
}

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

  const diagnostics = errorElements.map((element) => ({
    message: `The tscircuit SPICE engine reported an error for experiment ${String(element.simulation_experiment_id ?? "unknown")}.`,
    severity: "error" as const,
  }))
  const status = errorElements.length ? "failed" : experiments.length ? signals.length ? "complete" : "failed" : "not_configured"
  if (experiments.length && !signals.length && !diagnostics.length) {
    diagnostics.push({ message: "Simulation is configured but no waveform results were produced. Check the build diagnostics and supported SPICE models.", severity: "error" })
  }
  return {
    status,
    experiments: experiments.map((experiment) => ({ id: String(experiment.simulation_experiment_id ?? ""), name: String(experiment.name ?? "Simulation"), type: String(experiment.experiment_type ?? "unknown") })),
    signals,
    diagnostics,
  }
}

function isElement(value: unknown): value is JsonElement {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
function finite(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : undefined }
function numberArray(value: unknown): number[] { return Array.isArray(value) ? value.filter((item): item is number => typeof item === "number" && Number.isFinite(item)) : [] }
