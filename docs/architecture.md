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
- Docker Compose deployment with a persistent projects volume.

Preview availability and fidelity depend on the supported tscircuit output for
each project. Preview output is not an electrical or manufacturing sign-off.

## Not implemented

The following capabilities in the project vision are not available in this
slice: MCP and ACP servers, authentication and authorization, sandboxed
execution of user code, simulation, dedicated ERC/DRC, net tracing, BOM or
manufacturing exports, Git-backed revision history, approval states, and
purchasing or fabrication integrations. Project files persist on disk, but
there is no source history or revision browser yet. Do not infer support from
the architecture goals in `PROMPT.md`.

See [security limitations](security.md) before exposing the prototype to a
network or accepting projects from other users.
