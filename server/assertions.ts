import { z } from "zod4"
import { buildNetTraceIndex } from "./net-trace.js"
import { getSimulationResults } from "./simulation.js"
import type { PowerAnalysis } from "./power-analysis.js"
import type { BomCostEstimate } from "./component-sourcing.js"
import type { DesignSummary } from "./design-summary.js"

const names = (max: number) => z.array(z.string().trim().min(1).max(100)).max(max)
  .refine((items) => new Set(items).size === items.length, "must not contain duplicates")

const assertionSchema = z.object({
  version: z.literal(1),
  assertions: z.object({
    nets_connected: names(100).optional(),
    components_present: names(200).optional(),
    max_supply_current_a: z.number().positive().optional(),
    max_dissipation_w: z.number().positive().optional(),
    design_check_findings_must_not_increase: z.boolean().optional(),
    max_component_cost_usd: z.number().positive().optional(),
    cost_board_quantity: z.number().int().min(1).max(10000).optional(),
    simulation: z.array(z.object({
      signal: z.string().trim().min(1).max(100),
      min: z.number().optional(),
      max: z.number().optional(),
    }).strict().refine((item) => item.min !== undefined || item.max !== undefined, "needs a min, a max, or both"))
      .max(50).optional(),
  }).strict(),
}).strict()

export type ProjectAssertions = z.infer<typeof assertionSchema>
export type AssertionResult = { id: string; status: "pass" | "fail" | "not-evaluated"; message: string }
export type AssertionReport = {
  results: AssertionResult[]
  passed: number
  failed: number
  notEvaluated: number
  baselineRevision?: string
}

/** Everything an assertion run may need. Each input is optional; a missing one makes the assertions that depend on it not evaluated rather than passing. */
export type AssertionEvidence = {
  circuitJson: unknown
  designCheckFindings?: number
  baseline?: DesignSummary
  power?: PowerAnalysis
  bomCost?: BomCostEstimate
  sourcingConfigured?: boolean
}

export function parseAssertions(content: string): ProjectAssertions {
  let value: unknown
  try { value = JSON.parse(content) } catch { throw Object.assign(new Error("Assertions must be valid JSON"), { status: 400 }) }
  const parsed = assertionSchema.safeParse(value)
  if (!parsed.success) throw Object.assign(new Error(`Invalid project assertions: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "document"}: ${issue.message}`).join("; ")}`), { status: 400 })
  return parsed.data
}

/**
 * Check a project's assertions against the evidence a build produced. An assertion only
 * passes or fails on evidence that is actually present; anything else is reported as not
 * evaluated with the reason, so a green run is never inferred from missing data.
 */
export function evaluateAssertions(document: ProjectAssertions, evidence: AssertionEvidence): AssertionReport {
  const assertions = document.assertions
  const results: AssertionResult[] = []
  const hasCircuit = Array.isArray(evidence.circuitJson) && evidence.circuitJson.length > 0
  const index = hasCircuit ? buildNetTraceIndex(evidence.circuitJson) : undefined

  for (const name of assertions.nets_connected ?? []) {
    const id = `net-connected-${name}`
    if (!index) {
      results.push({ id, status: "not-evaluated", message: `Net '${name}' could not be checked because this project has no successful build to read.` })
      continue
    }
    const net = index.nets.find((item) => item.name === name || item.names.includes(name))
    if (!net) {
      results.push({ id, status: "fail", message: `Net '${name}' is not present in the latest successful build.` })
      continue
    }
    if (net.pins.length < 2) {
      results.push({ id, status: "fail", message: `Net '${name}' reaches only ${net.pins.length} component pin${net.pins.length === 1 ? "" : "s"}; a connection needs at least two.` })
      continue
    }
    results.push({
      id,
      status: "pass",
      message: `Net '${name}' connects ${net.pins.length} component pins (${net.pins.map((pin) => `${pin.componentName ?? "?"}.${pin.pinName}`).join(", ")}); copper routing is ${net.routing}.`,
    })
  }

  for (const reference of assertions.components_present ?? []) {
    const id = `component-present-${reference}`
    if (!hasCircuit) {
      results.push({ id, status: "not-evaluated", message: `Component '${reference}' could not be checked because this project has no successful build to read.` })
      continue
    }
    const present = (evidence.circuitJson as unknown[]).some((item) => isRecord(item) && item.type === "source_component"
      && (item.name === reference || item.reference_designator === reference))
    results.push(present
      ? { id, status: "pass", message: `Component '${reference}' is present in the latest successful build.` }
      : { id, status: "fail", message: `Component '${reference}' is missing from the latest successful build.` })
  }

  if (assertions.max_supply_current_a !== undefined) {
    const limit = assertions.max_supply_current_a
    const actual = evidence.power?.totalSupplyCurrentA
    results.push(actual === undefined
      ? { id: "max-supply-current", status: "not-evaluated", message: `Supply current limit of ${limit} A could not be checked: no supply branch current was emitted. Add a current probe on the power source and run a DC operating point.` }
      : actual > limit
        ? { id: "max-supply-current", status: "fail", message: `Supply current is ${actual} A, above the limit of ${limit} A.` }
        : { id: "max-supply-current", status: "pass", message: `Supply current is ${actual} A, within the limit of ${limit} A.` })
  }

  if (assertions.max_dissipation_w !== undefined) {
    const limit = assertions.max_dissipation_w
    const actual = evidence.power?.totalDissipationW
    results.push(actual === undefined
      ? { id: "max-dissipation", status: "not-evaluated", message: `Dissipation limit of ${limit} W could not be checked: no component dissipation was calculable. A DC operating point and a declared resistance are needed.` }
      : actual > limit
        ? { id: "max-dissipation", status: "fail", message: `Calculated dissipation is ${actual} W, above the limit of ${limit} W. This covers only components whose dissipation could be calculated.` }
        : { id: "max-dissipation", status: "pass", message: `Calculated dissipation is ${actual} W, within the limit of ${limit} W. This covers only components whose dissipation could be calculated.` })
  }

  if (assertions.design_check_findings_must_not_increase) {
    const current = evidence.designCheckFindings
    const previous = evidence.baseline?.designCheckFindings
    results.push(current === undefined
      ? { id: "design-check-findings", status: "not-evaluated", message: "Design check findings could not be counted for the current build." }
      : previous === undefined
        ? { id: "design-check-findings", status: "not-evaluated", message: `The current build has ${current} design check finding${current === 1 ? "" : "s"}, but no earlier build summary is retained to compare with.` }
        : current > previous
          ? { id: "design-check-findings", status: "fail", message: `Design check findings rose from ${previous} to ${current} since revision ${evidence.baseline?.revision}.` }
          : { id: "design-check-findings", status: "pass", message: `Design check findings went from ${previous} to ${current} since revision ${evidence.baseline?.revision}.` })
  }

  if (assertions.max_component_cost_usd !== undefined) {
    const limit = assertions.max_component_cost_usd
    const cost = evidence.bomCost
    const boards = assertions.cost_board_quantity ?? 1
    if (!evidence.sourcingConfigured || !cost) {
      results.push({ id: "max-component-cost", status: "not-evaluated", message: `Component cost budget of $${limit} could not be checked: no component sourcing provider is configured. Set COMPONENT_SOURCING_URL to enable it.` })
    } else if (cost.componentCostUsd === undefined) {
      results.push({ id: "max-component-cost", status: "not-evaluated", message: `Component cost budget of $${limit} could not be checked: no part in this build could be priced.` })
    } else if (cost.componentCostUsd > limit) {
      results.push({ id: "max-component-cost", status: "fail", message: `Component cost for ${cost.boards} board${cost.boards === 1 ? "" : "s"} is $${cost.componentCostUsd}, above the budget of $${limit}.` })
    } else if (cost.unpriced.length > 0) {
      results.push({ id: "max-component-cost", status: "not-evaluated", message: `The priced subtotal for ${cost.boards} board${cost.boards === 1 ? "" : "s"} is $${cost.componentCostUsd}, within the budget of $${limit}, but ${cost.unpriced.length} part${cost.unpriced.length === 1 ? "" : "s"} could not be priced: ${cost.unpriced.map(({ name }) => name).join(", ")}.` })
    } else {
      results.push({ id: "max-component-cost", status: "pass", message: `Component cost for ${cost.boards} board${cost.boards === 1 ? "" : "s"} is $${cost.componentCostUsd}, within the budget of $${limit}.` })
    }
    if (cost && cost.boards !== boards) {
      results.push({ id: "max-component-cost-quantity", status: "not-evaluated", message: `The cost estimate was priced for ${cost.boards} board${cost.boards === 1 ? "" : "s"} rather than the asserted quantity of ${boards}.` })
    }
  }

  const simulation = assertions.simulation ?? []
  if (simulation.length > 0) {
    const results_ = hasCircuit ? getSimulationResults(evidence.circuitJson) : undefined
    for (const item of simulation) {
      const id = `simulation-${item.signal}`
      const range = `${item.min === undefined ? "-inf" : item.min} to ${item.max === undefined ? "+inf" : item.max}`
      if (!results_) {
        results.push({ id, status: "not-evaluated", message: `Signal '${item.signal}' could not be checked because this project has no successful build to read.` })
        continue
      }
      const operatingPoint = results_.operatingPoints.find((point) => point.name === item.signal)
      if (operatingPoint) {
        const within = inRange(operatingPoint.value, item.min, item.max)
        results.push({
          id,
          status: within ? "pass" : "fail",
          message: `Operating point '${item.signal}' is ${operatingPoint.value} ${operatingPoint.unit}, ${within ? "within" : "outside"} the asserted range ${range}.`,
        })
        continue
      }
      const signal = results_.signals.find((candidate) => candidate.name === item.signal)
      if (!signal || signal.samples.length === 0) {
        results.push({ id, status: "not-evaluated", message: `Signal '${item.signal}' produced no operating-point value or waveform in this build, so the asserted range ${range} could not be checked.` })
        continue
      }
      const values = signal.samples.map(({ y }) => y)
      const lowest = Math.min(...values)
      const highest = Math.max(...values)
      const within = inRange(lowest, item.min, item.max) && inRange(highest, item.min, item.max)
      results.push({
        id,
        status: within ? "pass" : "fail",
        message: `Waveform '${item.signal}' spans ${lowest} to ${highest} ${signal.unit} over ${signal.samples.length} samples, ${within ? "within" : "outside"} the asserted range ${range}.`,
      })
    }
  }

  return {
    results,
    passed: results.filter(({ status }) => status === "pass").length,
    failed: results.filter(({ status }) => status === "fail").length,
    notEvaluated: results.filter(({ status }) => status === "not-evaluated").length,
    ...(evidence.baseline ? { baselineRevision: evidence.baseline.revision } : {}),
  }
}

function inRange(value: number, min?: number, max?: number) {
  return (min === undefined || value >= min) && (max === undefined || value <= max)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
