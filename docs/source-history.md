# Project source history

The workbench records every project revision twice: as a commit in a Git
repository kept beside the project, and as a local snapshot of the visible
source and configuration files. Both are written whenever a file is saved
through the API or an external file change is detected. Internal build data,
hidden files, `node_modules`, `dist`, and `output` are excluded from both.

## Git-backed history

Each project's repository lives in `.workbench/git` with the project directory
as its work tree, so no `.git` directory appears among the project's own files
and project exports are unaffected. Commits are made as
`Wattful-Iron <workbench@localhost>` with the project revision recorded in a
`Workbench-Revision` trailer, which is how a revision is resolved back to its
commit. Git runs with the host's user and system configuration ignored.

Git history is unbounded: a revision stays listable, comparable, and
restorable after its local snapshot has been pruned. The history API reports
`gitBacked: true` when a usable `git` binary was found.

If `git` is missing, or `GIT_HISTORY=false` is set, the workbench falls back to
snapshots alone, reports `gitBacked: false`, and history is then limited to the
retained snapshots described below. Nothing fails in that case; the container
image installs `git` so the deployed default is Git-backed.

## Local snapshots

Each project keeps its newest 50 snapshots. Older snapshots are deleted as new
ones are recorded; there is no age-based expiry. Snapshots store complete file
contents, so disk usage is approximately the sum of the source tree across
those revisions. The `sizeBytes` value returned by the history API counts UTF-8
file path and content bytes for that snapshot and is absent once a revision's
snapshot has been pruned (`retainedSnapshot: false`).

## Design comparison

When a build succeeds, the workbench also retains a summary of what that build
produced: board dimensions and layer count, components with value, footprint,
part number and pin count, nets with pin count and routing state, counts of
copper traces, vias, pads and unrouted nets, and the simulation result counts.
The newest 200 summaries per project are kept.

Comparing two revisions therefore reports design changes, not only source-text
changes: board dimension changes, components and nets added, removed, or
changed, routing and count changes, and simulation result changes. Components
and nets are matched by name, so a rename reads as one removal plus one
addition. When either revision has no retained build summary, the comparison
reports `available: false` with the reason rather than showing an empty diff.
Rendered schematic, PCB, and 3D images are not compared.

## API

- `GET /api/projects/:id/history` returns `gitBacked`, `snapshotRetention`, and
  the revisions newest first: revision, Git `commit` when available, timestamp,
  changed paths, `retainedSnapshot`, `hasDesignSummary`, and snapshot
  `sizeBytes` while one is retained.
- `GET /api/projects/:id/history/compare?from=<revision>&to=<revision>` returns
  before and after content for each changed file, plus the `design` comparison.
  Revision content comes from the retained snapshot, or from Git when the
  snapshot has been pruned.
- `POST /api/projects/:id/history/:revision/restore` restores all files from a
  revision. Set `If-Match` to the current project revision; stale requests
  return `409`. A restore creates a new history revision and queues a normal
  project build.

MCP exposes the same data through `list_project_revisions` and
`compare_project_revisions`.

The browser's **History** dialog lists revisions with their commit, shows the
design comparison above the source comparison, and restores a selected
revision. Restoring is disabled while the editor has unsaved changes.
