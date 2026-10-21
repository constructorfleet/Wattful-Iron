# Linting

```sh
npm run lint
```

Biome runs as a linter only. The formatter is disabled on purpose: the existing
source uses long single-line JSX and object literals, and reformatting it would
produce a very large diff with no behavior change.

CI fails on any diagnostic, including warnings, through
`biome lint --error-on-warnings`.

Generated output is not linted. `biome.json` lists the source directories
explicitly, so the committed `web/dist` bundles are excluded.

## Disabled rules

These three rules are off in `biome.json` because following them here would
change behavior or restate existing conventions rather than fix a defect:

- `correctness/useExhaustiveDependencies` — several effects intentionally
  depend on `project?.id` instead of `project`, so they re-run when the open
  project changes rather than on every project object identity change, and
  intentionally list `build.status` and `build.revision` so preflight and
  simulation data refresh when a build finishes. Applying the rule's fixes
  would add redundant fetches and stop those refreshes.
- `a11y/noStaticElementInteractions` — the modal backdrops carry
  `onMouseDown` for click-outside-to-close as a redundant pointer affordance.
  Every dialog also has a real close button in its header, so keyboard users
  do not depend on the backdrop.
- `style/noNonNullAssertion` and `style/useTemplate` — existing conventions
  throughout the codebase, not defects.

Everything else the recommended rules report is fixed in place. Three
individual findings carry an inline `biome-ignore` with its reason: two
deliberate control-character checks in path validation, and the preview
divider, which needs a focusable drag handle that `<hr>` cannot provide.

## Known accessibility gap

Placing the first waveform measurement cursor requires a click on the plot;
there is no keyboard equivalent yet, so that one finding is suppressed inline
rather than fixed. Panning, zooming, resetting, placing the second cursor, and
CSV export all have buttons. The board outline canvas has the same click
affordance, but its points can also be added and edited with the Add point
button and the coordinate inputs.
