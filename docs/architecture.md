# Architecture and current feature status

## Shape of the first slice

The first deployable version is a single Node.js service with a browser client.
It stores project files on disk, invokes the tscircuit toolchain for builds,
retains generated Circuit JSON for preview use, and streams build state and
diagnostics to connected browsers using server-sent events. TypeScript/TSX
project files remain the editable source. Docker Compose mounts persistent
storage at `/data/projects`.

The deployment deliberately avoids separate databases and worker services in
this initial slice. It is a single-node prototype, not a horizontally scalable
or high-availability service. Run one app replica against one project volume.

## Implemented in this slice

- Project creation, listing, opening, and file read/write.
- Browser source editing.
- tscircuit build execution and build diagnostics.
- Generated Circuit JSON retained for preview.
- Live SSE updates.
- Schematic, PCB, and 3D preview panels.
- A simulation panel and `/api/projects/:id/simulation` results endpoint that
  read transient waveform elements emitted by tscircuit builds, with voltage
  probe to Circuit JSON net correlation.
- An optional bearer-token protected Streamable HTTP MCP endpoint with project,
  build, preview, diagnostics, and simulation tools.
- A `/api/projects/:id/manufacturing` preflight for current builds, Circuit JSON
  ERC/DRC diagnostics, and a limited set of selected fabricator rule checks.
- A preflight-gated `/api/projects/:id/manufacturing.zip` download using
  tscircuit's verified Gerber/drill/BOM/pick-and-place ZIP export.
- Board-default and JLCPCB rigid two-layer, one-ounce profiles for checking
  trace width, non-plated hole diameter, and rectangular board edge clearance.
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
slice: ACP servers, user-level authentication and authorization, sandboxed
execution of user code, full dedicated ERC/DRC, interactive connectivity
tracing, complete fabricator rule coverage, Git-backed revision history,
approval states, and purchasing or fabrication integrations. The MCP bearer token is optional
and shared by all clients; it does not protect the browser or REST API.
Simulation results are retained with the successful Circuit JSON build rather
than executed on demand. Project files persist on disk, but there is no source
history or revision browser yet. Do not infer support from the architecture
goals in `PROMPT.md`.

See [security limitations](security.md) before exposing the prototype to a
network or accepting projects from other users.
