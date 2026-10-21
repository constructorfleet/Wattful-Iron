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
- Git-backed project history: every revision is committed to a repository kept
  beside the project, so history, comparison, and restore are not limited by
  snapshot retention. Local snapshots remain as a fallback, and history reports
  whether it is Git-backed. Comparing two revisions reports design changes
  (board, components, nets, routing and simulation counts) from retained build
  summaries alongside the source-file comparison. Rendered image comparison is
  not implemented.
- Project duplication, rename, deletion, and ZIP archive import/export with a
  versioned manifest and traversal/symlink/size limits.
- KiCad `.kicad_sch` and EasyEDA Standard schematic import, converted to
  editable tscircuit source with converter notes; PDF schematics are retained
  as a visual reference only, with no connectivity reconstructed.
- A provisional PCB draft generator for imported schematics that have no
  placements, and a board-outline editor that writes a polygon to the source.
- Simultaneous resizable schematic, PCB, and 3D panels with keyboard-accessible
  dividers, alongside the single-view tabs.
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
- Optional JLCPCB/LCSC component sourcing, off unless
  `COMPONENT_SOURCING_URL` is set: supplier stock, price, package, and
  basic/preferred flags per LCSC part number, a component-cost estimate for a
  board quantity, a `component-availability` preflight check, supplier fields
  in the component inspector, and the cost panel in the manufacturing dialog.
  Keyword/parameter search and substitution recommendations are not
  implemented.
- A `/api/projects/:id/manufacturing` preflight for current builds, supported
  tscircuit Circuit JSON design checks, emitted validation diagnostics, and a
  limited set of selected fabricator rule checks.
- A preflight-gated `/api/projects/:id/manufacturing.zip` download using
  tscircuit's verified Gerber/drill/BOM/pick-and-place ZIP export.
- Board-default and JLCPCB rigid two-layer, one-ounce profiles for checking
  trace width, non-plated hole diameter, rectangular board edge clearance, and
  via hole, via diameter, and annular ring. tscircuit's autorouter emits 0.2 mm
  via holes by default, which the JLCPCB profile reports as below its published
  0.3 mm minimum.
- Rule-check reports name the checks they run and where each comes from, so a
  pass states what it proves. Clearance, overlap, keepout, trace-style and
  via-placement checks come from tscircuit's suite; voltage compatibility is
  reported with the caveat that it is silent unless pins declare voltage
  attributes.
- Optional per-user accounts (`AUTH_MODE=users`) with viewer, engineer, and
  owner roles, scrypt-hashed passwords in a private file, HMAC-signed session
  cookies with CSRF double-submit protection, sign-in throttling, and a
  capability check on every request. Editing needs `write`, approving a
  revision needs `approve`, and account management and project deletion are
  owner-only. Review entries record the account that made them.
- Design review states per revision (`draft → validated → reviewed →
  manufacturing_approved`) with evidence-checked transitions, a retained review
  log, and a read-only lock on an approved revision that refuses writes and
  restores from the browser, REST, and MCP alike. Agents may record validation
  and review; approving a revision and reopening an approved one are reserved
  for a person.
- A library of five parameterised circuit modules (power input, resistor
  divider, LED indicator, RC low-pass, I2C pull-ups) with REST, MCP, and
  browser insertion into `modules/<id>.tsx`. Each module names its terminals,
  parameters, and limits, and a test composes every module onto one board and
  builds it with the real tscircuit CLI. Modules that need registry-resolved
  parts — USB-C input, ESP32 support, buck converters, level shifters — are not
  included, because build containers have no network to resolve them.
- A versioned `knowledge.json` document for project context — summary,
  functional requirements, electrical assumptions, design decisions with
  rationale, mechanical constraints, manufacturing preferences, known issues,
  and pending decisions — readable and writable over REST and MCP. It is prose:
  nothing in it is checked against the design, and manufacturing preferences
  recorded there do not affect builds, preflight, or exports.
- Dependency reporting that names both the versions a project declares and the
  versions a build resolves. Builds use the workbench's own pinned tscircuit,
  so declared versions are reference only and there is no editing endpoint.
- Versioned `assertions.json` regression assertions with REST and MCP evaluation:
  named nets stay connected, required components exist, supply current and
  calculated dissipation stay within limits, supported design-check findings do
  not increase against the previous retained build, component cost stays within
  budget, and simulation values stay within range. Each assertion reports pass,
  fail, or not evaluated with its reason, and a failed assertion blocks the
  manufacturing export.
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
geometry. Every report names both the checks it runs and the checks it does not
evaluate. Voltage-domain conflicts and output driver conflicts are not
evaluated: they need pin attributes that Circuit JSON omits for components that
do not declare them. This is not
KiCad-equivalent ERC/DRC. Operating-point quantities such as component
dissipation, supply current, and trace loading are reported only when the build
emits a DC operating point to calculate them from; regulator loading, resistor
power-rating headroom, and thermal rise are never evaluated.

## Not implemented

The following capabilities in the project vision are not available in this
slice: ACP servers, external identity providers, SSO or MFA, per-project
permissions, password reset flows, full
KiCad-equivalent ERC/DRC, highlighted net and component geometry inside the
schematic, PCB, and 3D canvases, component datasheets, supplier
keyword/parameter search, substitution recommendations, complete
fabricator rule coverage, rendered schematic and PCB image diffs, modules that
need registry-resolved parts, and purchasing or fabrication integrations. Cross-probing moves a selection between the
component inspector, the net inspector, the focused PCB footprint, and the
waveform panel, and lists the schematic wires, copper traces, vias, and
simulation signals on a net; it does not highlight geometry inside the
schematic, PCB, or 3D canvases, and it does not edit source properties. MCP agents can edit board dimensions, components,
component properties, and traces structurally, but there is no equivalent
browser affordance and no circuit-level undo beyond project source history. Workbench authentication is either the shared
token or per-user accounts; MCP keeps its own shared bearer token and is never
granted approval. A configured shared token retains full access, so remove it
once accounts are in use. Roles apply to the whole workbench, not per project.
Regression assertions evaluate only the
quantities listed in [assertions](assertions.md); anything without evidence in
the build is reported as not evaluated rather than passed. Requirements
validation only evaluates the emitted board dimensions and layer count; other requirement types
are retained but marked not evaluated.
Simulation execution uses tscircuit's configured SPICE support during its
normal build; the workbench does not run a second solver or claim support for
every component model or analysis mode. Do not infer support from the architecture goals in
`PROMPT.md`.

See [security limitations](security.md) before exposing the prototype to a
network or accepting projects from other users.
