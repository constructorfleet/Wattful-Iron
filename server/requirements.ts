import { z } from "zod4"

const requirementSchema = z.object({
  version: z.literal(1),
  project: z.object({ name: z.string().trim().min(1).max(100).optional() }).strict().optional(),
  requirements: z.object({
    board: z.object({
      width_mm: z.number().positive().optional(),
      height_mm: z.number().positive().optional(),
      layers: z.number().int().positive().optional(),
    }).strict().optional(),
    power: z.object({
      input: z.string().trim().min(1).max(100).optional(),
      voltage: z.number().positive().optional(),
      max_current_ma: z.number().positive().optional(),
    }).strict().optional(),
    interfaces: z.array(z.object({ type: z.string().trim().min(1).max(50), count: z.number().int().positive() }).strict()).max(50).optional(),
    manufacturing: z.object({ assembler: z.string().trim().min(1).max(100).optional() }).strict().optional(),
  }).strict(),
}).strict()

export type ProjectRequirements = z.infer<typeof requirementSchema>
export type RequirementCheck = { id: string; status: "pass" | "fail" | "not-evaluated"; message: string }

export function parseRequirements(content: string): ProjectRequirements {
  let value: unknown
  try { value = JSON.parse(content) } catch { throw Object.assign(new Error("Requirements must be valid JSON"), { status: 400 }) }
  const parsed = requirementSchema.safeParse(value)
  if (!parsed.success) throw Object.assign(new Error(`Invalid project requirements: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "document"}: ${issue.message}`).join("; ")}`), { status: 400 })
  return parsed.data
}

export function validateRequirements(requirements: ProjectRequirements, circuitJson: unknown) {
  const checks: RequirementCheck[] = []
  const boardRequirements = requirements.requirements.board
  if (boardRequirements) {
    const boards = records(circuitJson).filter((item) => item.type === "pcb_board")
    for (const [key, expected] of Object.entries(boardRequirements)) {
      if (expected === undefined) continue
      const label = key === "width_mm" ? "board width" : key === "height_mm" ? "board height" : "board layer count"
      const actualKey = key === "width_mm" ? "width" : key === "height_mm" ? "height" : "num_layers"
      if (boards.length === 0) {
        checks.push({ id: `board-${key}`, status: "fail", message: `No PCB board was emitted, so the required ${label} of ${expected} ${key === "layers" ? "layers" : "mm"} is not met.` })
        continue
      }
      const actuals = boards.map((board) => board[actualKey])
      const tolerance = key === "layers" ? 0 : 0.001
      const mismatches = actuals.filter((actual): actual is number => typeof actual === "number").filter((actual) => Math.abs(actual - expected) > tolerance)
      if (mismatches.length > 0) {
        checks.push({ id: `board-${key}`, status: "fail", message: `Required ${label} is ${expected} ${key === "layers" ? "layers" : "mm"}; mismatching emitted value${mismatches.length === 1 ? "" : "s"}: ${mismatches.join(", ")}.` })
      } else if (actuals.every((actual) => typeof actual === "number")) {
        checks.push({ id: `board-${key}`, status: "pass", message: `All ${boards.length} PCB board${boards.length === 1 ? "" : "s"} meet the required ${label} of ${expected} ${key === "layers" ? "layers" : "mm"}.` })
      } else {
        checks.push({ id: `board-${key}`, status: "not-evaluated", message: `The PCB board does not emit ${label}; the requirement could not be fully checked.` })
      }
    }
  }

  const power = requirements.requirements.power
  if (power && Object.keys(power).length) checks.push({ id: "power", status: "not-evaluated", message: "Power requirements are recorded but are not derived from current Circuit JSON output." })
  for (const [index, item] of (requirements.requirements.interfaces ?? []).entries()) {
    checks.push({ id: `interface-${index + 1}`, status: "not-evaluated", message: `${item.type} interface count (${item.count}) is recorded but cannot be verified from current Circuit JSON output.` })
  }
  if (requirements.requirements.manufacturing?.assembler) {
    checks.push({ id: "manufacturing-assembler", status: "not-evaluated", message: `Assembler '${requirements.requirements.manufacturing.assembler}' is recorded but assembler compatibility is not checked.` })
  }
  return { checks, passed: checks.filter(({ status }) => status === "pass").length, failed: checks.filter(({ status }) => status === "fail").length, notEvaluated: checks.filter(({ status }) => status === "not-evaluated").length }
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item)) : []
}
