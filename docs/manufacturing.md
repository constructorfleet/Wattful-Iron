# Manufacturing preflight

`GET /api/manufacturing/profiles` lists the available rule profiles. Select one
on both preflight and export with `?profile=<id>`; the default is
`board-default`.

`GET /api/projects/:id/manufacturing` returns structured checks for the latest
successful tscircuit build. The UI's **Rule checks · Manufacturing** dialog
shows the same checks and selected profile used by the ZIP export gate.

The check requires a successful build for the current preview revision, a PCB
board in Circuit JSON, and reference designators plus placed PCB footprint
geometry for each source component. It reports missing placed PCB components
as a warning. Circuit JSON PCB/source error records block export; warning
records remain visible as review items. The `jlcpcb-2layer-1oz` profile checks
trace width (0.10 mm), non-plated hole diameter (0.50 mm), and routed-copper
clearance from rectangular board edges (0.20 mm), and declared FR4 / two-layer
board compatibility. A board that omits its layer count or material receives a
manual-review warning. If a board uses a polygon outline, edge clearance is
reported for manual review because this check only measures rectangular boards.
`board-default` applies no vendor minima and reports that those checks were not
evaluated.

`GET /api/projects/:id/manufacturing.zip` downloads the installed tscircuit
CLI's `--format gerbers` ZIP after preflight passes. The package contains the
Gerber copper, mask, paste, silkscreen, and outline files, plus `bom.csv` and
`pick_and_place.csv`; drill files are included when the design has drilled
features. The export uses the Circuit JSON snapshot from the successful build,
and the server rejects a project revision change during export.

These checks cover a limited subset of the published profile rules; they do
not check every copper clearance, plated-hole capability, stackup, solder-mask
rule, board shape, or assembly requirement. A passing preflight and a
downloadable package do not certify electrical safety, manufacturability, or
compatibility with a particular vendor. Review all files with the selected
fabricator and assembler before ordering.
