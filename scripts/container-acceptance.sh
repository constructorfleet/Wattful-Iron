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
      for (const name of ["R1", "R2"]) {
        if (!types("source_component").some((item) => item.name === name)) throw new Error(`${process.argv[2]} missing component ${name}`);
      }
      if (types("source_component").find((item) => item.name === "R1")?.resistance !== 2000) {
        throw new Error(`${process.argv[2]} did not update R1 to 2kΩ`);
      }
      if (!types("source_trace").some((item) => item.name === "SIGNAL")) throw new Error(`${process.argv[2]} missing the SIGNAL net`);
      if (!types("pcb_board").length || types("pcb_component").length < 2) throw new Error(`${process.argv[2]} missing board/component layout data`);
      if (types("schematic_component").length < 2 || !types("schematic_trace").length) {
        throw new Error(`${process.argv[2]} missing schematic rendering data`);
      }
      if (types("cad_component").length < 2) throw new Error(`${process.argv[2]} missing 3D component data`);
      if (!types("pcb_trace").length) throw new Error(`${process.argv[2]} missing routed PCB trace data`);
    ' "$preview" "$kind" "$revision"
  done
}

initial_revision=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).revision)' "$project_json")
initial_state=$(wait_for_build "$initial_revision")
assert_ready "$initial_state"

file_json=$(curl --fail --silent --show-error \
  "$base_url/api/projects/$project_id/files?path=$entrypoint")
source=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).content)' "$file_json")
revision=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).revision)' "$file_json")
edited_source=$(node -e '
  const source = `export default () => (
  <board name="Container acceptance circuit" width="20mm" height="12mm">
    <resistor name="R1" resistance="2k" footprint="0603" pcbX={-3} pcbY={0} schX={-2} schY={0} />
    <resistor name="R2" resistance="10k" footprint="0603" pcbX={3} pcbY={0} schX={2} schY={0} />
    <trace from=".R1 > .pin2" to=".R2 > .pin1" name="SIGNAL" />
    <schematicsheet name="Main" displayName="Main" sheetIndex={0}>
      <schematictext text="Container acceptance" schX={0} schY={5} />
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

printf 'Container acceptance passed for project %s through edit, diagnostics, recovery, and all preview endpoints.\n' "$project_id"
