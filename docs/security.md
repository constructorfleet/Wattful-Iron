# Security model and limitations

## Prototype boundary

This application executes project TypeScript as part of a tscircuit build.
Project source and dependencies must be treated as arbitrary code. The current
version does not provide a per-project sandbox, authenticated users, access
control, or authenticated MCP endpoints. A Docker container narrows the
environment but is not, by itself, a safe sandbox for hostile code.

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
and fails on HIGH or CRITICAL findings that have a fix. The final rescan on
2026-10-17 with Trivy 0.74.0 used the current `circuits-local:validation`
image (`sha256:695a6f3b1681829b225a80ea28764ff38a6032b681cc01a1b3e09966e881d208`),
built with `package-lock.json` SHA-256
`a4bf6f5d5185cfa60390b435eca6e94e92a02b3402e4dea50e0fbab1b8a439d0` and the
`sharp@0.35.5` override. Trivy reported 3 CRITICAL and 4 HIGH Debian Perl
findings (`CVE-2026-13221`, `CVE-2026-42496`, `CVE-2026-8376`,
`CVE-2026-42497`, `CVE-2026-48962`, `CVE-2026-57432`, and `CVE-2026-57433`),
plus 7 HIGH Node package findings: four in `brace-expansion`
(`CVE-2026-102276`, `CVE-2026-102278`, `CVE-2026-14257`,
`CVE-2026-69152`), and one each in `ip-address` (`CVE-2026-69192`), `tar`
(`CVE-2026-73566`), and `undici` (`CVE-2026-19534`). There are no findings for
`sharp` after the override. Trivy exited 1, so GHCR publishing remains blocked
until these fixed dependencies are updated.

The current image is based on Node 24.21.0 Bookworm, pinned to OCI index
`sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20`.
A newer pinned Bookworm index (`sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5`)
still has the same seven Debian findings. A separately built Node 24.21.0
Trixie variant, pinned to
`sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66`,
has zero OS findings, but its full image still has the seven HIGH Node package
findings and fails the gate. The workflow does not suppress these findings.

Before using this service with untrusted users, add authentication and
authorization, isolate project builds in disposable constrained workers,
restrict filesystem and network access, validate archive and path handling,
and review the threat model. Those protections are future work, not guarantees
of the current deployment.
