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
| `build_project` | Run the CLI build and return its result or diagnostics. |
| `get_diagnostics` | Read diagnostics from the latest build. |
| `get_preview` | Read the last successful Circuit JSON for `schematic`, `pcb`, or `3d`. |
| `list_components` | List `source_component` elements, including a matching `pcb_component` placement when one is present. |
| `get_component` | Read one component by reference/name or `source_component_id`, including any PCB placement, source ports, and their connected traces. |
| `get_circuit_json` | Read raw Circuit JSON from the latest successful build with the revision that produced it. |
| `list_nets` | List `source_trace` logical connections with their connected `source_port` elements. |
| `trace_net` | Inspect `source_trace` elements by net name or trace ID, connected ports and components, and matching `pcb_trace` routes. |
| `get_pin_connections` | List a component's `source_port` elements and the source traces that include each port. Match components by name or `source_component_id`. |
| `get_board_properties` | Return the emitted `pcb_board` elements, including dimensions, material, stackup, and design-rule properties. |
| `check_connectivity` | Summarize source-port links emitted in Circuit JSON, including ports with no emitted trace and trace references to missing ports. |
| `get_project_requirements` | Read a project's revisioned `requirements.json` document, when configured. |
| `validate_project_requirements` | Compare supported board requirements with the latest successful build and report unsupported checks as not evaluated. |
| `run_simulation` | Build the current source and return transient SPICE results emitted by tscircuit, when configured. |
| `get_simulation_results` | Read waveform data and probe/net information from the latest successful build. |
| `run_erc` | Run the supported netlist, pin specification, and source checks, and report which electrical checks are not evaluated. |
| `run_drc` | Run the supported placement and routing checks, and report which board checks are not evaluated. |
| `check_routing` | Report routing findings, including unrouted and discontinuous connections. |
| `analyze_power` | Report IPC-2221 current capacity per routed trace, and the power quantities that are not evaluated. |
| `check_manufacturability` | Run the same current-revision completeness checks used by the manufacturing download route. |
| `get_manufacturing_package` | Return a `GET` path and `application/zip` content type for the preflight-gated manufacturing download route, optionally selecting a fabricator profile. |

`update_project_file` requires the `revision` returned by `read_project_file`; stale writes return a tool error. `duplicate_project` also requires the current project revision and creates a fresh project history. There are no delete or component-ordering tools.

Circuit inspection reads the most recent successful build. These tools expose the fields present in Circuit JSON: logical nets come from `source_trace` and `connected_source_port_ids`, pin details from `source_port`, PCB placement from `pcb_component`, and board data from `pcb_board`. `get_component` accepts a component reference/name or source component ID; it returns only related placement, pins, and trace connections present in that build. `get_circuit_json` returns the complete JSON and its build revision. `trace_net` accepts a source trace name or ID and can return multiple matching traces when a name is reused. These tools do not infer missing component, pin, or board properties.

`check_connectivity` reports source-port link coverage from the latest successful build and includes its revision. A port with no emitted `source_trace` link is listed as unconnected, and trace references to absent ports are listed as dangling. Unconnected ports may be intentional; this report does not infer design intent or replace ERC.

Simulation uses the existing tscircuit build integration. Add supported analog
simulation elements and probes to the source; `run_simulation` rebuilds the
project and reports any transient results present in Circuit JSON. The
workbench does not implement a separate solver or expose every analysis type.

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

Total current demand, regulator loading, component dissipation, resistor
power-rating headroom, and thermal rise are reported as not evaluated. They need
operating-point values that Circuit JSON does not carry, and they are not
estimated. Configure a tscircuit analog simulation to obtain voltages and
currents.

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
