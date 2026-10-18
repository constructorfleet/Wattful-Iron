# Security model and limitations

## Prototype boundary

This application executes project TypeScript as part of a tscircuit build.
Project source and dependencies must be treated as arbitrary code. The current
version does not provide a per-project sandbox, individual user accounts,
project-level access control, or isolation between users. The optional
`WORKBENCH_AUTH_TOKEN` adds a shared HTTP Basic/Bearer access gate for the
browser and REST API. The optional MCP endpoint has its own single shared
bearer token. A Docker container narrows the environment but is not, by itself,
a safe sandbox for hostile code.

Run this prototype only for trusted users on a host you control. Keep its HTTP
port private, put TLS and any required access control at a trusted reverse
proxy, and do not mount host directories containing secrets or sensitive data.
Do not provide the service with cloud credentials or other valuable secrets.
Restrict outbound network access at the host/firewall when projects should not
download arbitrary dependencies or contact external systems.

The container runs non-root, drops Linux capabilities, enables
`no-new-privileges`, has a read-only root filesystem, bounds `/tmp`, and sets
default CPU, memory, and process limits. These reduce accidental impact; they
do not make arbitrary project execution safe. Review and adjust resource limits
for your workload, while retaining host-level limits.

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

Before using this service with untrusted users, add user-level authentication
and authorization, isolate project builds in disposable constrained workers,
restrict filesystem and network access, validate archive and path handling,
and review the threat model. The shared access token is a perimeter gate only;
it does not make project source safe to execute or prevent one trusted token
holder from accessing every project.
