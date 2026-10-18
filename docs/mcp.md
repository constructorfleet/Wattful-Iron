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
| `get_project` | Read metadata, revision, and latest build state. |
| `get_project_files` | List project files. |
| `read_project_file` | Read a file and its current project revision. |
| `update_project_file` | Write a file when the supplied revision is current. |
| `build_project` | Run the CLI build and return its result or diagnostics. |
| `get_diagnostics` | Read diagnostics from the latest build. |
| `get_preview` | Read the last successful Circuit JSON for `schematic`, `pcb`, or `3d`. |
| `list_components` | List `source_component` elements, including a matching `pcb_component` placement when one is present. |
| `list_nets` | List `source_trace` logical connections with their connected `source_port` elements. |
| `trace_net` | Inspect `source_trace` elements by net name or trace ID, connected ports and components, and matching `pcb_trace` routes. |
| `get_pin_connections` | List a component's `source_port` elements and the source traces that include each port. Match components by name or `source_component_id`. |
| `get_board_properties` | Return the emitted `pcb_board` elements, including dimensions, material, stackup, and design-rule properties. |
| `get_project_requirements` | Read a project's revisioned `requirements.json` document, when configured. |
| `validate_project_requirements` | Compare supported board requirements with the latest successful build and report unsupported checks as not evaluated. |
| `run_simulation` | Build the current source and return transient SPICE results emitted by tscircuit, when configured. |
| `get_simulation_results` | Read waveform data and probe/net information from the latest successful build. |
| `check_manufacturability` | Run the same current-revision completeness checks used by the manufacturing download route. |

`update_project_file` requires the `revision` returned by `read_project_file`; stale writes return a tool error. There are no delete or component-ordering tools.

Circuit inspection reads the most recent successful build. These tools expose the fields present in Circuit JSON: logical nets come from `source_trace` and `connected_source_port_ids`, pin details from `source_port`, PCB placement from `pcb_component`, and board data from `pcb_board`. `trace_net` accepts a source trace name or ID and can return multiple matching traces when a name is reused. These tools do not infer missing component, pin, or board properties.

Simulation uses the existing tscircuit build integration. Add supported analog
simulation elements and probes to the source; `run_simulation` rebuilds the
project and reports any transient results present in Circuit JSON. The
workbench does not implement a separate solver or expose every analysis type.

`check_manufacturability` reports whether the latest build passes the current
board, reference, footprint, and revision checks. The browser can download a
preflight-approved manufacturing ZIP from
`/api/projects/{projectId}/manufacturing.zip`; it contains Gerber/drill files,
BOM, and pick-and-place data. The checks do not replace ERC/DRC or vendor rules.

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
