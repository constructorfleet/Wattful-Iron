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
  source ports, and connected source traces by Circuit JSON IDs; selecting a
  component focuses its PCB footprint, and the PCB context menu opens the
  matching component details from its schematic action.
- Net tracing across views: a `/api/projects/:id/nets` endpoint and browser net
  inspector that group a build with the tscircuit connectivity map and report
  each net's component pins, schematic wires, copper traces, vias, routing
  state, and correlated simulation signals. Cross-probing moves between the net
  inspector, component details, the focused PCB footprint, and the waveform
  panel. The embedded schematic, PCB, and 3D viewers expose no highlight API,
  so a selected net is not drawn highlighted in those canvases.
- Live SSE updates.
- Schematic, PCB, and 3D preview panels.
- A simulation panel and `/api/projects/:id/simulation` results endpoint that
  read the simulation results emitted by tscircuit builds: transient waveforms,
  DC operating-point node voltages and branch currents, DC sweeps, and AC
  sweeps reported as magnitude, magnitude in dB, and phase. Probes are
  correlated with Circuit JSON nets. Each response names the analysis modes
  that produced no results. The panel can explicitly rebuild the current source
  on demand and display the results or diagnostics.
- Power analysis over REST at `/api/projects/:id/power` and through MCP: node
  voltages, branch currents, supply current and power, component dissipation
  from I²R or V²/R, and measured current against IPC-2221 trace capacity per
  net, alongside the quantities that remain not evaluated.
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

Electrical and board rule checks run tscircuit's own check suite and report
findings by category, alongside trace current capacity derived from board
geometry. Every report names the checks it does not evaluate. This is not
KiCad-equivalent ERC/DRC. Operating-point quantities such as component
dissipation, supply current, and trace loading are reported only when the build
emits a DC operating point to calculate them from; regulator loading, resistor
power-rating headroom, and thermal rise are never evaluated.

## Not implemented

The following capabilities in the project vision are not available in this
slice: ACP servers, per-user authentication and authorization, full
KiCad-equivalent ERC/DRC, highlighted net and component geometry inside the
schematic, PCB, and 3D canvases, component datasheets and supplier/availability/cost enrichment, complete
fabricator rule coverage, Git-backed revision history, approval states, and
purchasing or fabrication integrations. Cross-probing moves a selection between the
component inspector, the net inspector, the focused PCB footprint, and the
waveform panel, and lists the schematic wires, copper traces, vias, and
simulation signals on a net; it does not highlight geometry inside the
schematic, PCB, or 3D canvases, and it does not edit source properties. MCP agents can edit board dimensions, components,
component properties, and traces structurally, but there is no equivalent
browser affordance and no circuit-level undo beyond project source history. Optional workbench
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
