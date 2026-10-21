import assert from "node:assert/strict"
import { test } from "node:test"
import { APPROVED_WRITE_MESSAGE, checkReviewTransition, isReviewState, resolveReviewStatus, type ReviewEntry, type ReviewEvidence } from "./review-state.js"

const entry = (state: ReviewEntry["state"], revision: string, at: string, source: ReviewEntry["source"] = "browser"): ReviewEntry =>
  ({ state, revision, at, source })

const evidence = (overrides: Partial<ReviewEvidence> = {}): ReviewEvidence => ({
  projectRevision: "rev-2",
  buildStatus: "ready",
  buildRevision: "rev-2",
  assertionsConfigured: false,
  preflightReady: true,
  ...overrides,
})

test("recognizes only the supported review states", () => {
  for (const state of ["draft", "validated", "reviewed", "manufacturing_approved"]) assert.equal(isReviewState(state), true)
  for (const state of ["approved", "", undefined, 3]) assert.equal(isReviewState(state), false)
})

test("a state applies only to the revision it was recorded against", () => {
  const history = [entry("validated", "rev-1", "2026-10-20T10:00:00.000Z"), entry("reviewed", "rev-1", "2026-10-20T11:00:00.000Z")]
  const sameRevision = resolveReviewStatus(history, "rev-1")
  assert.equal(sameRevision.state, "reviewed")
  assert.equal(sameRevision.locked, false)
  assert.equal(sameRevision.current?.at, "2026-10-20T11:00:00.000Z")

  // Editing the source produces a new revision, which drops back to draft and records why.
  const afterEdit = resolveReviewStatus(history, "rev-2")
  assert.equal(afterEdit.state, "draft")
  assert.deepEqual(afterEdit.supersededFrom, { state: "reviewed", revision: "rev-1", at: "2026-10-20T11:00:00.000Z" })
  assert.equal(afterEdit.history.length, 2)
})

test("an approved revision is locked, and a new revision is not", () => {
  const history = [entry("manufacturing_approved", "rev-1", "2026-10-20T12:00:00.000Z")]
  assert.equal(resolveReviewStatus(history, "rev-1").locked, true)
  assert.equal(resolveReviewStatus(history, "rev-2").locked, false)
  assert.match(APPROVED_WRITE_MESSAGE, /read-only/)
})

test("each step forward requires a successful build of the current revision", () => {
  const draft = resolveReviewStatus([], "rev-2")
  assert.deepEqual(checkReviewTransition(draft, "validated", evidence(), "browser"), { allowed: true })

  const failedBuild = checkReviewTransition(draft, "validated", evidence({ buildStatus: "failed" }), "browser")
  assert.equal(failedBuild.allowed, false)
  assert.match(failedBuild.allowed ? "" : failedBuild.reason, /requires a successful build of the current revision/)

  const staleBuild = checkReviewTransition(draft, "validated", evidence({ buildRevision: "rev-1" }), "browser")
  assert.equal(staleBuild.allowed, false)
})

test("failing assertions block a step forward, and unconfigured assertions do not", () => {
  const draft = resolveReviewStatus([], "rev-2")
  const failing = checkReviewTransition(draft, "validated", evidence({ assertionsConfigured: true, assertions: { failed: 2, passed: 1, notEvaluated: 0 } }), "browser")
  assert.equal(failing.allowed, false)
  assert.match(failing.allowed ? "" : failing.reason, /assertions to pass; 2 failed/)

  const passing = checkReviewTransition(draft, "validated", evidence({ assertionsConfigured: true, assertions: { failed: 0, passed: 3, notEvaluated: 1 } }), "browser")
  assert.equal(passing.allowed, true)

  const unconfigured = checkReviewTransition(draft, "validated", evidence({ assertionsConfigured: false, assertions: { failed: 9, passed: 0, notEvaluated: 0 } }), "browser")
  assert.equal(unconfigured.allowed, true)
})

test("states cannot be skipped, and approval needs preflight to be ready", () => {
  const draft = resolveReviewStatus([], "rev-2")
  const skipped = checkReviewTransition(draft, "manufacturing_approved", evidence(), "browser")
  assert.equal(skipped.allowed, false)
  assert.match(skipped.allowed ? "" : skipped.reason, /comes after Reviewed; this revision is Draft/)

  const reviewed = resolveReviewStatus([entry("validated", "rev-2", "2026-10-20T10:00:00.000Z"), entry("reviewed", "rev-2", "2026-10-20T11:00:00.000Z")], "rev-2")
  assert.deepEqual(checkReviewTransition(reviewed, "manufacturing_approved", evidence(), "browser"), { allowed: true })

  const blockedPreflight = checkReviewTransition(reviewed, "manufacturing_approved", evidence({ preflightReady: false }), "browser")
  assert.equal(blockedPreflight.allowed, false)
  assert.match(blockedPreflight.allowed ? "" : blockedPreflight.reason, /preflight to report ready/)

  const unknownPreflight = checkReviewTransition(reviewed, "manufacturing_approved", { ...evidence(), preflightReady: undefined }, "browser")
  assert.equal(unknownPreflight.allowed, false)
})

test("reopening a revision as a draft is always allowed for a person", () => {
  const approved = resolveReviewStatus([entry("manufacturing_approved", "rev-2", "2026-10-20T12:00:00.000Z")], "rev-2")
  assert.deepEqual(checkReviewTransition(approved, "draft", evidence({ buildStatus: "failed", preflightReady: false }), "browser"), { allowed: true })
  assert.equal(checkReviewTransition(approved, "manufacturing_approved", evidence(), "browser").allowed, false)
})

test("agents may record validation and review, but never approve or reopen", () => {
  const draft = resolveReviewStatus([], "rev-2")
  assert.equal(checkReviewTransition(draft, "validated", evidence(), "mcp").allowed, true)

  const reviewed = resolveReviewStatus([entry("validated", "rev-2", "2026-10-20T10:00:00.000Z"), entry("reviewed", "rev-2", "2026-10-20T11:00:00.000Z")], "rev-2")
  const approval = checkReviewTransition(reviewed, "manufacturing_approved", evidence(), "mcp")
  assert.equal(approval.allowed, false)
  assert.match(approval.allowed ? "" : approval.reason, /requires a person/)

  const approved = resolveReviewStatus([entry("manufacturing_approved", "rev-2", "2026-10-20T12:00:00.000Z")], "rev-2")
  const reopen = checkReviewTransition(approved, "draft", evidence(), "mcp")
  assert.equal(reopen.allowed, false)
  assert.match(reopen.allowed ? "" : reopen.reason, /Reopening a revision for editing requires a person/)
})
