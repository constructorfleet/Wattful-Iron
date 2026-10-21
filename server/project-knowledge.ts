import { z } from "zod4"

const line = z.string().trim().min(1).max(2000)
const list = (max: number) => z.array(line).max(max)

const knowledgeSchema = z.object({
  version: z.literal(1),
  knowledge: z.object({
    summary: line.optional(),
    functional_requirements: list(100).optional(),
    electrical_assumptions: list(100).optional(),
    design_decisions: z.array(z.object({
      decision: line,
      rationale: line.optional(),
      date: z.string().trim().max(40).optional(),
      supersedes: line.optional(),
    }).strict()).max(200).optional(),
    mechanical_constraints: list(100).optional(),
    manufacturing_preferences: z.object({
      fabricator: z.string().trim().max(100).optional(),
      assembler: z.string().trim().max(100).optional(),
      notes: list(50).optional(),
    }).strict().optional(),
    known_issues: z.array(z.object({
      issue: line,
      severity: z.enum(["low", "medium", "high"]).optional(),
      workaround: line.optional(),
    }).strict()).max(200).optional(),
    pending_decisions: z.array(z.object({
      question: line,
      options: list(20).optional(),
      owner: z.string().trim().max(100).optional(),
    }).strict()).max(200).optional(),
  }).strict(),
}).strict()

export type ProjectKnowledge = z.infer<typeof knowledgeSchema>

/** Sections an agent should expect, so an empty document reads as empty rather than missing. */
export const knowledgeSections = [
  "summary",
  "functional_requirements",
  "electrical_assumptions",
  "design_decisions",
  "mechanical_constraints",
  "manufacturing_preferences",
  "known_issues",
  "pending_decisions",
] as const

const LIMITATIONS = [
  "This document is written by people and agents, not derived from the design. Nothing here is checked against Circuit JSON.",
  "Manufacturing preferences recorded here are not applied to builds, preflight, or exports. Set the fabricator profile for checks and COMPONENT_SOURCING_URL for supplier data.",
  "Requirements that should be checked belong in requirements.json, and regressions that should be checked belong in assertions.json.",
]

export function parseProjectKnowledge(content: string): ProjectKnowledge {
  let value: unknown
  try { value = JSON.parse(content) } catch { throw Object.assign(new Error("Project knowledge must be valid JSON"), { status: 400 }) }
  const parsed = knowledgeSchema.safeParse(value)
  if (!parsed.success) {
    throw Object.assign(new Error(`Invalid project knowledge: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "document"}: ${issue.message}`).join("; ")}`), { status: 400 })
  }
  return parsed.data
}

/** Summarize which sections carry content, so a reader can see what the project documents. */
export function describeProjectKnowledge(document: ProjectKnowledge) {
  const knowledge = document.knowledge as Record<string, unknown>
  const populated = knowledgeSections.filter((section) => {
    const value = knowledge[section]
    if (Array.isArray(value)) return value.length > 0
    if (value && typeof value === "object") return Object.keys(value).length > 0
    return typeof value === "string" && value.length > 0
  })
  return {
    sections: [...knowledgeSections],
    populatedSections: populated,
    emptySections: knowledgeSections.filter((section) => !populated.includes(section)),
    openQuestions: document.knowledge.pending_decisions?.length ?? 0,
    knownIssues: document.knowledge.known_issues?.length ?? 0,
    limitations: LIMITATIONS,
  }
}

export const knowledgeLimitations = LIMITATIONS
