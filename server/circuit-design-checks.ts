import { runAllChecks } from "@tscircuit/checks"
import { categorizeErrorOrWarning } from "@tscircuit/circuit-json-util"

export type CircuitDesignIssue = {
  severity: "error" | "warning"
  type: string
  category: string
  message: string
  affectedIds: string[]
}

export type CircuitDesignCheckResult = {
  status: "pass" | "fail" | "warning" | "not-evaluated"
  issues: CircuitDesignIssue[]
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null
const affectedIdFields = ["source_component_id", "source_port_id", "source_trace_id", "pcb_board_id", "pcb_component_id", "pcb_trace_id", "pcb_port_id", "pcb_smtpad_id", "pcb_hole_id"]

/** Run tscircuit's supported Circuit JSON netlist, pin, schematic, placement, and routing checks. */
export async function runCircuitDesignChecks(circuitJson: unknown): Promise<CircuitDesignCheckResult> {
  const elements = Array.isArray(circuitJson) ? circuitJson.filter(isRecord) : []
  if (!elements.some((element) => typeof element.type === "string" && /^(source|pcb|schematic)_/.test(element.type))) {
    return { status: "not-evaluated", issues: [] }
  }

  let checked: Awaited<ReturnType<typeof runAllChecks>>
  try {
    checked = await runAllChecks(elements as Parameters<typeof runAllChecks>[0])
  } catch (error) {
    return {
      status: "warning",
      issues: [{
        severity: "warning",
        type: "tscircuit_check_execution_warning",
        category: "other",
        message: `The tscircuit design checks could not evaluate this Circuit JSON: ${error instanceof Error ? error.message : String(error)}`,
        affectedIds: [],
      }],
    }
  }
  const issues = checked.filter(isRecord).map((value): CircuitDesignIssue => {
    const issue = value as unknown as Record<string, unknown>
    const type = typeof issue.error_type === "string" ? issue.error_type
      : typeof issue.warning_type === "string" ? issue.warning_type
        : typeof issue.type === "string" ? issue.type : "unknown_design_check"
    const severity = type.endsWith("_warning") || issue.warning_type ? "warning" : "error"
    let category = "other"
    try { category = categorizeErrorOrWarning({ ...issue, type, error_type: typeof issue.error_type === "string" ? issue.error_type : type }) }
    catch { /* Keep a usable finding if an upstream record is not recognized by the categorizer. */ }
    const affectedIds = affectedIdFields.flatMap((field) => typeof issue[field] === "string" ? [issue[field] as string] : [])
    return { severity, type, category, message: typeof issue.message === "string" ? issue.message : type, affectedIds }
  })

  return {
    status: issues.some(({ severity }) => severity === "error") ? "fail"
      : issues.some(({ severity }) => severity === "warning") ? "warning" : "pass",
    issues,
  }
}
