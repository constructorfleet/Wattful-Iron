# Deployment and operations

## Docker Compose

The repository root `docker-compose.yml` builds the application image and
mounts the named volume `circuits-projects` at `/data/projects`. It also starts
a separate build-runner service. The API container has no Docker socket; only
the trusted runner can access the dedicated build Engine.

Install gVisor `runsc` on the Linux host that runs the build Engine, then
register and verify the runtime:

```sh
sudo /usr/local/bin/runsc install
sudo systemctl restart docker
docker run --rm --runtime=runsc hello-world
```

See the [gVisor installation guide](https://gvisor.dev/docs/user_guide/install/)
and [Docker quick start](https://gvisor.dev/docs/user_guide/quick_start/docker/)
for platform-specific requirements. The app defaults to `runsc` and fails
closed if it is unavailable; there is no fallback. `runc` may be selected
explicitly with `BUILD_SANDBOX_RUNTIME=runc`, but builds then report
`container-only` isolation. Standard OCI containers alone are not a strong
boundary for hostile project code.

Create the runner secret and build the job image, which contains only the
pinned tscircuit runtime dependencies and trusted wrapper, without API/web
code, projects, or deployment secrets:

```sh
mkdir -p .secrets
openssl rand -hex 32 > .secrets/build-runner-token
chmod 600 .secrets/build-runner-token
docker build --target build-job -t wattful-iron-build-job:local .
```

Set `BUILD_RUNNER_TOKEN_FILE` in `.env` to the token file path and
`RUNNER_DOCKER_SOCKET` to the build Engine socket. Rootless Docker commonly
uses `/run/user/<uid>/docker.sock`. The runner socket has authority to create
and delete containers, so use a dedicated, patched build host and do not expose
the runner HTTP port. The job container receives no mounts, network, runner
token, or host app files. Its root filesystem is read-only and it runs as
non-root with no capabilities and no-new-privileges. CPU, memory, PIDs,
temporary storage, time, source, result, and Docker logs are bounded; at most
two builds run concurrently by default.

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
keep `/mcp` disabled. The token is shared across MCP clients.

For a browser and REST access gate, set `WORKBENCH_AUTH_TOKEN` to a random
secret of at least 32 bytes. Browsers will prompt for HTTP Basic credentials
(username `workbench`, password the token); API clients may use a Bearer token.
The health endpoint remains public for container checks. This is one shared
credential, not per-user accounts or project-level authorization. Keep the
service on loopback or a trusted private network, and use TLS for remote
connections.

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

Compose also expects the local `wattful-iron-build-job:local` image built
above. Rebuild it whenever the application revision changes. For a remote
builder, publish the `build-job` target and set `BUILD_JOB_IMAGE` to an
immutable image tag or digest; make it available on the runner's Engine.
Project requests cannot choose an image, command, mount, runtime, or other
container setting.

## Reverse proxy and TLS

Terminate TLS at a trusted reverse proxy. For a proxy on the same host, keep
the app bound to loopback. Set `WORKBENCH_AUTH_TOKEN` for a shared app-level
access gate, or enforce access control at the proxy. Example Caddy site:

```caddyfile
circuits.example.com {
    reverse_proxy 127.0.0.1:3000 {
        flush_interval -1
    }
}
```

Allow HTTP/1.1 or HTTP/2 streaming responses and avoid response buffering or
short idle timeouts for the SSE endpoint. The shared app token and MCP token
do not provide individual accounts or project-level authorization. See
[security](security.md).

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

Swarm ignores Compose `depends_on`. Keep the app in isolated mode and verify
runner health before routing build traffic; the app never falls back to local
execution. Label the dedicated builder node `build_runner=true`, install and
register `runsc` on its Docker Engine, and ensure the job image is present on
that node. The runner socket bind is node-specific, so do not schedule the
runner on general-purpose app nodes. Build and publish the `build-job` target
separately before deploying the stack.

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
