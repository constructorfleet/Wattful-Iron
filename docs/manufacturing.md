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

The BOM data check reports each source component missing a `value` or
`manufacturer_part_number` in Circuit JSON. Missing fields are review warnings,
so the preflight can still permit export; they are not evidence that a supplier
stocks a part or that an assembly house accepts it. Confirm the generated BOM
with the fabricator and assembler.

Preflight also runs the supported `@tscircuit/checks` Circuit JSON checks for
netlist, pin specification, schematic layout, PCB placement, and routing. It
shows each returned finding with its category, message, and affected element
IDs; error findings block export and warnings remain review items. When the
build contains no supported source, schematic, or PCB elements, this check is
reported as not evaluated. These checks cover the library's implemented rules
for the supplied Circuit JSON and are not a complete ERC/DRC equivalent to
KiCad or a fabricator's own rule engine.

Preflight also matches each `source_trace` to a `pcb_trace` with a non-empty
route. A logical source trace without routed PCB geometry blocks export and is
identified by its source trace ID. If the Circuit JSON contains no logical
source traces, routing cannot be verified and preflight reports a warning.

`GET /api/projects/:id/manufacturing.zip` downloads the installed tscircuit
CLI's `--format gerbers` ZIP after preflight passes. The package contains the
Gerber copper, mask, paste, silkscreen, and outline files, plus `bom.csv` and
`pick_and_place.csv`; drill files are included when the design has drilled
features. It also includes `snapshot-manifest.json` with the project revision,
SHA-256 hashes of project source files, declared and lockfile-resolved npm
dependencies when available, source-component metadata, preflight checks,
simulation status/results, and a checksum and size for each other file in the
ZIP. `bom_artifact` identifies the BOM path when one is present. The manifest
does not checksum itself; its `checksum_scope` states this explicitly. The
export uses the Circuit JSON snapshot from the successful build, and the server
rejects a project revision change during export.

Fabricator checks cover a limited subset of the published profile rules; the
routing check confirms that route geometry exists for each logical source
trace but does not prove electrical connectivity or validate every route
segment. Preflight does not check every copper clearance, plated-hole
capability, stackup, solder-mask rule, board shape, or assembly requirement. A
passing preflight and a downloadable package do not certify electrical safety,
manufacturability, or compatibility with a particular vendor. Review all files
with the selected fabricator and assembler before ordering.

## Component availability and cost

These depend on an optional supplier index and are disabled by default; see
[MCP component sourcing](mcp.md#component-sourcing) for the configuration.

With `COMPONENT_SOURCING_URL` set, preflight adds a `component-availability`
check that compares supplier stock with the quantity the design needs, and the
manufacturing dialog shows a component-cost estimate for a board quantity you
choose. Both use the LCSC part numbers Circuit JSON already records for each
component.

The estimate covers component cost only: fabrication, assembly, tooling,
shipping, and taxes are excluded, and prices are the supplier's listed prices
rather than a quote. Parts without an LCSC part number or price appear under
**Unpriced** with the reason. Without a configured provider, availability
reports `not-evaluated` and the cost panel says sourcing is not configured;
neither blocks the export.

## Regression assertions

Preflight includes a `regression-assertions` check when the project declares an
`assertions.json` document. A failed assertion blocks the export, like the other
blocking checks; assertions that cannot be evaluated warn instead, and neither a
missing document nor an unevaluable assertion blocks anything. Each result is
listed in the manufacturing dialog. See [project assertions](assertions.md).

## Review and approval

Manufacturing approval is a [design review state](review.md) on one revision, and it
requires preflight to report ready. While a revision is approved, file writes and history
restores are refused, so the approved source cannot drift from the package generated from
it. Editing the source after an approval produces a new draft revision and leaves the
earlier approval recorded against the revision it was made for.
