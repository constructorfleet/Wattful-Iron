import { runCircuitDesignChecks, type CircuitDesignIssue } from "./circuit-design-checks.js"
import {
  designCoverage,
  designNotEvaluated,
  electricalCoverage,
  electricalNotEvaluated,
  routingCoverage,
  routingNotEvaluated,
  type CheckCoverage,
} from "./check-coverage.js"

export type RuleCheckReport = {
  status: "pass" | "fail" | "warning" | "not-evaluated"
  categories: string[]
  issues: CircuitDesignIssue[]
  /** The checks this report covers, so a pass says what it actually proves. */
  coverage: CheckCoverage[]
  notEvaluated: Array<{ check: string; reason: string }>
}

/** Categories the tscircuit checks assign to electrical findings. */
const electricalCategories = ["netlist", "pin_specification", "source"]
/** Categories the tscircuit checks assign to board findings. */
const designCategories = ["placement", "routing"]

/** Run the supported electrical rule checks on a build's Circuit JSON. */
export async function runElectricalRuleCheck(circuitJson: unknown): Promise<RuleCheckReport> {
  return report(circuitJson, electricalCategories, electricalCoverage, electricalNotEvaluated)
}

/** Run the supported PCB design rule checks on a build's Circuit JSON. */
export async function runDesignRuleCheck(circuitJson: unknown): Promise<RuleCheckReport> {
  return report(circuitJson, designCategories, designCoverage, designNotEvaluated)
}

/** Run the supported routing checks, including unrouted and discontinuous connections. */
export async function checkRouting(circuitJson: unknown): Promise<RuleCheckReport> {
  return report(circuitJson, ["routing"], routingCoverage, routingNotEvaluated)
}

async function report(circuitJson: unknown, categories: string[], coverage: CheckCoverage[], notEvaluated: RuleCheckReport["notEvaluated"]): Promise<RuleCheckReport> {
  const checked = await runCircuitDesignChecks(circuitJson)
  if (checked.status === "not-evaluated") return { status: "not-evaluated", categories, issues: [], coverage, notEvaluated }
  // A failed check run is reported as a warning carrying no category, so keep it visible in every report.
  const issues = checked.issues.filter((issue) => categories.includes(issue.category) || issue.type === "tscircuit_check_execution_warning")
  return {
    status: issues.some(({ severity }) => severity === "error") ? "fail"
      : issues.some(({ severity }) => severity === "warning") ? "warning" : "pass",
    categories,
    issues,
    coverage,
    notEvaluated,
  }
}
