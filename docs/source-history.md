# Project source history

The workbench records a full snapshot of visible project source and configuration
files whenever a file is saved through the API or an external file change is
detected. Internal build data, hidden files, `node_modules`, and `dist` are not
included.

Each project keeps its newest 50 snapshots. Older snapshots are deleted as new
ones are recorded; there is no age-based expiry. Snapshots store complete file
contents, so disk usage is approximately the sum of the source tree across
those revisions (up to 50 copies of the current source size, plus small JSON
metadata overhead). The `sizeBytes` value returned by the history API counts
UTF-8 file path and content bytes for that snapshot, excluding the metadata
overhead.

## API

- `GET /api/projects/:id/history` lists retained revisions, timestamps, changed
  paths, and snapshot source size.
- `GET /api/projects/:id/history/compare?from=<revision>&to=<revision>` returns
  before and after content for each changed file.
- `POST /api/projects/:id/history/:revision/restore` restores all files from a
  retained snapshot. Set `If-Match` to the current project revision; stale
  requests return `409`. A restore creates a new history revision and queues a
  normal project build.

The browser's **History** dialog lists saved revisions, lets users select two
snapshots for a side-by-side source comparison, and restores a selected
snapshot. Restoring is disabled while the editor has unsaved changes.
