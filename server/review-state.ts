/** The design review states a project revision moves through. */
export type ReviewState = "draft" | "validated" | "reviewed" | "manufacturing_approved"

export type ReviewEntry = {
  state: ReviewState
  revision: string
  at: string
  note?: string
  /** Which interface recorded the entry. */
  source: "browser" | "mcp"
  /** The signed-in account that recorded it, when user accounts are enabled. */
  actor?: { id: string; email: string; role: string }
  evidence?: ReviewEvidenceRecord
}

/** What was true about the build when a state was recorded, kept so an approval is auditable. */
export type ReviewEvidenceRecord = {
  buildStatus?: string
  assertions?: { passed: number; failed: number; notEvaluated: number }
  preflightReady?: boolean
  components?: number
  nets?: number
}

export type ReviewStatus = {
  state: ReviewState
  revision: string
  /** The entry that set the current state, absent while a project is still an unrecorded draft. */
  current?: ReviewEntry
  /** Set when an earlier revision reached a further state that this revision's changes invalidated. */
  supersededFrom?: { state: ReviewState; revision: string; at: string }
  locked: boolean
  history: ReviewEntry[]
  allowedTransitions: ReviewState[]
}

/** Evidence a transition is checked against. A missing field blocks the transitions that need it. */
export type ReviewEvidence = {
  buildStatus?: string
  buildRevision?: string
  projectRevision: string
  assertions?: { failed: number; passed: number; notEvaluated: number }
  assertionsConfigured?: boolean
  preflightReady?: boolean
}

const ORDER: ReviewState[] = ["draft", "validated", "reviewed", "manufacturing_approved"]

export const reviewStates = ORDER

/** States an MCP agent may set. Approving for manufacturing, and reopening an approved revision, are left to a person. */
const AGENT_SETTABLE: ReviewState[] = ["validated", "reviewed"]

export function isReviewState(value: unknown): value is ReviewState {
  return typeof value === "string" && (ORDER as string[]).includes(value)
}

/**
 * Resolve the review status for a project's current revision. A state applies only to the
 * revision it was recorded against, so any source change drops the project back to draft
 * and records which state the earlier revision had reached.
 */
export function resolveReviewStatus(history: ReviewEntry[], projectRevision: string): ReviewStatus {
  const ordered = [...history].sort((left, right) => right.at.localeCompare(left.at))
  const current = ordered.find((entry) => entry.revision === projectRevision)
  const state = current?.state ?? "draft"
  const superseded = ordered.find((entry) => entry.revision !== projectRevision && rank(entry.state) > 0)
  return {
    state,
    revision: projectRevision,
    ...(current ? { current } : {}),
    ...(state === "draft" && superseded ? { supersededFrom: { state: superseded.state, revision: superseded.revision, at: superseded.at } } : {}),
    locked: state === "manufacturing_approved",
    history: ordered,
    allowedTransitions: ORDER.filter((target) => target !== state),
  }
}

/**
 * Decide whether a state may be recorded now. Each step forward requires the evidence that
 * justifies it; moving back to draft is always allowed, because reopening a revision for
 * editing must never be blocked.
 */
export function checkReviewTransition(status: ReviewStatus, target: ReviewState, evidence: ReviewEvidence, source: ReviewEntry["source"]) {
  if (target === status.state) return { allowed: false as const, reason: `This revision is already ${label(target)}.` }
  if (source === "mcp" && !AGENT_SETTABLE.includes(target)) {
    return {
      allowed: false as const,
      reason: target === "manufacturing_approved"
        ? "Approving a revision for manufacturing requires a person: it is not available to MCP agents."
        : "Reopening a revision for editing requires a person: it is not available to MCP agents.",
    }
  }
  if (target === "draft") return { allowed: true as const }

  const built = evidence.buildStatus === "ready" && evidence.buildRevision === evidence.projectRevision
  if (!built) return { allowed: false as const, reason: `${label(target)} requires a successful build of the current revision.` }

  if (evidence.assertionsConfigured && (evidence.assertions?.failed ?? 0) > 0) {
    return { allowed: false as const, reason: `${label(target)} requires the project's assertions to pass; ${evidence.assertions?.failed} failed.` }
  }

  if (rank(target) > rank(status.state) + 1) {
    return { allowed: false as const, reason: `${label(target)} comes after ${label(ORDER[rank(target) - 1]!)}; this revision is ${label(status.state)}.` }
  }

  if (target === "manufacturing_approved" && evidence.preflightReady !== true) {
    return { allowed: false as const, reason: "Manufacturing approval requires manufacturing preflight to report ready." }
  }

  return { allowed: true as const }
}

/** The human-readable reason a write is refused while a revision is approved. */
export const APPROVED_WRITE_MESSAGE =
  "This revision is approved for manufacturing and is read-only. Reopen it as a draft in the review panel before editing."

function rank(state: ReviewState) {
  return ORDER.indexOf(state)
}

function label(state: ReviewState) {
  return state === "manufacturing_approved" ? "Manufacturing approved" : state.charAt(0).toUpperCase() + state.slice(1)
}
