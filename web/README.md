# Circuits browser workbench

The `web/` app is a React + TypeScript browser client for the local project API. Run it with `npm install && npm run dev` from this directory. Vite proxies no routes by default; deploy it behind the same origin as the API or configure a development proxy in `vite.config.ts`.

The UI includes project listing/creation/opening, a Monaco TSX editor with revision-guarded autosave, an explicit build action and live build status, diagnostics, and tscircuit's `CircuitJsonPreview` for generated Circuit JSON.

## API contract

All endpoints are same-origin and use JSON except the event stream:

- `GET /api/projects` → `Project[]`
- `POST /api/projects` with `{ "name": string }` → `Project`
- `GET /api/projects/:id` → `Project`
- `GET /api/projects/:id/files?path=...` → `{ path, content, revision }`
- `PUT /api/projects/:id/files?path=...` with `{ content, revision }` and `If-Match: revision` → updated file record. `409` or `412` means the editor is stale and must reload before saving.
- `POST /api/projects/:id/build` → `{ buildId, status }`
- `GET /api/projects/:id/events` → SSE named `project`, `file`, `build.status`, `build.ready`, and `build.failed`. Event payloads are JSON. `build.status` carries `{ buildId?, revision?, status, step?, diagnostics? }`; `build.ready` carries `{ buildId, revision, artifacts?: { circuitJsonUrl? } }`; `build.failed` carries `{ buildId, revision, diagnostics }`.
- `GET /api/projects/:id/preview?kind=schematic|pcb|3d` → `{ revision, kind, circuitJson }` for the latest successful build. Each preview kind returns the authoritative Circuit JSON; the runframe component selects its schematic, PCB, or CAD tab.

A source write triggers the server's debounced build. The UI also exposes an explicit Build button. A failed build keeps the currently loaded successful preview in memory while displaying diagnostics. On first build, no fabricated preview is presented.
