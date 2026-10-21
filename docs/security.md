# Security model and limitations

## Prototype boundary

Project TypeScript is arbitrary code. The API service no longer executes it in
the API process. In `isolated` mode (the production default), the app sends a
bounded source snapshot to a separate build-runner service. The runner accepts
only an entrypoint and files, then creates a disposable container from the
separately built `build-job` image. That job has no network, no project-volume
or sibling-project mount, no Docker socket, and no deployment token. It runs as
UID/GID `65532`, with all capabilities dropped, `no-new-privileges`, and fixed
CPU, memory, PID, time, source-size, output-size, and log-size limits. Docker
rejects archive uploads to containers configured with a read-only rootfs, so
the container layer is writable; the job UID cannot write the root-owned image
or toolchain files. Its bounded `/tmp` is the build workspace and writable
scratch area. The runner deletes the container after success, failure, or
timeout.

The runner is a privileged control-plane component: it alone receives the host
Docker Engine socket and creates containers using a fixed policy. Keep it on a
dedicated build host or node, restrict its internal network and token to the
API service, and do not expose its HTTP port. A compromised runner or Docker
daemon can control that builder host. The API service itself receives no Docker
socket. The runner and API share only a bearer token; the job container receives
neither.

The configured `runsc` gVisor runtime adds a user-space system-call boundary to
the ordinary container controls. It must be installed and registered on the
Docker Engine that the runner controls. If the runtime is missing, job creation
fails closed; there is no fallback to `runc`. Operators may explicitly set
`BUILD_SANDBOX_RUNTIME=runc`, but every successful build then reports
`container-only` isolation and an API build warning. Standard OCI containers
alone are not a strong boundary for hostile code. Even gVisor is defense in
depth, not a guarantee against kernel/runtime vulnerabilities or denial of
service; isolate builder hosts and keep them patched.

`BUILD_EXECUTION_MODE=trusted-local` is an explicit development-only mode that
runs the CLI as a child process on the local host. The application refuses this
mode when `NODE_ENV=production`. Do not use it for projects from untrusted
users. Injected build functions are intended for tests and are not selectable
through HTTP or MCP.

The project has no individual user accounts or project-level authorization.
`WORKBENCH_AUTH_TOKEN` is a single shared browser/REST gate and MCP uses its own
shared token; either credential holder can access all projects. Keep the app
port private, use TLS and access control at a trusted reverse proxy, and do not
store secrets in project files. The isolated job cannot reach the network, so
project dependencies must come from the pinned build-job image; automatic npm
install is not performed.

## Network exposure

Compose binds to `127.0.0.1` by default. Keep that setting when a local reverse
proxy publishes the service. If the proxy runs on another machine or in an
overlay network, configure an appropriate private bind address and firewall;
do not publish this unauthenticated prototype directly to the public internet.
Configure the proxy for long-lived HTTP responses so SSE connections are not
buffered or prematurely timed out. Use TLS at the proxy for remote access.

## Data and credentials

Project data lives in the `circuits-projects` Docker volume. Back it up and
restrict access to Docker administrators. The application does not currently
provide user-level project isolation, encryption at rest, or an audit trail.
Do not store secrets in project files. Keep the `.env` file local and never
commit it.

## Image vulnerability gate

The container workflow runs Trivy against OS and Node package vulnerabilities
and fails on HIGH or CRITICAL findings that have a fix. The current production
image uses Node 24.21.0 Trixie, pinned to OCI index
`sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66`.
Its final runtime removes npm and npx because the service starts directly with
Node and does not need package installation at runtime. The reported Node
package findings were in the Node image's bundled npm tree,
not the application dependency lockfile; no application overrides are needed.

A Trivy 0.74.0 scan on 2026-10-17 of the final `circuits-local:validation`
image (`sha256:7d0e0e128563328d0e44678cd5a7685ba2fa992bcc15e80a4dffdafa6f7232d3`),
built with `package-lock.json` SHA-256
`63448865b510f088b85de60d66fdaccbbf31cd245da8ebbed6e9e675574a78b9`, found no
HIGH or CRITICAL OS or library vulnerabilities. The configured gate exited 0.
The workflow still fails on future fixed HIGH or CRITICAL findings; no findings
are suppressed.

The shared access token remains a perimeter gate, not tenant isolation. The
runner bounds concurrent jobs and validates every source path, but no
per-user/project authorization or audit history exists. Review the threat
model before exposing the service to multiple mutually untrusted users.

## Outbound component sourcing requests

Component sourcing is disabled unless `COMPONENT_SOURCING_URL` is set. With no
value the workbench makes no outbound supplier requests, so an air-gapped
deployment stays air-gapped. When it is set, the application server queries that
URL for LCSC part numbers taken from the project's Circuit JSON. That reveals
which parts a design uses to the configured endpoint, so point it at your own
instance if that matters. The client requires an `http` or `https` URL, applies
a request timeout (`COMPONENT_SOURCING_TIMEOUT_MS`, default 8000 ms), rejects
responses larger than 512 KB, and caches results in memory for ten minutes. A
supplier outage degrades the affected features to "not evaluated" rather than
failing a build or a preflight.

## Review states and who may change them

An approved revision is read-only, and MCP agents cannot approve a revision or reopen an
approved one.

With `AUTH_MODE=users`, roles make that an authorization boundary: only owners may approve a
revision, manage accounts, or delete a project, and review entries record the account that
made them. See [accounts](accounts.md) for the credential handling, session cookies, CSRF
protection, and the limits — no SSO or MFA, no per-project permissions, and no password
reset flow.

Without accounts the workbench is open, or gated by the shared `WORKBENCH_AUTH_TOKEN`, and
anyone holding that token can record or reopen any state. A shared token configured
alongside accounts also keeps full access, including approval, so remove it once accounts
are in use. In that configuration treat review states as an audit trail and a guard against
accidental edits rather than access control.
