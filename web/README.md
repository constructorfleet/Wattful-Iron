# Circuits browser workbench

The `web/` app is a React + TypeScript browser client for the local project API. Run it with `npm install && npm run dev` from this directory. Vite proxies no routes by default; deploy it behind the same origin as the API or configure a development proxy in `vite.config.ts`.

The UI includes project listing/creation/opening, a Monaco TSX editor with revision-guarded autosave, an explicit build action and live build status, diagnostics, and tscircuit's `CircuitJsonPreview` for generated Circuit JSON.

## API contract

All endpoints are same-origin and use JSON except the event stream:

- `GET /api/projects` → `Project[]`
- `POST /api/projects` with `{ "name": string }` → `Project`
- `POST /api/projects/import` with `{ "name": string, "files": [{ "name": string, "content": string }] }` → `{ project, sourceComponents, warnings }`. Accepts 1–10 modern KiCad `.kicad_sch` files (1.8 MB combined); original files are retained under `imports/` and the generated tscircuit source is editable.
- `GET /api/projects/:id` → `Project`
- `GET /api/projects/:id/files?path=...` → `{ path, content, revision }`
- `PUT /api/projects/:id/files?path=...` with `{ content, revision }` and `If-Match: revision` → updated file record. `409` or `412` means the editor is stale and must reload before saving.
- `POST /api/projects/:id/build` → `{ buildId, status }`
- `GET /api/projects/:id/events` → SSE named `project`, `file`, `build.status`, `build.ready`, and `build.failed`. Event payloads are JSON. `build.status` carries `{ buildId?, revision?, status, step?, diagnostics? }`; `build.ready` carries `{ buildId, revision, artifacts?: { circuitJsonUrl? } }`; `build.failed` carries `{ buildId, revision, diagnostics }`.
- `GET /api/projects/:id/preview?kind=schematic|pcb|3d` → `{ revision, kind, circuitJson }` for the latest successful build. Each preview kind returns the authoritative Circuit JSON; the runframe component selects its schematic, PCB, or CAD tab.

A source write triggers the server's debounced build. The UI also exposes an explicit Build button. A failed build keeps the currently loaded successful preview in memory while displaying diagnostics. On first build, no fabricated preview is presented.

## Importing a KiCad schematic

Choose **New project**, select one or more `.kicad_sch` files, and create the project. The importer converts the schematic to Circuit JSON and keeps each submitted file in the project's `imports/` folder. The converted Circuit JSON drives the initial preview/build; generated tscircuit source is best-effort. Editing that source switches subsequent builds to normal tscircuit compilation, so inspect the build diagnostics. The API returns conversion warnings for review. Legacy `.sch` files, KiCad project/PCB files, and symbol libraries are not accepted as standalone imports. Multi-sheet designs can be supplied as a set, but the underlying converter describes multi-sheet support as not fully tested. Import does not reconstruct a KiCad PCB layout or guarantee manufacturing-ready footprints/routing.
