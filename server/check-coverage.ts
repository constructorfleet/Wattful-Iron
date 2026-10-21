/**
 * What the workbench's rule checks actually cover, and what they do not.
 *
 * The entries below were taken from the installed `@tscircuit/checks` suite rather than
 * assumed, so a report can name the checks that ran instead of only the categories their
 * findings landed in. Keep them in step when that dependency is upgraded.
 */
export type CheckCoverage = {
  check: string
  /** Where the check comes from: tscircuit's suite, a fabricator profile, or this workbench. */
  source: "tscircuit-checks" | "fabricator-profile" | "workbench"
  /** A caveat that limits what a pass actually proves. */
  caveat?: string
}

export const electricalCoverage: CheckCoverage[] = [
  { check: "Unconnected and dangling source traces", source: "tscircuit-checks" },
  { check: "PCB ports with no connected trace", source: "tscircuit-checks" },
  { check: "Pins that must be connected", source: "tscircuit-checks" },
  { check: "Components whose pins are underspecified", source: "tscircuit-checks" },
  { check: "Missing power pin and missing ground pin declarations", source: "tscircuit-checks" },
  {
    check: "Source pin voltage compatibility",
    source: "tscircuit-checks",
    caveat: "Only compares pins that declare voltage attributes. tscircuit emits no pin attributes for components that do not declare them, so this check is silent on most designs and a pass does not mean voltage domains were verified.",
  },
  { check: "Two-terminal switch contacts on different nets", source: "tscircuit-checks" },
  { check: "I2C and connector misconfiguration reported by the build", source: "tscircuit-checks" },
  { check: "Source-port link coverage, including dangling port references", source: "workbench", caveat: "Reports emitted links only; an unconnected pin may be intentional." },
]

export const electricalNotEvaluated = [
  {
    check: "Voltage-domain conflicts between components",
    reason: "Requires pin voltage attributes in Circuit JSON. Components that do not declare them emit none, so there is nothing to compare; declare pin attributes to make the upstream voltage compatibility check meaningful.",
  },
  {
    check: "Component rating violations",
    reason: "Circuit JSON records no component ratings. Supplier descriptions carry them only as unstructured text, which is not used here rather than parsed heuristically.",
  },
  {
    check: "Output driver conflicts",
    reason: "Requires pin direction attributes, which Circuit JSON omits for components that do not declare them. Two drivers on one net are therefore not detectable.",
  },
  {
    check: "Power dissipation and current demand",
    reason: "Requires operating-point values. analyze_power reports these when a build emits a DC operating point, and marks them not evaluated otherwise.",
  },
]

export const designCoverage: CheckCoverage[] = [
  { check: "Component placement overlap and courtyard overlap", source: "tscircuit-checks" },
  { check: "Footprint overlap", source: "tscircuit-checks" },
  { check: "Components and traces outside the board, and over cutouts", source: "tscircuit-checks" },
  { check: "Missing courtyards", source: "tscircuit-checks" },
  { check: "Pad-to-pad and pad-to-trace clearance", source: "tscircuit-checks" },
  { check: "Via-to-pad, via-to-trace, and different-net via spacing", source: "tscircuit-checks" },
  { check: "Hole-to-trace clearance", source: "tscircuit-checks" },
  { check: "Copper-to-board-edge clearance", source: "tscircuit-checks" },
  { check: "Copper pour shorts", source: "tscircuit-checks" },
  { check: "Vias in pads and vias off the board", source: "tscircuit-checks" },
  { check: "Keepout violations by copper and courtyards", source: "tscircuit-checks" },
  { check: "Test point accessibility", source: "tscircuit-checks" },
  { check: "Minimum trace width, non-plated hole size, via hole, via diameter, and annular ring", source: "fabricator-profile", caveat: "Checked against the selected profile by check_manufacturability; board defaults check nothing." },
]

export const designNotEvaluated = [
  {
    check: "Footprint compatibility with the manufacturer land pattern",
    reason: "Footprints are not compared with manufacturer land patterns. When a resolved supplier part disagrees with the footprint, the build's own supplier_footprint_mismatch_warning is surfaced instead.",
  },
  {
    check: "Layer stackup and copper weight",
    reason: "Circuit JSON does not describe the fabricated stackup, so copper thickness is assumed rather than checked. A profile compares only the declared layer count and material.",
  },
  {
    check: "Soldermask and silkscreen manufacturability",
    reason: "Not implemented. Mask slivers, silkscreen over pads, and minimum mask dam are not measured.",
  },
]

export const routingCoverage: CheckCoverage[] = [
  { check: "Source traces without a routed PCB trace", source: "tscircuit-checks" },
  { check: "Trace contiguity and self-shorts", source: "tscircuit-checks" },
  { check: "Overlapping PCB traces", source: "tscircuit-checks" },
  { check: "Trace style, trace length, and via count limits", source: "tscircuit-checks" },
  { check: "Source trace to PCB trace thickness agreement", source: "tscircuit-checks" },
  { check: "Bus length skew and routing constraints", source: "tscircuit-checks" },
  { check: "Per-net routing state and copper reach", source: "workbench", caveat: "get_net_trace reports which pins copper actually reaches, per net." },
]

export const routingNotEvaluated = [
  {
    check: "Impedance and signal integrity",
    reason: "Not implemented. tscircuit emits no stackup or dielectric data to calculate from.",
  },
  {
    check: "Fabricator routing limits",
    reason: "Trace width, hole, and via limits for a chosen fabricator are checked by check_manufacturability against a selected profile.",
  },
]
