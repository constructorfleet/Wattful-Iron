# Manufacturing preflight

`GET /api/projects/:id/manufacturing` returns structured preflight checks for
the latest successful tscircuit build.

The check requires a successful build for the current preview revision, a PCB
board in Circuit JSON, and reference designators plus placed PCB footprint
geometry for each source component. It reports missing placed PCB components
as a warning. It also reports that this workbench has not run electrical
ERC/DRC or applied a fabricator-specific stackup and design-rule profile.

`GET /api/projects/:id/manufacturing.zip` downloads the installed tscircuit
CLI's `--format gerbers` ZIP after preflight passes. The package contains the
Gerber copper, mask, paste, silkscreen, and outline files, plus `bom.csv` and
`pick_and_place.csv`; drill files are included when the design has drilled
features. The export uses the Circuit JSON snapshot from the successful build,
and the server rejects a project revision change during export.

The workbench does not yet provide fabricator profiles, manufacturer-specific
design-rule checks, assembly drawings, 3D manufacturing models, cost estimates,
or ordering. A passing preflight and a downloadable package do not certify
electrical safety, manufacturability, or compatibility with a particular
vendor. Review all files with the selected fabricator and assembler before
ordering.
