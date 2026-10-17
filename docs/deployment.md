# Deployment and operations

## Docker Compose

The repository root `docker-compose.yml` builds the application image and
mounts the named volume `circuits-projects` at `/data/projects`.

```sh
cp .env.example .env
docker compose up --build -d
docker compose ps
docker compose logs -f circuits
```

The service binds to `127.0.0.1:3000` on the host by default. Set `HTTP_PORT`
to choose another host port. `BIND_ADDRESS` controls the host-side bind address;
use a private interface only when a remote proxy needs to reach it, and apply
firewall rules. The app listens on port 3000 in the container and uses
`/data/projects` for projects.

Set `MCP_AUTH_TOKEN` in `.env` to enable the MCP endpoint; leave it empty to
keep `/mcp` disabled. The token is shared across MCP clients. It does not
authenticate the browser or REST API, so keep the app private behind a trusted
proxy and apply access control there when needed.

To use a published image instead of building from the checkout, set
`CIRCUITS_IMAGE` in `.env` to a version tag or immutable digest, then:

```sh
docker compose pull
docker compose up -d --no-build
```

The workflow publishes `latest` from `main`, semantic version tags from `vX.Y.Z`
Git tags, and a short commit SHA tag. Prefer a release tag or digest for
repeatable deployments. The registry package may require `docker login ghcr.io`
if its visibility is private. Pull requests and manual runs build and check the
image but do not publish it. The workflow scans the built AMD64 image with
Trivy; it fails on fixable HIGH or CRITICAL OS/library vulnerabilities. Release
publishing includes AMD64 and ARM64 manifests.

## Reverse proxy and TLS

Terminate TLS and apply access control at a trusted reverse proxy. For a proxy
on the same host, keep the app bound to loopback. Example Caddy site:

```caddyfile
circuits.example.com {
    reverse_proxy 127.0.0.1:3000 {
        flush_interval -1
    }
}
```

Allow HTTP/1.1 or HTTP/2 streaming responses and avoid response buffering or
short idle timeouts for the SSE endpoint. The browser and REST API currently
have no built-in authentication; the MCP endpoint can use one shared bearer
token but does not add project-level authorization. See [security](security.md).

## Docker Swarm

Build or pull the image on nodes before deploying. Use the same image version on
every node and place the service on a node with persistent storage. The default
named volume is node-local; do not scale the service across nodes unless you
provide shared storage and have verified the app's concurrency behavior.

Example with a published image and a private network boundary:

```sh
CIRCUITS_IMAGE=ghcr.io/constructorfleet/wattful-iron:VERSION \
BIND_ADDRESS=0.0.0.0 HTTP_PORT=3000 \
docker stack deploy -c docker-compose.yml circuits
```

Replace `VERSION` with a published version tag. In Swarm, restrict access to
the published port with host firewall rules or publish it only on a dedicated
private network. The stack uses one replica and retains its data in the
`circuits-projects` volume on the selected node. `docker stack deploy` does not
build images; the `build` entry is ignored by Swarm. On multi-node clusters,
use a placement constraint and a node-local volume, or configure a shared
volume driver yourself.

## Persistent data and backups

Project files live in the Docker volume named `circuits-projects`. Back up the
volume regularly and before upgrades. To create a compressed archive in the
current directory:

```sh
docker run --rm \
  -v circuits-projects:/source:ro \
  -v "$PWD:/backup" \
  busybox:1.36 tar -czf /backup/circuits-projects-$(date +%Y%m%d-%H%M%S).tar.gz -C /source .
```

Store the archive outside the host and verify restores periodically. Stop the
service for a consistent backup while writes are in progress:

```sh
docker compose stop circuits
# Run the backup command above.
docker compose start circuits
```

Do not run `docker compose down -v` unless you intend to delete the projects
volume. To restore, stop the service and extract a known-good archive into the
volume using a temporary container; confirm ownership and project contents
before starting the app again.

## Upgrades and health

For Compose, make a backup, update `CIRCUITS_IMAGE` to a specific version,
then run `docker compose pull && docker compose up -d --no-build`. For a local
checkout, use `docker compose up --build -d`. Check `docker compose ps` and
`docker compose logs circuits`; the health check calls `GET /healthz` every 30
seconds. Keep the prior image tag available so you can roll back while
preserving the same volume.

For Swarm, deploy the new version tag with `docker stack deploy`. Review task
health and logs before considering the rollout complete. Keep a backup because
application data migrations, if introduced later, may make an old binary
incompatible with newer project data.

## Resource planning

Compose sets starter limits of 2 CPUs and 2 GiB RAM and caps process count and
temporary storage. Building circuits can be CPU- and memory-intensive; adjust
limits for your workload. These are operational guardrails, not a build sandbox
or a security boundary.
