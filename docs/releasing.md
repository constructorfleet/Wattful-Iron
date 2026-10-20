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

The first release uses the existing `0.1.0` package version as its baseline and
starts collecting changes after the bootstrap commit recorded in
`release-please-config.json`. Release PRs are created by GitHub Actions, whose
token does not start the usual `pull_request` workflows. The release workflow
therefore dispatches the container validation workflow directly and reports
the release PR's title check itself.

This repository is not published as an npm package; the release artifacts are
the GitHub release and container images.
