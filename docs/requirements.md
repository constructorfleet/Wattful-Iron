# Project requirements

Projects can keep structured engineering requirements in a root-level `requirements.json` file. The document is revisioned with project source, so normal history, export, and MCP file operations include it.

```json
{
  "version": 1,
  "project": { "name": "esp32-sensor-board" },
  "requirements": {
    "board": { "width_mm": 50, "height_mm": 35, "layers": 4 },
    "power": { "input": "usb-c", "voltage": 5, "max_current_ma": 500 },
    "interfaces": [
      { "type": "i2c", "count": 2 },
      { "type": "gpio", "count": 4 }
    ],
    "manufacturing": { "assembler": "jlcpcb" }
  }
}
```

The schema accepts positive board dimensions and layer counts, power values, interface names and counts, and an assembler name. Invalid or unknown fields are rejected. `GET /api/projects/{projectId}/requirements` returns the current revision. Save with `PUT /api/projects/{projectId}/requirements`, sending that revision in both the `If-Match` header and the request body's `revision` field, alongside the `requirements` object. Stale writes return HTTP 409, and invalid documents return HTTP 400.

## Validation

`GET /api/projects/{projectId}/requirements/validate` compares required board width, height, and layer count with the latest successful Circuit JSON build. Dimensions are compared in millimeters with a 0.001 mm tolerance. Each comparison returns `pass`, `fail`, or `not-evaluated` with an explanation.

Power characteristics, interface counts, and assembler compatibility are stored but currently return `not-evaluated`: the workbench does not infer those facts from Circuit JSON. A stale preview returns no checks until the project has a successful build for its current revision. No requirements file returns `configured: false`.

The authenticated MCP tools `get_project_requirements` and `validate_project_requirements` provide the same document and checks to agents. The validator is a requirements check for the supported fields, not a complete ERC, DRC, electrical, or fabricator sign-off.
