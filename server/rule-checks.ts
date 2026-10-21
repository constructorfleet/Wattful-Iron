import { runCircuitDesignChecks, type CircuitDesignIssue } from "./circuit-design-checks.js"

export type RuleCheckReport = {
  status: "pass" | "fail" | "warning" | "not-evaluated"
  categories: string[]
  issues: CircuitDesignIssue[]
  notEvaluated: Array<{ check: string; reason: string }>
}

/** Categories the tscircuit checks assign to electrical findings. */
const electricalCategories = ["netlist", "pin_specification", "source"]
/** Categories the tscircuit checks assign to board findings. */
const designCategories = ["placement", "routing"]

const electricalNotEvaluated = [
  { check: "Voltage domain conflicts", reason: "Only pin-level voltage compatibility declared in Circuit JSON is checked. Domain boundaries are not modeled." },
  { check: "Component rating violations", reason: "Circuit JSON carries no component rating data, and ratings are not fetched from supplier or manufacturer data." },
  { check: "Conflicting outputs", reason: "Pin electrical types are checked only where tscircuit emits them; driver conflict analysis is not implemented." },
  { check: "Power dissipation and current demand", reason: "Requires operating-point values. Use analyze_power, which reports what is derivable from board geometry and marks the rest not evaluated." },
]

const designNotEvaluated = [
  { check: "Fabricator minimum trace width, clearance, and hole size", reason: "Checked against a selected fabricator profile by check_manufacturability, not here." },
  { check: "Footprint compatibility", reason: "Footprints are not compared with manufacturer land patterns." },
  { check: "Layer stackup and copper weight", reason: "Circuit JSON does not describe the fabricated stackup, so copper thickness is assumed rather than checked." },
]

/** Run the supported electrical rule checks on a build's Circuit JSON. */
export async function runElectricalRuleCheck(circuitJson: unknown): Promise<RuleCheckReport> {
  return report(circuitJson, electricalCategories, electricalNotEvaluated)
}

/** Run the supported PCB design rule checks on a build's Circuit JSON. */
export async function runDesignRuleCheck(circuitJson: unknown): Promise<RuleCheckReport> {
  return report(circuitJson, designCategories, designNotEvaluated)
}

/** Run the supported routing checks, including unrouted and discontinuous connections. */
export async function checkRouting(circuitJson: unknown): Promise<RuleCheckReport> {
  return report(circuitJson, ["routing"], [
    { check: "Fabricator routing rules", reason: "Trace width and clearance limits for a chosen fabricator are checked by check_manufacturability." },
    { check: "Impedance and signal integrity", reason: "Not implemented. tscircuit emits no stackup or dielectric data to calculate from." },
  ])
}

async function report(circuitJson: unknown, categories: string[], notEvaluated: RuleCheckReport["notEvaluated"]): Promise<RuleCheckReport> {
  const checked = await runCircuitDesignChecks(circuitJson)
  if (checked.status === "not-evaluated") return { status: "not-evaluated", categories, issues: [], notEvaluated }
  // A failed check run is reported as a warning carrying no category, so keep it visible in every report.
  const issues = checked.issues.filter((issue) => categories.includes(issue.category) || issue.type === "tscircuit_check_execution_warning")
  return {
    status: issues.some(({ severity }) => severity === "error") ? "fail"
      : issues.some(({ severity }) => severity === "warning") ? "warning" : "pass",
    categories,
    issues,
    notEvaluated,
  }
}
