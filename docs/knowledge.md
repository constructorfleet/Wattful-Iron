# Project knowledge

A project can keep its engineering context in a root-level `knowledge.json`, revisioned with
project source like [requirements](requirements.md) and [assertions](assertions.md).

```json
{
  "version": 1,
  "knowledge": {
    "summary": "A sensor front end for the bench supply.",
    "functional_requirements": ["Measure 0 to 24 V with 1 percent accuracy."],
    "electrical_assumptions": ["The divider sees a source impedance below 1 kOhm."],
    "design_decisions": [
      { "decision": "22k over 10k divider", "rationale": "Keeps the divider load under 250 uA.", "date": "2026-10-21" }
    ],
    "mechanical_constraints": ["Fits a 40 by 20 mm enclosure bay."],
    "manufacturing_preferences": { "fabricator": "jlcpcb", "assembler": "jlcpcb", "notes": ["Two-layer, 1 oz copper."] },
    "known_issues": [
      { "issue": "Autorouted vias are below the JLCPCB minimum.", "severity": "high", "workaround": "Specify larger vias before ordering." }
    ],
    "pending_decisions": [
      { "question": "Add reverse-polarity protection?", "options": ["Series diode", "P-channel MOSFET"], "owner": "hardware" }
    ]
  }
}
```

Every section is optional, and unknown sections are rejected. Reads report which sections
carry content, which are empty, and how many known issues and open questions there are, so
an agent can see what a project documents without guessing.

- `GET /api/projects/{projectId}/knowledge` reads the document.
- `PUT /api/projects/{projectId}/knowledge` replaces it, with the current revision in both
  the `If-Match` header and the body's `revision` field.
- MCP exposes `get_project_knowledge` and `update_project_knowledge`.

## What this document is not

It is prose written by people and agents. Nothing in it is derived from or checked against
the design:

- Manufacturing preferences recorded here are **not** applied to builds, preflight, or
  exports. Select a fabricator profile for rule checks, and set `COMPONENT_SOURCING_URL`
  for supplier data.
- Requirements that should be checked belong in [`requirements.json`](requirements.md), and
  regressions that should be checked belong in [`assertions.json`](assertions.md).
- A decision recorded here is not enforced. If it matters, encode it as an assertion.

# Project dependencies

`GET /api/projects/{projectId}/dependencies`, and the MCP `get_project_dependencies` tool,
report two things:

- `declared`: what the project's own `package.json` lists.
- `effective`: what a build actually resolves, with the source of each version.

**They can disagree, and the declared versions do not win.** Builds run the workbench's own
pinned tscircuit from the build image rather than a per-project install, so
`declaredVersionsApply` is `false` and a project cannot pin a different version. To change
the version a project builds against, upgrade the workbench image.

A declared dependency the runtime does not provide is reported as `not installed` and
`unavailable to builds`: build containers have no network, so an import that the
workbench's own dependencies do not satisfy fails to build rather than being installed on
demand.

There is deliberately no endpoint for editing dependency versions. One would imply a
per-project install that does not exist.
