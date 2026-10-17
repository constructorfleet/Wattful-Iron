# Quickstart

This guide starts Wattful-Iron locally, creates a board, and opens its first
preview. For deployment on a server, use the [deployment guide](deployment.md).

## Start the workbench

### Docker Compose

Install Docker Engine with the Compose plugin, clone this repository, then run:

```sh
cp .env.example .env
docker compose up --build -d
docker compose logs -f circuits
```

Open <http://127.0.0.1:3000>. Press `Ctrl+C` to leave the log view; the
container keeps running. Stop it with `docker compose down`. Projects remain
in the `circuits-projects` volume.

### Run from a local Node.js checkout

Use Node.js and npm, then run these commands from the repository root:

```sh
npm ci
npm ci --prefix web
npm run build
npm start
```

Open <http://127.0.0.1:3000>. The service stores development projects in
`./projects`; set `PORT` or `PROJECTS_DIR` before `npm start` to change those
defaults.

![Fresh Wattful-Iron workspace with its quickstart project](images/workbench-home.png)

## Create and build a board

1. Select **New project** and enter a project name.
2. Wait for the build indicator in the top bar to say **Ready**. New projects
   start with a small editable board source file.
3. Edit `index.circuit.tsx`. Changes are saved automatically after a short
   pause. Use **Build** to request a fresh build; the top bar shows its state.
4. Select **Schematic** or **PCB** above the preview to inspect those views.
   The **3D** tab opens the CAD view when it is available.

To use the example shown below, copy the source from
[`examples/manufacturing-board/index.circuit.tsx`](../examples/manufacturing-board/index.circuit.tsx)
into the editor, wait for the save indicator, and select **Build**. It defines
a 20 mm by 12 mm board, two resistors, a plated hole, and a non-plated hole.
The source editor enables JSX parsing for TypeScript source. Use the top-bar
build status and preview diagnostics to check the server build result.

![Example source and its generated schematic](images/workbench-schematic.png)

The **Simulation** tab explains what to add when the current project has no
simulation results:

![Simulation tab with no simulation configured](images/workbench-simulation.png)

For simulation setup, manufacturing exports, and MCP connections, see the
[workbench how-tos](workbench-howtos.md). For current feature boundaries and
security limitations, read [architecture](architecture.md) and
[security](security.md).
