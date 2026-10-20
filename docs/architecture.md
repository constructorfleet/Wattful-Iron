# Architecture and current feature status

## Shape of the first slice

The first deployable version is a Node.js service with a browser client and an
isolated build-runner service. The app stores project files on disk, sends
bounded source snapshots to the runner for tscircuit builds, retains generated
Circuit JSON for preview use, and streams build state and diagnostics to
connected browsers using server-sent events. TypeScript/TSX project files
remain the editable circuit source. Docker Compose mounts persistent storage
at `/data/projects`.

The deployment avoids a separate database. It is a single-node prototype, not
a horizontally scalable or high-availability service. Run one app replica
against one project volume.

## Implemented in this slice

- Project creation, listing, opening, and file read/write.
- Browser source editing.
- Local source history with compare and concurrency-checked restore.
- tscircuit build execution and build diagnostics.
- Generated Circuit JSON retained for preview.
- A read-only component inspector that joins source components to PCB placements,
  source ports, and connected source traces by Circuit JSON IDs.
- Live SSE updates.
- Schematic, PCB, and 3D preview panels.
- A simulation panel and `/api/projects/:id/simulation` results endpoint that
  read transient waveform elements emitted by tscircuit builds, with voltage
  probe to Circuit JSON net correlation. The panel can explicitly rebuild the
  current source on demand and display the resulting waveforms or diagnostics.
- An optional bearer-token protected Streamable HTTP MCP endpoint with project,
  build, preview, diagnostics, and simulation tools.
- A `/api/projects/:id/manufacturing` preflight for current builds, supported
  tscircuit Circuit JSON design checks, emitted validation diagnostics, and a
  limited set of selected fabricator rule checks.
- A preflight-gated `/api/projects/:id/manufacturing.zip` download using
  tscircuit's verified Gerber/drill/BOM/pick-and-place ZIP export.
- Board-default and JLCPCB rigid two-layer, one-ounce profiles for checking
  trace width, non-plated hole diameter, and rectangular board edge clearance.
- Versioned `requirements.json` documents with REST and MCP read/validation
  tools. Board dimensions and layer count are checked against Circuit JSON;
  power, interface counts, and assembler compatibility are marked not
  evaluated.
- Isolated project builds in disposable worker containers, with bounded source
  snapshots and build output.
- Docker Compose deployment with a persistent projects volume.

Preview availability and fidelity depend on the supported tscircuit output for
each project. Simulation is driven by tscircuit's existing SPICE simulation
support and must be configured in the circuit source with analog simulation
elements and probes. The workbench reports retained transient graphs and
simulator errors; it does not run a second solver or claim support for every
component model or analysis mode. Preview output is not an electrical or
manufacturing sign-off.

## Not implemented

The following capabilities in the project vision are not available in this
slice: ACP servers, per-user authentication and authorization, full
KiCad-equivalent ERC/DRC, interactive cross-view connectivity tracing, simultaneous resizable
views, component datasheets and supplier/availability/cost enrichment, complete
fabricator rule coverage, Git-backed revision history, approval states, and
purchasing or fabrication integrations. The component inspector only displays
data present in Circuit JSON; it does not highlight the selected component in
preview canvases or edit its source properties. Optional workbench
authentication uses a shared token for the browser and REST API; MCP has its own
shared bearer token. There is no per-user identity or access control.
Requirements validation only
evaluates the emitted board dimensions and layer count; other requirement types
are retained but marked not evaluated.
Simulation execution uses tscircuit's configured SPICE support during its
normal build; the workbench does not run a second solver or claim support for
every component model or analysis mode. Project source history uses local
bounded snapshots, not Git commits. Do not infer support from the architecture goals in
`PROMPT.md`.

See [security limitations](security.md) before exposing the prototype to a
network or accepting projects from other users.
