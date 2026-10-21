# Project regression assertions

Projects can keep regression assertions in a root-level `assertions.json` file. The
document is revisioned with project source, so normal history, comparison, export, and MCP
file operations include it.

Assertions answer "has this design regressed?", where
[`requirements.json`](requirements.md) records "what must this design be?". The two are
separate documents and are checked separately.

```json
{
  "version": 1,
  "assertions": {
    "nets_connected": ["VIN", "GND", "SIGNAL"],
    "components_present": ["J1", "R1", "D1"],
    "max_supply_current_a": 0.5,
    "max_dissipation_w": 1.0,
    "design_check_findings_must_not_increase": true,
    "max_component_cost_usd": 12.5,
    "cost_board_quantity": 10,
    "simulation": [{ "signal": "VOUT", "min": 3.1, "max": 3.5 }]
  }
}
```

Every field is optional; unknown fields are rejected. `GET
/api/projects/{projectId}/assertions` returns the current document, and `PUT
/api/projects/{projectId}/assertions` saves it with the current revision in both the
`If-Match` header and the body's `revision` field. Stale writes return HTTP 409 and invalid
documents HTTP 400.

## What each assertion checks

| Assertion | Evidence | Passes when |
| --- | --- | --- |
| `nets_connected` | the build's connectivity map | the named net exists and reaches at least two component pins. The message also reports the net's copper routing state. |
| `components_present` | `source_component` names and reference designators | every named component is in the build. |
| `max_supply_current_a` | the DC operating point's supply branch current | the total supply current is at or below the limit. |
| `max_dissipation_w` | component dissipation calculated from the operating point | the calculated total is at or below the limit. It covers only components whose dissipation could be calculated. |
| `design_check_findings_must_not_increase` | the supported tscircuit design checks, compared with the previous retained build summary | the current build has no more findings than that baseline. |
| `max_component_cost_usd` | the supplier price of the design's parts, for `cost_board_quantity` boards (default 1) | the priced component cost is at or below the budget and every part could be priced. |
| `simulation` | DC operating points first, then transient waveforms | the operating-point value, or every sample of the waveform, is inside the asserted `min`/`max` range. |

## Evaluating them

`GET /api/projects/{projectId}/assertions/check` evaluates the document against the latest
successful build and returns each result as `pass`, `fail`, or `not-evaluated` with a
message, plus the counts and the baseline revision used. MCP exposes the same report
through `check_project_assertions`.

An assertion is only reported as passed or failed on evidence that is actually present.
Anything else is `not-evaluated` with the reason, so a green run is never inferred from
missing data. In particular:

- No successful build: every assertion is not evaluated.
- No DC operating point: current and dissipation limits are not evaluated, not met.
- No earlier retained build summary: the design-check comparison has no baseline and is
  not evaluated.
- No configured component sourcing provider: the cost budget is not evaluated. With a
  provider, a priced subtotal under budget while some parts could not be priced is also
  not evaluated rather than a pass; a priced subtotal already over budget fails.
- A signal that produced neither an operating-point value nor a waveform is not evaluated.

Projects with no `assertions.json` return `configured: false` and evaluate nothing.

## Manufacturing preflight

Preflight includes a `regression-assertions` check. A failed assertion **blocks** the
manufacturing export, matching the other blocking preflight checks. Assertions that cannot
be evaluated produce a warning, or `not-evaluated` when none could be evaluated at all, and
neither blocks the export. The browser lists each result in the **Rule checks ·
Manufacturing** dialog.

Passing assertions does not make a design correct or fit for manufacture. They compare this
build with what the project declared and with the previous retained build; they do not
replace ERC, DRC, simulation, or review.
