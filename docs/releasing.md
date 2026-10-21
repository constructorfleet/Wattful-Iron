# Releases and pull request titles

Use a Conventional Commit title for every pull request. The title becomes the
squash commit subject, so it also determines the release note category and
version bump.

```text
feat(import): add support for another schematic format
fix(pcb): preserve the selected footprint while changing views
docs: explain the local build workflow
```

The title check accepts lowercase types such as `feat`, `fix`, `docs`, `test`,
`refactor`, `chore`, and `ci`, an optional scope in parentheses, and the
Conventional Commits breaking-change marker (`!`).
Dependabot is configured to use conventional `chore(deps)`,
`chore(deps-web)`, and `chore(ci)` titles for dependency and action updates.

The repository allows squash merging only, and GitHub uses the PR title as the
squash commit title. This keeps merged history in the same format that
Release Please reads.

Release Please runs on pushes to `main`. It opens or updates a release PR with
the next version and `CHANGELOG.md`, based on Conventional Commit history. Once
that release PR is squash-merged, Release Please creates a GitHub release and
tag. The release workflow builds and publishes multi-architecture container
images tagged with the full version and `major.minor` version. The normal
`main` build continues to publish `latest`.

A release tag points at the `main` commit the release PR was squash-merged
into, and the `Container` workflow validates that commit on push: lint, tests,
build, container acceptance, and the image vulnerability scan. The release
workflow therefore waits for that run to finish for the released commit and
fails the release if it did not succeed, so no release image is published from
a commit that failed validation. It waits rather than re-running the suite,
because the commit is the same one `main` already validated.

The first release uses the existing `0.1.0` package version as its baseline and
starts collecting changes after the bootstrap commit recorded in
`release-please-config.json`.

Release PRs and release tags are both created with the Actions token, and
GitHub does not start workflows for events raised by that token. The release
workflow therefore reports the release PR's `Conventional PR title` status
itself and dispatches `Container` for the PR's head branch, skipping the
dispatch when a run already exists for that commit. Both happen on every push
to `main`, not only when the release PR is first created: an updated release PR
has a new head commit, and `main` requires the `Conventional PR title` and
`Build container image` checks, so without this an updated release PR could not
be merged.

This repository is not published as an npm package; the release artifacts are
the GitHub release and container images.
