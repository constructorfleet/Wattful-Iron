# Wattful-Iron

**Fresh circuits, made to order.**

`Wattful-Iron` is an early, self-hosted electronics design workbench built around
tscircuit. The current slice provides browser project management and editing,
build diagnostics, and schematic, PCB, and 3D previews. It is still a prototype;
see [current scope](docs/architecture.md) before relying on it for engineering
sign-off or fabrication.

## Run with Docker Compose

Requirements: Docker Engine with the Compose plugin. Clone the repository, then:

```sh
cp .env.example .env
docker compose up --build -d
docker compose logs -f circuits
```

Open <http://127.0.0.1:3000>. Compose stores projects in the named volume
`circuits-projects` and exposes the app only on loopback by default. Set
`HTTP_PORT` in `.env` to change the host port. Keep `BIND_ADDRESS=127.0.0.1`
when a reverse proxy on the same host terminates TLS. See
[deployment](docs/deployment.md) for GHCR, Swarm, proxy, backup, and upgrade
instructions.

The image runs as the unprivileged `node` user. The root filesystem is
read-only, with `/tmp` as a bounded temporary filesystem and project storage as
the writable persistent volume. The Compose file sets container resource
limits; tune them for the circuits and number of concurrent users you expect.

## Current scope

This prototype supports project create/list/open and file read/write, a browser
source editor, tscircuit builds, retained Circuit JSON preview data, live SSE
updates, diagnostics, and schematic/PCB/3D preview panels. Treat those views as
development previews rather than engineering approval.

MCP/ACP agent interfaces, authentication, isolated execution of untrusted
project code, simulation, dedicated ERC/DRC, and manufacturing exports are not
implemented in this slice. Do not expose the service to untrusted users or use
its output as a manufacturing release. More detail is in
[security limitations](docs/security.md).

## Development

```sh
npm ci
npm ci --prefix web
npm run build
npm start
```

The service listens on `PORT` (default `3000`) and stores projects under
`PROJECTS_DIR` (default `./projects` for local development; the container sets
it to `/data/projects`). `GET /healthz` is the container health endpoint.

## Documentation

- [Architecture and feature status](docs/architecture.md)
- [Deployment, proxy, backups, upgrades, and Swarm](docs/deployment.md)
- [Security model and limitations](docs/security.md)
