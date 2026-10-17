# Workbench how-tos

These steps assume the app is running and you have opened a project. If this is
your first visit, follow the [quickstart](quickstart.md).

## Edit a circuit and inspect a build

Open a project from the **Projects** list. Edit its `index.circuit.tsx` file in
the source pane. The editor saves changes automatically and the server starts a
debounced build. Use **Build** to request a build immediately. Wait for
**Ready** before relying on the preview; a failed build displays diagnostics
in the preview area. A failed build does not replace the last successful
preview.

Use the **Schematic**, **PCB**, and **3D** tabs to change preview type. The
example manufacturing board source is at
[`examples/manufacturing-board/index.circuit.tsx`](../examples/manufacturing-board/index.circuit.tsx).

![The 3D preview of a board](images/workbench-3d.png)

## Read a simulation result

Add tscircuit analog simulation elements and voltage or current probes to the
source, then build the project. Select **Simulation** to inspect transient
waveforms emitted in Circuit JSON. If the panel says **No simulation
configured**, the current build did not contain the required simulation and
probe data. Wattful-Iron does not supply a separate solver or rerun analysis on
demand. See [implemented simulation scope](architecture.md#implemented-in-this-slice).

![Simulation view for a project without simulation elements](images/workbench-simulation.png)

## Inspect a PCB preview

Select **PCB** after the build reaches **Ready**. The viewer includes layer,
routing, bounds, and measurement controls. In the screenshot below, the
example build's Circuit JSON contains two PCB components, but the browser
viewer rendered only its grid. Inspect the actual preview before using it to
make placement or fabrication decisions.

![PCB preview showing the grid in the local browser run](images/workbench-pcb.png)

## Download manufacturing files

1. Build the latest source and wait until the top bar says **Ready**.
2. Select **Manufacturing ZIP**. The button is available only for a successful
   build of the current source revision.
3. Review the downloaded ZIP with your fabricator and assembler before use.

The preflight checks for a PCB board, current build, reference designators,
and placed PCB footprints. It reports missing placed components as a warning.
It does not run ERC/DRC or apply a vendor design-rule profile. The ZIP contains
Gerber layers, drill files when needed, a BOM, and pick-and-place data. Read
[manufacturing preflight](manufacturing.md) for the exact checks and limits.

## Connect an MCP client

The MCP endpoint is disabled until you configure a shared bearer token. For a
local trusted setup, create one in the shell that will launch the service:

```sh
export MCP_AUTH_TOKEN="$(openssl rand -hex 32)"
npm run build
npm start
```

Then configure Codex or Claude Code using the examples in the
[MCP guide](mcp.md). The token grants access to every project on the service;
keep it private and use HTTPS for connections over a network.

## Troubleshoot a build

- **The editor says Saved but the preview is old:** wait for the build indicator
  to leave **Compiling**. A save triggers a debounced build.
- **The build failed:** read the diagnostics shown in the preview, fix the
  source, and select **Build** again.
- **The file changed outside the editor:** use **Reload file** in the message
  to load the latest revision before editing further.
- **Manufacturing ZIP is disabled:** confirm there is a current successful
  build. Preflight also requires a PCB board, references, and footprint
  geometry.
- **The editor shows red TypeScript underlines:** use the server's **Ready** or
  **Failed** build result as the status of the tscircuit build; Monaco's
  in-browser type diagnostics are not the server build output.

## Browser behavior observed during this guide

The schematic, simulation panel, and 3D canvas loaded in the fresh local
browser session. The 3D screenshot uses the blank starter board, so it shows
the board plane without components. A prior sequence of switching between
preview tabs produced a preview-bundle error once; it did not recur after
reloading the app. The PCB grid-only result described above did
recur for the included manufacturing example. Treat all previews as
development aids and read [architecture](architecture.md) for current scope.
