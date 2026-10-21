#!/usr/bin/env bash
set -euo pipefail

base_url=${BASE_URL:-http://127.0.0.1:3000}
project_json=$(curl --fail --silent --show-error \
  -H 'Content-Type: application/json' \
  -d '{"name":"Container acceptance circuit","templateId":"footprint-comparison"}' \
  "$base_url/api/projects")
project_id=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).id)' "$project_json")
entrypoint=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).entrypoint)' "$project_json")

wait_for_build() {
  expected_revision=$1
  for attempt in $(seq 1 90); do
    project_state=$(curl --fail --silent --show-error "$base_url/api/projects/$project_id")
    current_revision=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).revision)' "$project_state")
    build_revision=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).lastBuild?.revision ?? "")' "$project_state")
    build_state=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).lastBuild?.status ?? "none")' "$project_state")
    if [ "$current_revision" = "$expected_revision" ] && [ "$build_revision" = "$expected_revision" ]; then
      case "$build_state" in
        ready|failed) printf '%s\n' "$project_state"; return ;;
      esac
    fi
    sleep 2
  done
  printf 'Timed out waiting for build at revision %s\n' "$expected_revision" >&2
  printf '%s\n' "$project_state" >&2
  return 1
}

assert_ready() {
  state=$1
  status=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).lastBuild?.status ?? "none")' "$state")
  if [ "$status" != ready ]; then
    printf 'Expected ready build, got %s: %s\n' "$status" "$state" >&2
    return 1
  fi
}

assert_circuit_previews() {
  revision=$1
  for kind in schematic pcb 3d; do
    preview=$(curl --fail --silent --show-error \
      "$base_url/api/projects/$project_id/preview?kind=$kind")
    node -e '
      const result = JSON.parse(process.argv[1]);
      const records = result.circuitJson;
      if (result.kind !== process.argv[2] || result.revision !== process.argv[3] || !Array.isArray(records)) process.exit(1);
      const types = (type) => records.filter((item) => item.type === type);
      for (const name of ["J1", "C1", "R1", "D1", "R2"]) {
        if (!types("source_component").some((item) => item.name === name)) throw new Error(`${process.argv[2]} missing component ${name}`);
      }
      if (types("source_component").find((item) => item.name === "R1")?.resistance !== 2000) {
        throw new Error(`${process.argv[2]} did not update R1 to 2kΩ`);
      }
      for (const net of ["VIN", "SIGNAL", "GND"]) {
        if (!types("source_trace").some((item) => item.name === net)) throw new Error(`${process.argv[2]} missing the ${net} net`);
      }
      if (!types("pcb_board").length || types("pcb_component").length < 5) throw new Error(`${process.argv[2]} missing board/component layout data`);
      if (types("schematic_component").length < 5 || !types("schematic_trace").length) {
        throw new Error(`${process.argv[2]} missing schematic rendering data`);
      }
      if (types("cad_component").length < 5) throw new Error(`${process.argv[2]} missing 3D component data`);
      if (!types("pcb_trace").length) throw new Error(`${process.argv[2]} missing routed PCB trace data`);
    ' "$preview" "$kind" "$revision"
  done
}

initial_revision=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).revision)' "$project_json")
initial_state=$(wait_for_build "$initial_revision")
assert_ready "$initial_state"

events_log=$(mktemp)
curl --no-buffer --silent --show-error --max-time 600 \
  -H 'Accept: text/event-stream' \
  "$base_url/api/projects/$project_id/events" > "$events_log" &
events_pid=$!
# Detach the reader so terminating it at exit does not print a job-control notice.
disown "$events_pid" 2>/dev/null || true
cleanup() {
  kill "$events_pid" >/dev/null 2>&1 || true
  rm -f "$events_log"
}
trap cleanup EXIT

file_json=$(curl --fail --silent --show-error \
  "$base_url/api/projects/$project_id/files?path=$entrypoint")
source=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).content)' "$file_json")
revision=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).revision)' "$file_json")
# The representative acceptance circuit: power input header, decoupling,
# current-limited LED, a divider leg, and three named nets across the board.
# Every part names a built-in footprint, because build containers have no
# network and cannot fetch supplier footprints.
edited_source=$(node -e '
  const source = `export default () => (
  <board name="Container acceptance circuit" width="30mm" height="16mm">
    <pinheader name="J1" pinCount={2} footprint="pinrow2" pinLabels={["VIN", "GND"]} pcbX={-11.5} pcbY={0} schX={-8} schY={0} />
    <capacitor name="C1" capacitance="10uF" footprint="0805" pcbX={-6} pcbY={0} schX={-5} schY={0} />
    <resistor name="R1" resistance="2k" footprint="0603" pcbX={0} pcbY={0} schX={-2} schY={0} />
    <led name="D1" footprint="0603" pcbX={6} pcbY={0} schX={2} schY={0} />
    <resistor name="R2" resistance="10k" footprint="0603" pcbX={11} pcbY={0} schX={5} schY={0} />
    <trace from=".J1 > .VIN" to=".C1 > .pin1" name="VIN" />
    <trace from=".C1 > .pin1" to=".R1 > .pin1" name="VIN" />
    <trace from=".R1 > .pin2" to=".D1 > .anode" name="SIGNAL" />
    <trace from=".D1 > .anode" to=".R2 > .pin1" name="SIGNAL" />
    <trace from=".J1 > .GND" to=".C1 > .pin2" name="GND" />
    <trace from=".C1 > .pin2" to=".D1 > .cathode" name="GND" />
    <trace from=".D1 > .cathode" to=".R2 > .pin2" name="GND" />
    <schematicsheet name="Main" displayName="Main" sheetIndex={0}>
      <schematictext text="Container acceptance" schX={0} schY={6} />
    </schematicsheet>
  </board>
)`;
  if (!process.argv[1].includes("R6")) throw new Error("footprint-comparison template was not loaded");
  process.stdout.write(source);
' "$source")
edit_json=$(node -e 'process.stdout.write(JSON.stringify({content: process.argv[1], revision: process.argv[2]}))' "$edited_source" "$revision")
saved=$(curl --fail --silent --show-error -X PUT \
  -H 'Content-Type: application/json' -H "If-Match: $revision" \
  -d "$edit_json" \
  "$base_url/api/projects/$project_id/files?path=$entrypoint")
edited_revision=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).revision)' "$saved")
edited_state=$(wait_for_build "$edited_revision")
assert_ready "$edited_state"
assert_circuit_previews "$edited_revision"

invalid_source=$(node -e '
  const source = process.argv[1];
  if (!source.includes("resistance=\"2k\"")) throw new Error("Could not locate R1 value for deliberate syntax error");
  process.stdout.write(source.replace("resistance=\"2k\"", "resistance={"));
' "$edited_source")
invalid_json=$(node -e 'process.stdout.write(JSON.stringify({content: process.argv[1], revision: process.argv[2]}))' "$invalid_source" "$edited_revision")
invalid_saved=$(curl --fail --silent --show-error -X PUT \
  -H 'Content-Type: application/json' -H "If-Match: $edited_revision" \
  -d "$invalid_json" \
  "$base_url/api/projects/$project_id/files?path=$entrypoint")
invalid_revision=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).revision)' "$invalid_saved")
failed_state=$(wait_for_build "$invalid_revision")
node -e '
  const build = JSON.parse(process.argv[1]).lastBuild;
  if (build?.status !== "failed" || !Array.isArray(build.diagnostics) ||
      !build.diagnostics.some((item) => item.severity === "error" && typeof item.message === "string" && item.message.length > 0)) {
    throw new Error(`Expected actionable diagnostics after invalid source: ${JSON.stringify(build)}`);
  }
' "$failed_state"

assert_preview_retained() {
  retained_revision=$1
  preview=$(curl --fail --silent --show-error \
    "$base_url/api/projects/$project_id/preview?kind=pcb")
  node -e '
    const result = JSON.parse(process.argv[1]);
    if (!Array.isArray(result.circuitJson) || !result.circuitJson.length) {
      throw new Error("Preview data was discarded while the build was failing");
    }
    if (result.revision !== process.argv[2]) {
      throw new Error(`Preview moved to ${result.revision} instead of staying on the last successful ${process.argv[2]}`);
    }
  ' "$preview" "$retained_revision"
}

assert_preview_retained "$edited_revision"

corrected_source=$(node -e '
  const source = process.argv[1];
  if (!source.includes("resistance={")) throw new Error("Could not locate deliberate syntax error");
  process.stdout.write(source.replace("resistance={", "resistance=\"2k\""));
' "$invalid_source")
corrected_json=$(node -e 'process.stdout.write(JSON.stringify({content: process.argv[1], revision: process.argv[2]}))' "$corrected_source" "$invalid_revision")
corrected_saved=$(curl --fail --silent --show-error -X PUT \
  -H 'Content-Type: application/json' -H "If-Match: $invalid_revision" \
  -d "$corrected_json" \
  "$base_url/api/projects/$project_id/files?path=$entrypoint")
corrected_revision=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).revision)' "$corrected_saved")
corrected_state=$(wait_for_build "$corrected_revision")
assert_ready "$corrected_state"
assert_circuit_previews "$corrected_revision"

assert_live_updates() {
  for attempt in $(seq 1 30); do
    if grep -q '^event: file$' "$events_log" && grep -q '^event: build.ready$' "$events_log"; then
      return
    fi
    sleep 1
  done
  printf 'Event stream did not deliver file and build.ready events. Received:\n' >&2
  sort -u "$events_log" >&2
  return 1
}

assert_simulation_status() {
  simulation=$(curl --fail --silent --show-error "$base_url/api/projects/$project_id/simulation")
  node -e '
    const result = JSON.parse(process.argv[1]);
    if (!["complete", "failed", "not_configured"].includes(result.status)) {
      throw new Error(`Unexpected simulation status: ${JSON.stringify(result)}`);
    }
  ' "$simulation"
}

assert_manufacturing_package() {
  profiles=$(curl --fail --silent --show-error "$base_url/api/manufacturing/profiles")
  profile=$(node -e '
    const result = JSON.parse(process.argv[1]);
    if (!Array.isArray(result.profiles) || !result.profiles.length) throw new Error("No fabricator rule profiles are available");
    process.stdout.write(result.profiles[0].id);
  ' "$profiles")
  report=$(curl --fail --silent --show-error \
    "$base_url/api/projects/$project_id/manufacturing?profile=$profile")
  ready=$(node -e '
    const preflight = JSON.parse(process.argv[1]).preflight;
    if (!Array.isArray(preflight?.checks) || !preflight.checks.length) throw new Error("Preflight returned no checks");
    process.stdout.write(preflight.ready ? "ready" : "blocked");
  ' "$report")
  archive=$(mktemp)
  status=$(curl --silent --show-error --output "$archive" --write-out '%{http_code}' \
    "$base_url/api/projects/$project_id/manufacturing.zip?profile=$profile")
  # The export must agree with its own preflight verdict in both directions.
  if [ "$ready" = ready ]; then
    if [ "$status" != 200 ]; then
      printf 'Export returned %s even though preflight was ready\n' "$status" >&2
      rm -f "$archive"
      return 1
    fi
    node -e '
      const { readFileSync } = require("node:fs");
      const archive = readFileSync(process.argv[1]);
      if (archive[0] !== 0x50 || archive[1] !== 0x4b) throw new Error("Downloaded manufacturing file is not a ZIP archive");
      if (archive.byteLength < 1024) throw new Error(`Manufacturing archive is only ${archive.byteLength} bytes`);
    ' "$archive"
  else
    if [ "$status" != 422 ]; then
      printf 'Blocked preflight returned %s instead of 422\n' "$status" >&2
      rm -f "$archive"
      return 1
    fi
    node -e '
      const { readFileSync } = require("node:fs");
      const refusal = JSON.parse(readFileSync(process.argv[1], "utf8"));
      if (!refusal.preflight?.checks?.some((check) => check.status === "fail")) {
        throw new Error(`Refused export did not report a failing check: ${JSON.stringify(refusal)}`);
      }
    ' "$archive"
  fi
  rm -f "$archive"
  printf 'Manufacturing preflight reported %s and the export agreed.\n' "$ready"
}

assert_net_tracing() {
  nets=$(curl --fail --silent --show-error "$base_url/api/projects/$project_id/nets")
  node -e '
    const result = JSON.parse(process.argv[1]);
    if (result.revision !== process.argv[2]) throw new Error(`Net index is at ${result.revision}, expected ${process.argv[2]}`);
    for (const name of ["VIN", "SIGNAL", "GND"]) {
      const net = result.nets.find((item) => item.name === name);
      if (!net) throw new Error(`Net ${name} is missing from the net index: ${result.nets.map((item) => item.name).join(", ")}`);
      if (net.pins.length < 2) throw new Error(`Net ${name} reported ${net.pins.length} pins`);
      if (!net.copperTraces.length) throw new Error(`Net ${name} reported no copper traces`);
    }
    const ground = result.nets.find((item) => item.name === "GND");
    if (!ground.pins.some((pin) => pin.componentName === "J1")) throw new Error("GND does not reach the power connector");
    if (!Array.isArray(result.limitations) || !result.limitations.length) throw new Error("Net index reported no limitations");
  ' "$nets" "$1"
}

assert_power_analysis() {
  power=$(curl --fail --silent --show-error "$base_url/api/projects/$project_id/power")
  node -e '
    const result = JSON.parse(process.argv[1]);
    if (!["partial", "complete", "not-evaluated"].includes(result.status)) throw new Error(`Unexpected power status: ${result.status}`);
    if (!result.traceCapacity.length || !result.narrowestTrace) throw new Error("Power analysis reported no routed trace capacity");
    if (!(result.narrowestTrace.maxCurrentA > 0)) throw new Error("Narrowest trace has no current capacity");
    // This circuit has no simulation, so operating-point quantities must stay unevaluated.
    for (const quantity of ["Component power dissipation", "Thermal rise of components and planes"]) {
      if (!result.notEvaluated.some((item) => item.quantity === quantity)) throw new Error(`Power analysis did not report ${quantity} as not evaluated`);
    }
  ' "$power"
}

assert_component_sourcing_disabled() {
  cost=$(curl --fail --silent --show-error "$base_url/api/projects/$project_id/bom-cost")
  node -e '
    const result = JSON.parse(process.argv[1]);
    if (result.configured !== false) throw new Error("Component sourcing should be disabled unless COMPONENT_SOURCING_URL is set");
    if (!Array.isArray(result.parts) || result.parts.length < 4) throw new Error(`Expected the design parts list, received ${JSON.stringify(result).slice(0, 200)}`);
  ' "$cost"
  status=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' "$base_url/api/components/C2040")
  if [ "$status" != 503 ]; then
    printf 'Component lookup returned %s instead of 503 while sourcing is disabled\n' "$status" >&2
    return 1
  fi
}

assert_history_and_design_diff() {
  history=$(curl --fail --silent --show-error "$base_url/api/projects/$project_id/history")
  node -e '
    const result = JSON.parse(process.argv[1]);
    if (result.gitBacked !== true) throw new Error("Container history should be Git-backed; git is installed in the runtime image");
    if (result.revisions.length < 3) throw new Error(`Expected several revisions, received ${result.revisions.length}`);
    if (!result.revisions.every((item) => typeof item.commit === "string" && item.commit.length >= 7)) {
      throw new Error("Every revision should carry a Git commit");
    }
  ' "$history"
  from=$(node -e '
    const revisions = JSON.parse(process.argv[1]).revisions.filter((item) => item.hasDesignSummary);
    if (revisions.length < 2) throw new Error("Expected build summaries for at least two revisions");
    process.stdout.write(revisions.at(-1).revision);
  ' "$history")
  to=$(node -e '
    const revisions = JSON.parse(process.argv[1]).revisions.filter((item) => item.hasDesignSummary);
    process.stdout.write(revisions[0].revision);
  ' "$history")
  comparison=$(curl --fail --silent --show-error \
    "$base_url/api/projects/$project_id/history/compare?from=$from&to=$to")
  node -e '
    const result = JSON.parse(process.argv[1]);
    if (!result.files.length) throw new Error("Revision comparison reported no changed source files");
    if (result.design.available !== true) throw new Error(`Design comparison unavailable: ${result.design.reason}`);
    const added = result.design.components.added.map((item) => item.name);
    for (const name of ["D1", "J1"]) {
      if (!added.includes(name)) throw new Error(`Design comparison did not report ${name} as added: ${added.join(", ")}`);
    }
    if (!result.design.limitations.length) throw new Error("Design comparison reported no limitations");
  ' "$comparison"
}

assert_project_assertions() {
  current_state=$(curl --fail --silent --show-error "$base_url/api/projects/$project_id")
  current=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).revision)' "$current_state")
  body=$(node -e '
    const assertions = {
      version: 1,
      assertions: {
        nets_connected: ["VIN", "SIGNAL", "GND"],
        components_present: ["J1", "R1", "D1"],
        design_check_findings_must_not_increase: true,
        max_component_cost_usd: 25,
      },
    };
    process.stdout.write(JSON.stringify({ revision: process.argv[1], assertions }));
  ' "$current")
  saved_assertions=$(curl --fail --silent --show-error -X PUT \
    -H 'Content-Type: application/json' -H "If-Match: $current" \
    -d "$body" \
    "$base_url/api/projects/$project_id/assertions")
  assertion_revision=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).revision)' "$saved_assertions")
  assertion_state=$(wait_for_build "$assertion_revision")
  assert_ready "$assertion_state"

  report=$(curl --fail --silent --show-error "$base_url/api/projects/$project_id/assertions/check")
  node -e '
    const result = JSON.parse(process.argv[1]);
    if (result.configured !== true) throw new Error(`Assertions were not configured: ${JSON.stringify(result)}`);
    const byId = Object.fromEntries(result.report.results.map((item) => [item.id, item]));
    for (const net of ["VIN", "SIGNAL", "GND"]) {
      const check = byId[`net-connected-${net}`];
      if (check?.status !== "pass") throw new Error(`Net assertion for ${net} reported ${check?.status}: ${check?.message}`);
    }
    for (const component of ["J1", "R1", "D1"]) {
      const check = byId[`component-present-${component}`];
      if (check?.status !== "pass") throw new Error(`Component assertion for ${component} reported ${check?.status}: ${check?.message}`);
    }
    // The design-check comparison needs an earlier retained build summary, which this run has.
    if (byId["design-check-findings"]?.status !== "pass") {
      throw new Error(`Design check comparison reported ${byId["design-check-findings"]?.status}: ${byId["design-check-findings"]?.message}`);
    }
    // Component sourcing is disabled in the container, so the cost budget must not pass.
    if (byId["max-component-cost"]?.status !== "not-evaluated") {
      throw new Error(`Cost budget reported ${byId["max-component-cost"]?.status} without a sourcing provider`);
    }
    if (result.report.failed !== 0) throw new Error(`Assertions failed: ${JSON.stringify(result.report.results.filter((item) => item.status === "fail"))}`);
  ' "$report"

  preflight=$(curl --fail --silent --show-error "$base_url/api/projects/$project_id/manufacturing")
  node -e '
    const check = JSON.parse(process.argv[1]).preflight.checks.find((item) => item.id === "regression-assertions");
    if (!check) throw new Error("Preflight did not report the regression-assertions check");
    if (check.status === "fail") throw new Error(`Passing assertions were reported as a preflight failure: ${check.message}`);
  ' "$preflight"
  printf 'Project assertions passed and preflight reported them as %s.\n' "$(node -e '
    process.stdout.write(JSON.parse(process.argv[1]).preflight.checks.find((item) => item.id === "regression-assertions").status)
  ' "$preflight")"
}

assert_live_updates
assert_simulation_status
assert_net_tracing "$corrected_revision"
assert_power_analysis
assert_component_sourcing_disabled
assert_history_and_design_diff
assert_project_assertions
assert_manufacturing_package

printf 'Container acceptance passed for project %s through edit, live updates, diagnostics, preview retention, recovery, simulation status, net tracing, power analysis, disabled component sourcing, Git-backed history with design comparison, project assertions, manufacturing preflight and export, and all preview endpoints.\n' "$project_id"
