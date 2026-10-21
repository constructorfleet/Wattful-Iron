# MCP server

The workbench exposes an authenticated Streamable HTTP MCP endpoint at `/mcp`. It reuses the project service, so MCP file writes use the same path validation and revision checks as the web API. The endpoint is disabled with HTTP 503 until `MCP_AUTH_TOKEN` is configured.

## Start locally

Generate a long random token and keep it outside the repository:

```sh
export MCP_AUTH_TOKEN="$(openssl rand -hex 32)"
npm run build
npm start
```

The service listens on `http://localhost:3000` by default. Set `PORT` to use another port. Restart the service with a new `MCP_AUTH_TOKEN` to rotate the shared credential; update each client configuration at the same time.

This is a shared bearer token. Anyone holding it can read and modify every project exposed by this workbench. Use it only on a trusted network, and use HTTPS when connecting over a network that is not local.

## Tools

| Tool | Purpose |
| --- | --- |
| `list_projects` | List project metadata. |
| `create_project` | Create a project with an editable tscircuit starter. |
| `duplicate_project` | Copy a project's editable files and retained references into an independent project using the source revision. |
| `get_project` | Read metadata, revision, and latest build state. |
| `get_project_files` | List project files. |
| `read_project_file` | Read a file and its current project revision. |
| `update_project_file` | Write a file when the supplied revision is current. |
| `list_source_components` | List the component elements placed in the circuit source, as opposed to the last build output. |
| `set_board_dimensions` | Set the board `width`, `height`, or `layers` in the source. |
| `add_component` | Add a component element with its tscircuit properties. |
| `remove_component` | Remove a component and every trace that references it. |
| `set_component_properties` | Set, replace, or remove properties on a named component. |
| `connect_components` | Add a trace between two tscircuit selectors. |
| `build_project` | Run the CLI build and return its result or diagnostics. |
| `get_diagnostics` | Read diagnostics from the latest build. |
| `get_preview` | Read the last successful Circuit JSON for `schematic`, `pcb`, or `3d`. |
| `list_components` | List `source_component` elements, including a matching `pcb_component` placement when one is present. |
| `get_component` | Read one component by reference/name or `source_component_id`, including any PCB placement, source ports, and their connected traces. |
| `get_circuit_json` | Read raw Circuit JSON from the latest successful build with the revision that produced it. |
| `list_nets` | List `source_trace` logical connections with their connected `source_port` elements. |
| `trace_net` | Inspect `source_trace` elements by net name or trace ID, connected ports and components, and matching `pcb_trace` routes. |
| `get_net_trace` | Group the build into connectivity-map nets and report each net's component pins, schematic wires, copper traces, vias, routing state, and correlated simulation signals. Pass a net name, net ID, or `source_trace_id` to trace one net. |
| `get_pin_connections` | List a component's `source_port` elements and the source traces that include each port. Match components by name or `source_component_id`. |
| `get_board_properties` | Return the emitted `pcb_board` elements, including dimensions, material, stackup, and design-rule properties. |
| `check_connectivity` | Summarize source-port links emitted in Circuit JSON, including ports with no emitted trace and trace references to missing ports. |
| `get_project_requirements` | Read a project's revisioned `requirements.json` document, when configured. |
| `validate_project_requirements` | Compare supported board requirements with the latest successful build and report unsupported checks as not evaluated. |
| `run_simulation` | Build the current source and return transient SPICE results emitted by tscircuit, when configured. |
| `get_simulation_results` | Read transient waveforms, DC operating-point values, DC/AC sweeps, and probe/net information from the latest successful build. |
| `list_simulation_signals` | List the emitted waveforms, operating-point values, and sweeps without sample data, with the analysis modes that produced no results. |
| `get_waveform` | Read the samples of one waveform or sweep by signal ID or probe name. AC sweeps include magnitude in dB and phase in degrees. |
| `run_erc` | Run the supported netlist, pin specification, and source checks, and report which electrical checks are not evaluated. |
| `run_drc` | Run the supported placement and routing checks, and report which board checks are not evaluated. |
| `check_routing` | Report routing findings, including unrouted and discontinuous connections. |
| `analyze_power` | Report IPC-2221 current capacity per routed trace, and the power quantities that are not evaluated. |
| `get_component_sourcing` | Read manufacturer part number, package, description, stock, unit price, and basic/preferred flags for an LCSC part number from the configured supplier index. |
| `estimate_manufacturing_cost` | Price the build's components for a board quantity, listing every part that could not be priced. Component cost only. |
| `check_manufacturability` | Run the same current-revision completeness checks used by the manufacturing download route. |
| `get_manufacturing_package` | Return a `GET` path and `application/zip` content type for the preflight-gated manufacturing download route, optionally selecting a fabricator profile. |

`update_project_file` requires the `revision` returned by `read_project_file`; stale writes return a tool error. `duplicate_project` also requires the current project revision and creates a fresh project history. There are no delete or component-ordering tools.

## Structural source edits

`set_board_dimensions`, `add_component`, `remove_component`,
`set_component_properties`, and `connect_components` edit the project's
entrypoint TSX as a syntax tree rather than rewriting the file, so an agent can
change one component without reproducing the rest of the source. Each tool
takes the current project revision, writes through the same validated path as
`update_project_file`, and queues a build. TypeScript/TSX remains the
authoritative source; these tools are a typed way to edit it.

Each tool rejects an edit instead of producing source that will not build:

- Board lengths need a unit (`30mm`), and layer counts must be whole numbers.
- A component name must be unique within the board, and the name must exist for
  edits and removals.
- A trace selector must reference a component that exists, and a duplicate
  trace between the same two selectors is refused.
- Property values must be a string, finite number, or boolean. Strings may not
  contain quotes, braces, opening angle brackets, or newlines, so a value
  cannot inject markup into the source. A null value removes a property.
- A source with no `<board>` element, or more than one, is reported as not
  structurally editable. Use `update_project_file` for those.

New components are inserted after the last existing component and before the
traces; new traces are appended after the last trace. Removing a component also
removes the traces that reference it, so the circuit does not keep a dangling
connection.

Circuit inspection reads the most recent successful build. These tools expose the fields present in Circuit JSON: logical nets come from `source_trace` and `connected_source_port_ids`, pin details from `source_port`, PCB placement from `pcb_component`, and board data from `pcb_board`. `get_component` accepts a component reference/name or source component ID; it returns only related placement, pins, and trace connections present in that build. `get_circuit_json` returns the complete JSON and its build revision. `trace_net` accepts a source trace name or ID and can return multiple matching traces when a name is reused. `get_net_trace` goes one level further: it groups the build with the tscircuit connectivity map, so source traces that share a port become a single net, and reports that net's pins, schematic wires, copper traces with length and layers, vias, routing state, and the simulation signals whose probes reference it. Simulation signals whose probes carry no net reference are returned as `uncorrelatedSimulationSignals`. Every response carries a `limitations` list. Connectivity tracing is not signal propagation, and no viewer geometry is highlighted. These tools do not infer missing component, pin, or board properties.

`check_connectivity` reports source-port link coverage from the latest successful build and includes its revision. A port with no emitted `source_trace` link is listed as unconnected, and trace references to absent ports are listed as dangling. Unconnected ports may be intentional; this report does not infer design intent or replace ERC.

Simulation uses the existing tscircuit build integration. Add supported analog
simulation elements and probes to the source; `run_simulation` rebuilds the
project and reports the results present in Circuit JSON: transient waveforms,
DC operating-point node voltages and branch currents, DC sweeps, and AC sweeps.
AC sweeps are reported as magnitude, magnitude in dB, and phase in degrees,
calculated from the complex samples tscircuit emits. Every simulation response
carries a `notEvaluated` list naming the analysis modes that produced no
results in that build, plus the modes the workbench cannot report at all:
temperature sweeps, Monte Carlo tolerance analysis, and digital or mixed-signal
simulation. The workbench does not implement a separate solver.

`check_manufacturability` reports whether the latest build passes the current
board, reference, footprint, revision, supported tscircuit design, and selected
fabricator-profile checks. It includes supported design-check findings and
affected Circuit JSON element IDs. This is not full KiCad-equivalent ERC/DRC.
`get_manufacturing_package` returns a relative download path, HTTP method, and
content type. Fetch that path on the same workbench using the MCP bearer token;
the download route reruns preflight, produces the ZIP with its provenance
manifest, and rejects the download if the project revision changes during
generation. Pass `profile=jlcpcb-2layer-1oz` to apply the JLCPCB two-layer
profile, or omit it to use board defaults. The ZIP contains Gerber/drill files,
BOM, and pick-and-place data. These checks do not replace complete vendor rules
or manufacturing review.

## Component sourcing

Supplier lookups are **off until a provider is configured**, so the workbench
makes no outbound supplier requests by default and stays usable offline. Set
`COMPONENT_SOURCING_URL` to a JLCPCB/LCSC part index that exposes the tscircuit
JLCSearch `/api/search` shape — the public mirror is
`https://jlcsearch.tscircuit.com`, or run your own — and optionally
`COMPONENT_SOURCING_TIMEOUT_MS`.

`get_component_sourcing` takes an LCSC part number such as `C2040` and returns
the supplier's manufacturer part number, package, description, stock, unit
price, and basic/preferred flags. Results are cached in memory for ten minutes.
`estimate_manufacturing_cost` prices the components in the latest successful
build for a board quantity, using the LCSC part numbers Circuit JSON already
records in `supplier_part_numbers`. Identical parts are grouped and multiplied
by the board count.

The estimate is **component cost only**: board fabrication, assembly, tooling,
shipping, and taxes are excluded, unit price is the supplier's listed price
rather than a quote, and no attrition or spares are added. Parts without an
LCSC part number, without a listed price, or that the supplier index does not
return are listed in `unpriced` with the reason instead of being priced as
zero. A supplier outage leaves the affected parts unpriced rather than failing
the whole estimate.

Keyword and parameter search is not implemented. The upstream index's search
endpoint ignores keyword and value filters, so lookups are by LCSC part number
only. Substitution recommendations are likewise not implemented: shared
footprints do not make parts interchangeable, and no substitution data is
available here.

When a provider is configured, manufacturing preflight gains a
`component-availability` check comparing supplier stock with the quantity the
design needs. Without a provider the check reports `not-evaluated` rather than
passing. The same data is available over REST at `GET /api/components/:part`
and `GET /api/projects/:id/bom-cost?boards=N`.

## Rule checks and power

`run_erc`, `run_drc`, and `check_routing` run tscircuit's own check suite over
the latest successful build and split its findings by category: netlist, pin
specification, and source findings are electrical; placement and routing
findings are board-level. Every report lists the checks it does **not**
evaluate, with the reason, so a passing report is not mistaken for full
coverage. Fabricator limits such as minimum trace width and hole size are
checked against a selected profile by `check_manufacturability` instead. These
reports are not KiCad-equivalent ERC/DRC.

`analyze_power` calculates how much current each routed trace can carry using
the IPC-2221 curves, from the narrowest segment width, the layer the segment is
on, an assumed copper weight, and an allowed temperature rise. External and
internal layers use their respective constants. It reports each trace and the
narrowest one, together with the assumptions used.

`temperatureRiseC` defaults to 10 and `copperOunces` to 1. The result is a
geometric limit for an isolated trace; it does not account for adjacent copper,
planes, vias, or ambient temperature.

When the build contains a DC operating point, `analyze_power` also reports what
that operating point makes calculable: node voltages, branch currents, supply
current and power per supply component, component dissipation (I²R from a branch
current through a declared resistance, or V²/R from a voltage measured across
one), and each measured current against the IPC-2221 capacity of the copper
carrying its net, flagged `over-capacity` when it exceeds it. Values come from
the simulator; nothing is estimated, and a quantity is omitted when the data it
needs is absent.

Regulator loading, resistor power-rating headroom, and thermal rise stay not
evaluated: Circuit JSON carries no regulator model, no component power ratings,
and the workbench performs no thermal analysis. Without an emitted operating
point, total current demand, component dissipation, and trace loading are also
reported as not evaluated rather than estimated. The same analysis is available
over REST at `GET /api/projects/:id/power`, which accepts the same
`temperatureRiseC` and `copperOunces` query parameters.

Projects can define engineering constraints in `requirements.json`. The
requirements MCP tools expose the document and compare board dimensions and
layer count with Circuit JSON. Power, interface-count, and assembler checks
remain explicitly not evaluated. See [Project requirements](requirements.md)
for the schema, REST endpoints, and current validation limits.

## Codex

Export `MCP_AUTH_TOKEN` in the environment that launches Codex, then add this to `~/.codex/config.toml`:

```toml
[mcp_servers.circuits_workbench]
url = "http://localhost:3000/mcp"
bearer_token_env_var = "MCP_AUTH_TOKEN"
```

Check the connection with `codex mcp list` or `/mcp` in the Codex TUI.

## Claude Code

Add a remote HTTP server with a Bearer header:

```sh
claude mcp add --transport http circuits-workbench http://localhost:3000/mcp \
  --header "Authorization: Bearer $MCP_AUTH_TOKEN"
```

The CLI saves the configured header in its local MCP settings. To avoid putting the token in a project file, keep this configuration local and remove/re-add the server when rotating the token. Check the connection with `claude mcp get circuits-workbench` or `/mcp`.

Alternatively, a project `.mcp.json` can use Claude Code's environment variable expansion:

```json
{
  "mcpServers": {
    "circuits-workbench": {
      "type": "http",
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer ${MCP_AUTH_TOKEN}"
      }
    }
  }
}
```

## Protocol and SDK

The endpoint uses the official TypeScript SDK's per-request server factory and Express bearer-auth middleware. See the SDK's [HTTP serving guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/http.md), [Codex MCP configuration guide](https://developers.openai.com/codex/mcp), and [Claude Code MCP guide](https://code.claude.com/docs/en/mcp).
