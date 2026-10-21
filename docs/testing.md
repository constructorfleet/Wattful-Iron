# Testing

```sh
npm test              # server tests and browser tests
npm run build         # type check and bundle
```

## Container acceptance

`scripts/container-acceptance.sh` drives a running workbench over HTTP and
covers the workflow this project defines as done:

1. Create a project from a template and build it.
2. Edit it into the representative acceptance circuit: a power input header,
   decoupling capacitor, current-limited LED, divider leg, and the three named
   nets `VIN`, `SIGNAL`, and `GND` across a 30 x 16 mm board. Every part names a
   built-in footprint, because build containers have no network and cannot fetch
   supplier footprints, and each net is wired as a chain of distinct hops so no
   logical trace duplicates a connection another trace already routes.
3. Read the schematic, PCB, and 3D previews and check each one carries all five
   components, all three nets, placement, schematic, 3D, and routed-trace data.
4. Confirm the live update arrives on the project event stream.
5. Save a deliberate syntax error and check the build fails with actionable
   diagnostics.
6. Confirm the last successful preview is retained while the build is failing.
7. Fix the source and confirm the build recovers.
8. Read simulation status.
9. Trace each net and check its pins and copper, including that `GND` reaches
   the power connector, and that the report names its limitations.
10. Read the power analysis: routed trace capacity and a narrowest trace, with
    the operating-point quantities still reported as not evaluated because this
    circuit configures no simulation.
11. Confirm component sourcing stays disabled: the BOM-cost endpoint reports
    `configured: false` with the design's parts, and a part lookup returns 503.
12. Confirm history is Git-backed, every revision carries a commit, and
    comparing two built revisions reports the added components in its design
    comparison.
13. Run manufacturing preflight and confirm the export agrees with its verdict.

The circuit covers power input, passives, an LED, a header, and multiple nets,
and it routes completely, so step 13 exercises a ready preflight and a real
manufacturing ZIP rather than only a refusal. It does not include a voltage
regulator: no regulator part resolves offline from the pinned tscircuit
version, so regulation is not exercised here.

CI runs it against the built container image once the service reports healthy.
To run it against a local development server:

```sh
npm run build
BUILD_EXECUTION_MODE=trusted-local PROJECTS_DIR=/tmp/circuits-acceptance PORT=3098 npm start &
BASE_URL=http://127.0.0.1:3098 bash scripts/container-acceptance.sh
```

It needs Bun on the path, because project builds run through the tscircuit CLI.
A full run takes roughly a minute, most of it in the three real builds.

The manufacturing step asserts the export agrees with its own preflight in both
directions: when preflight is ready the download must return a ZIP archive, and
when preflight is blocked the download must be refused with 422 and name a
failing check. That way the step stays meaningful whether or not the template
circuit passes every fabricator rule.
