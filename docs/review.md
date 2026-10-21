# Design review states

Each project revision moves through four review states:

`draft → validated → reviewed → manufacturing_approved`

A state applies **only to the revision it was recorded against**. Editing the source
produces a new revision, which starts as a draft and records which state the previous
revision had reached, so an approval can never silently carry over to changed source.

## What each step requires

| Target state | Requires |
| --- | --- |
| `validated` | a successful build of the current revision, and no failing project [assertions](assertions.md) |
| `reviewed` | the same, from `validated` |
| `manufacturing_approved` | the same, from `reviewed`, plus manufacturing preflight reporting ready |
| `draft` | nothing — reopening a revision for editing is never blocked |

States cannot be skipped. When a project declares no `assertions.json`, the assertion
condition does not apply; when it does, any failing assertion blocks every step forward.
Each recorded entry keeps a timestamp, the revision, an optional note, which interface
recorded it, and the evidence at the time (build status, assertion counts, preflight
readiness, component and net counts). The newest 200 entries are retained per project.

## An approved revision is read-only

While the current revision is `manufacturing_approved`, file writes and history restores
are refused with HTTP 423 and an explanation. This applies to the browser, the REST API,
and MCP alike, because all three go through the same write path. Reopening the revision as a
draft restores editing.

This is how the project's agent-safety rule is enforced: an agent cannot modify an approved
manufacturing revision, and it cannot clear the lock either.

## What MCP agents may do

`get_review_state` reads the state, history, evidence, and which transitions are available.
`set_review_state` records `validated` or `reviewed` only.

Approving a revision for manufacturing, and reopening an approved revision, are reserved
for a person and refused to agents — the first because approval is consequential, the second
because it would otherwise be a trivial way around the write lock. The transitions in
`get_review_state` report `allowed` for a person and `agentAllowed` separately, so an agent
can see what it must ask for rather than discovering a refusal.

## API

- `GET /api/projects/{projectId}/review` returns the state, whether the revision is locked,
  the history, the evidence, and each transition with whether it is allowed and why not.
- `POST /api/projects/{projectId}/review` records a state. Send `state` and an optional
  `note` (up to 2000 characters), with the current project revision in `If-Match`. A stale
  revision returns HTTP 409, as does a transition the evidence does not justify.

The browser shows the current state in the top bar, opens a review dialog with the evidence,
the note field, the available transitions with their reasons, and the history, and makes the
editor read-only while a revision is approved.

## Limitations

There is no per-user identity in this slice, so an entry records which interface it came
from (`browser` or `mcp`), not who performed it. Anyone with the shared workbench token can
record any state a person may record. Recording a state does not verify a design: it
records that the declared evidence held at that revision. See
[security](security.md).
