# Testing

```sh
npm test              # server tests and browser tests
npm run build         # type check and bundle
```

## Container acceptance

`scripts/container-acceptance.sh` drives a running workbench over HTTP and
covers the workflow this project defines as done:

1. Create a project from a template and build it.
2. Read the schematic, PCB, and 3D previews and check each one carries
   components, nets, placement, schematic, 3D, and routed-trace data.
3. Edit the source, rebuild, and check the previews follow the new revision.
4. Confirm the live update arrives on the project event stream.
5. Save a deliberate syntax error and check the build fails with actionable
   diagnostics.
6. Confirm the last successful preview is retained while the build is failing.
7. Fix the source and confirm the build recovers.
8. Read simulation status.
9. Run manufacturing preflight and confirm the export agrees with its verdict.

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
