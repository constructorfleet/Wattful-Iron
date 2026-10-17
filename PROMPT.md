# Project: AI-Native, Self-Hosted Electronics Design Workbench

## Mission

Build a production-quality, self-hosted electronics design platform based on **tscircuit**, distributed as Docker images through GitHub Container Registry (GHCR).

The platform should enable users and AI agents to collaboratively design, simulate, validate, visualize, refine, and manufacture electronic circuits and printed circuit boards.

The desired workflow is:

**Natural-language specification → Circuit generation → Live visualization → Simulation → Validation → PCB layout → Manufacturing preparation → Fabrication**

The result should combine the strengths of:

- **EasyEDA:** Visual electronics design, component selection, PCB fabrication.
- **tscircuit:** Declarative, code-first circuit generation.
- **VS Code:** Live development environment with immediate feedback.
- **KiCad:** Professional engineering validation and manufacturing outputs.
- **AI coding agents:** Natural-language generation, modification, debugging, and refinement.

Users should be able to describe what they want to build, inspect the resulting designs visually, request modifications, and ultimately produce manufacturing-ready files.

**This is intended to become a daily-use engineering tool, not merely a proof of concept.**

---

## 1. Core Engineering Principles

### Reuse Before Reimplementation

**DO NOT build a custom PCB renderer, autorouter, schematic renderer, SPICE engine, or 3D visualization engine unless there is an exceptionally compelling technical reason.**

These are complex engineering disciplines with substantial existing implementations.

Before implementing any substantial functionality:

1. Determine whether tscircuit already provides it.
2. Investigate maintained open-source libraries providing it.
3. Evaluate integrating those capabilities through existing APIs.
4. Prefer upstream contributions or adapters over forks.
5. Only implement custom functionality when integration is demonstrably insufficient.

Avoid duplicating existing engineering functionality merely to obtain tighter integration.

Use existing tscircuit components and libraries wherever possible.

Relevant projects:

- https://github.com/tscircuit/tscircuit
- https://github.com/tscircuit/cli
- https://github.com/tscircuit/tscircuit.com
- https://github.com/tscircuit/runframe
- https://github.com/tscircuit/skill
- https://docs.tscircuit.com/

Investigate upstream source code and documentation before making architectural decisions.

Do not assume undocumented capabilities exist.

### Architectural Requirements

The platform must be:

- Fully self-hosted.
- Dockerized.
- Browser-accessible.
- Designed for AI-agent integration.
- Compatible with locally hosted LLMs.
- Usable without cloud AI services.
- Capable of offline operation, except for optional external services.
- Backed by persistent, version-controlled project storage.
- Modular and extensible.
- Maintainable without excessive infrastructure.

**TypeScript/TSX must remain the authoritative editable source.**

Use Circuit JSON as the canonical generated intermediate representation for visualization, inspection, validation, simulation integration, and manufacturing exports.

Avoid maintaining competing circuit models that can become inconsistent.

---

## 2. Core tscircuit Integration

Build the platform around existing tscircuit packages and CLI functionality.

Support:

- Project creation and initialization.
- Circuit generation.
- TypeScript/TSX editing.
- Schematic generation.
- PCB layout and routing.
- Electrical connectivity inspection.
- Design validation.
- Schematic visualization.
- PCB visualization.
- Interactive 3D PCB visualization.
- Manufacturing exports.
- Reusable components and libraries.

### Live Preview System

**Live updates are mandatory.**

Whenever project source files change, automatically rebuild and update the associated previews.

Changes may originate from:

- Browser-based editing.
- AI agents.
- MCP tool calls.
- ACP-connected agents.
- External editors.
- Filesystem modifications.
- Parametric adjustments.

The system must provide synchronized views for:

#### Schematic

- Components and connections.
- Reference designators.
- Component values.
- Electrical nets.
- Pin assignments.
- Power connections.

#### PCB

- Board outline.
- Component placement.
- Copper layers.
- Traces and vias.
- Mounting holes.
- Silkscreen.
- Solder mask.
- Routing status.

#### 3D

- Interactive rotation, zoom, and pan.
- Component models.
- Board thickness.
- Connector positions.
- Top and bottom views.
- Dimensions and mechanical clearances.

### Live Update Requirements

Implement reliable filesystem watching and incremental updates where supported.

Requirements:

1. Debounce rapid changes.
2. Avoid redundant builds.
3. Cancel or supersede obsolete builds.
4. Preserve the last successful preview when compilation fails.
5. Display actionable compiler and validation diagnostics.
6. Broadcast updates through WebSockets or SSE.
7. Support multiple connected browser clients.
8. Prevent concurrent modifications from silently overwriting changes.
9. Preserve user viewport and selection state when previews update.

Display build status:

`Idle → Compiling → Validating → Routing → Rendering → Ready`

Where supported, link diagnostics to relevant source locations, components, or nets.

---

## 3. Browser-Based Development Environment

Create a unified browser interface containing:

### Project Explorer

- Create projects.
- Open existing projects.
- Duplicate projects.
- Rename projects.
- Delete projects.
- Browse project files.
- Import and export projects.
- Manage dependencies.
- Display project metadata.

### Source Editor

Integrate Monaco or another suitable browser-based editor.

Support:

- TypeScript/TSX syntax highlighting.
- Autocomplete.
- Type checking.
- Diagnostics.
- Search and replace.
- Multi-file editing.
- Unsaved-change indicators.

### Visualization Workspace

Provide resizable, configurable panels for:

- Schematic.
- PCB layout.
- 3D board rendering.
- Simulation waveforms.
- Component inspector.
- Build diagnostics.
- Agent interaction.

Support side-by-side views.

Users should be able to inspect schematic, PCB, and 3D representations simultaneously.

### Component Inspector

Selecting a component should display:

- Reference designator.
- Manufacturer part number.
- Electrical specifications.
- Footprint.
- Pinout.
- Connections.
- Datasheet.
- Supplier information.
- Availability.
- Estimated cost.

Where practical, permit visual property changes that safely update the authoritative TypeScript/TSX source.

---

## 4. MCP and ACP Integration

Expose platform capabilities to external AI agents.

Implement **Model Context Protocol (MCP)** as a core integration.

Investigate **Agent Client Protocol (ACP)** for agent session management and embedded agent interactions.

MCP is mandatory.

ACP is optional if the available implementations do not justify its complexity.

### MCP Tools

Provide structured, documented tools.

The following names represent the desired API surface, not necessarily existing tscircuit commands.

#### Project Management

```text
list_projects
create_project
open_project
get_project_files
read_project_file
update_project_file
```

#### Circuit Generation

```text
create_circuit
modify_circuit
add_component
remove_component
connect_components
set_component_properties
set_board_dimensions
```

#### Circuit Inspection

```text
list_components
get_component
list_nets
trace_net
get_pin_connections
get_board_properties
get_circuit_json
```

#### Validation

```text
build_circuit
validate_circuit
run_erc
run_drc
check_connectivity
check_routing
get_diagnostics
```

#### Visualization

```text
render_schematic
render_pcb
render_3d
get_preview_url
capture_snapshot
```

#### Simulation

```text
run_simulation
list_simulation_signals
get_simulation_results
trace_signal
get_waveform
```

#### Manufacturing

```text
generate_gerbers
generate_bom
generate_pick_and_place
generate_manufacturing_package
check_manufacturability
estimate_manufacturing_cost
```

Every tool must provide:

- Documented JSON schemas.
- Structured responses.
- Input validation.
- Predictable errors.
- Appropriate timeouts.
- Machine-readable diagnostics.
- Authentication and authorization boundaries.

### Agent Compatibility

Support external agents including:

- Claude Code.
- OpenAI Codex.
- MCP-compatible agents.
- Ollama-backed local agents.
- Compatible ACP clients.

Avoid hard dependencies on specific AI providers.

### Structured Agent Context

Provide agents access to:

- Project requirements.
- Circuit source files.
- Generated Circuit JSON.
- Electrical nets.
- Component metadata.
- Board constraints.
- Build diagnostics.
- Simulation results.
- Manufacturing requirements.

Prefer structured engineering information over screenshots.

### Agent Safety

Agents must not automatically:

- Submit manufacturing orders.
- Purchase components.
- Delete projects.
- Overwrite conflicting modifications.
- Modify approved manufacturing revisions.

Require explicit authorization for destructive or financially consequential operations.

---

## 5. Circuit Simulation and Tracing

Integrate circuit simulation directly into the platform.

Prioritize existing tscircuit simulation capabilities and maintained ngspice integrations.

**Do not implement a custom circuit simulation engine.**

### Supported Analysis Modes

Investigate and implement applicable capabilities:

#### DC Analysis

- Node voltages.
- Branch currents.
- Operating points.
- Power dissipation.

#### Transient Analysis

- Voltage over time.
- Current over time.
- Signal transitions.
- Capacitor charging.
- Oscillations.

#### AC Analysis

- Frequency response.
- Gain.
- Phase.
- Filter behavior.
- Bode plots.

#### Parameter Analysis

- Component-value sweeps.
- Supply-voltage variations.
- Temperature variations where supported.
- Monte Carlo tolerance analysis where feasible.

### Waveform Viewer

Provide an interactive browser-based waveform viewer supporting:

- Multiple signals.
- Zoom and pan.
- Measurement cursors.
- Voltage and current scales.
- Time measurements.
- Frequency measurements.
- Data export.

### Interactive Net Tracing

Implement cross-probing between representations.

Selecting a net should highlight:

- Connected schematic wires.
- Connected component pins.
- PCB copper traces.
- Relevant vias.
- Associated simulation signals.

Selecting a component should highlight it across schematic, PCB, and 3D views.

Distinguish connectivity tracing from simulation of actual electrical signal propagation.

### Mixed-Signal and Digital Simulation

Investigate integration with established tools such as:

- Verilator.
- Icarus Verilog.
- Existing digital logic simulators.
- Firmware emulators.
- Hardware-in-the-loop tools.

Do not claim SPICE can accurately emulate arbitrary microcontroller firmware.

Clearly identify unsupported simulation scenarios.

---

## 6. Engineering Validation

A circuit that renders successfully is not necessarily electrically correct.

Provide automated engineering checks using existing validated libraries wherever possible.

### Electrical Rule Checking

Investigate support for:

- Unconnected pins.
- Conflicting outputs.
- Missing required connections.
- Power/ground connectivity.
- Voltage-domain conflicts.
- Component rating violations.
- Suspicious electrical configurations.

### PCB Design Rule Checking

Support applicable checks for:

- Minimum trace widths.
- Copper clearances.
- Via dimensions.
- Copper-to-board-edge clearance.
- Component overlaps.
- Unrouted connections.
- Footprint compatibility.
- Board dimensions.
- Manufacturing constraints.

### Power Analysis

Estimate:

- Total current requirements.
- Regulator loading.
- Power dissipation.
- Resistor power ratings.
- Trace current capacity.
- Thermal concerns.

Use engineering calculations and manufacturer specifications.

Never substitute LLM-generated guesses for validated electrical calculations.

### Validation Results

Provide both human-readable and machine-readable reports.

Severity levels:

- Error.
- Warning.
- Informational.

Allow agents to inspect validation failures and iteratively correct designs.

Passing automated validation does not prove a circuit is electrically safe or fit for manufacture.

---

## 7. Component Libraries and Sourcing

Investigate integration with:

- tscircuit component registries.
- JLCPCB.
- LCSC.
- DigiKey.
- Mouser.
- Octopart/Nexar.
- KiCad libraries.

Use supported APIs and comply with licensing and usage restrictions.

### Component Discovery

Support searching by:

- Manufacturer.
- Part number.
- Electrical function.
- Electrical parameters.
- Package.
- Footprint.
- Availability.
- Price.

### Manufacturer Preferences

Allow project-level configuration such as:

```yaml
manufacturing:
  preferred_fabricator: jlcpcb
  preferred_assembler: jlcpcb

components:
  prefer_in_stock: true
  prefer_basic_assembly_parts: true
  allow_substitutions: true
  require_approved_substitutions: true
```

This is a proposed configuration format, not an existing tscircuit standard.

### Substitution Recommendations

Suggest alternatives based on:

- Electrical compatibility.
- Pin compatibility.
- Package.
- Footprint.
- Availability.
- Cost.

Never assume components are interchangeable solely because they share a footprint.

---

## 8. Manufacturing Integration

Generate manufacturing-ready artifacts using existing tscircuit capabilities.

### Required Exports

- Gerber files.
- Drill files.
- Bill of materials.
- Pick-and-place files.
- Assembly drawings where supported.
- Schematic exports.
- PCB images.
- 3D models where supported.
- Native source files.
- Manufacturing notes.

Provide a downloadable manufacturing ZIP.

### Manufacturing Preflight

Check:

- Successful compilation.
- Electrical validation.
- PCB design rules.
- Routed connections.
- Board dimensions.
- Layer stackup.
- Component footprints.
- BOM completeness.
- Component availability.
- Placement file completeness.

Flag unsupported checks rather than reporting false passes.

### Fabricator Integration

Investigate:

- JLCPCB.
- PCBWay.
- Other manufacturers with documented integration APIs.

Desired capabilities:

- Manufacturing design-rule presets.
- Component inventory checks.
- Assembly compatibility.
- Price estimates.
- Manufacturing-package preparation.

Direct ordering is optional initially.

Do not automate undocumented checkout processes through website scraping.

Any paid manufacturing order must require explicit user approval.

---

## 9. Docker Architecture

Package the application as reproducible Docker images.

Avoid unnecessary service fragmentation.

A reasonable initial architecture:

```text
Browser
   |
   v
Web Application
   |
   +--- Project Management
   |
   +--- Live Preview Engine
   |       |
   |       +--- tscircuit CLI
   |       +--- Circuit JSON
   |       +--- Schematic Renderer
   |       +--- PCB Renderer
   |       +--- 3D Renderer
   |
   +--- Simulation Engine
   |       |
   |       +--- ngspice
   |       +--- Waveform Data
   |
   +--- MCP Server
   |
   +--- Agent Integration
   |
   +--- Manufacturing Services
   |
   v
Persistent Project Storage
```

Evaluate whether services should share containers or run separately based on isolation and resource requirements.

### Container Requirements

- Multi-stage Dockerfiles.
- Reproducible builds.
- Pinned dependencies.
- AMD64 support.
- ARM64 support where feasible.
- Persistent volumes.
- Non-root execution.
- Health checks.
- Graceful shutdown.
- Configurable logging.
- Resource limits.

### Deployment Requirements

Provide:

- Docker Compose configuration.
- Docker Swarm stack configuration.
- `.env.example`.
- Traefik integration.
- Persistent storage configuration.
- Reverse proxy documentation.
- TLS termination support.
- WebSocket compatibility.

### Security

Treat user-controlled TypeScript and agent-generated code as potentially untrusted execution.

Requirements:

- No unrestricted host filesystem access.
- Isolated project build environments.
- Authenticated MCP endpoints.
- Restricted execution permissions.
- Input validation.
- Resource limits.
- Safe handling of project dependencies.

Investigate suitable sandboxing mechanisms.

Do not assume Docker containers alone provide sufficient isolation for arbitrary untrusted code.

---

## 10. GitHub Repository and CI/CD

Use the existing ConstructorFleet repository for this project.

Update the existing repository rather than creating competing implementations.

Publish images to:

`ghcr.io/constructorfleet/`

### GitHub Actions

Implement workflows to:

1. Lint source code.
2. Type-check.
3. Run unit tests.
4. Run integration tests.
5. Build container images.
6. Execute container smoke tests.
7. Scan images for vulnerabilities.
8. Publish images to GHCR.

Support:

- Main branch builds.
- Semantic version tags.
- Immutable image digests.
- Multi-platform manifests where supported.

Use GitHub Actions `GITHUB_TOKEN` with appropriate permissions.

Pin dependencies and base images.

Implement dependency update automation where appropriate.

---

## 11. Advanced Features

### A. Design History and Visual Diffs

Leverage Git to provide:

- Revision history.
- Schematic diffs.
- PCB diffs.
- BOM diffs.
- Validation-result diffs.
- Manufacturing-artifact comparisons.

### B. Requirements-Driven Design

Allow projects to define structured engineering requirements.

Example:

```yaml
project:
  name: esp32-sensor-board

requirements:
  board:
    width_mm: 50
    height_mm: 35
    layers: 4

  power:
    input: usb-c
    voltage: 5
    max_current_ma: 500

  interfaces:
    - type: i2c
      count: 2

    - type: gpio
      count: 4

  manufacturing:
    assembler: jlcpcb
```

Automatically validate requirements wherever possible.

Expose requirements to AI agents through MCP.

### C. Design Review

Implement structured design-review states:

`Draft → Validated → Reviewed → Manufacturing Approved`

Reviews should identify:

- Unverified assumptions.
- Electrical concerns.
- Manufacturing concerns.
- Component availability.
- Potential improvements.
- Estimated costs.

### D. Reusable Circuit Modules

Support reusable modules and templates including:

- USB-C power input.
- ESP32 support circuits.
- I²C connectors.
- Buck converters.
- LED drivers.
- Level shifters.
- Sensor interfaces.
- Protection circuits.

Prefer verified upstream implementations.

### E. Parametric Design

Support parameters such as:

- Board dimensions.
- Connector count.
- Supply voltage.
- LED count.
- Mounting-hole spacing.

Parameter changes should propagate automatically.

### F. Mechanical Integration

Investigate:

- STEP export.
- STL export where appropriate.
- 3D component models.
- Board-to-enclosure fit.
- Connector clearances.
- Mechanical collision checks.
- KiCad interoperability.

### G. AI-Assisted Design Review

Allow an agent to inspect:

- Source code.
- Circuit JSON.
- Electrical connectivity.
- Validation results.
- Simulation outputs.
- Rendered views.

Require actionable feedback supported by identifiable engineering evidence.

### H. Automated Regression Tests

Support project-level assertions such as:

- Required nets remain connected.
- Board dimensions meet requirements.
- Required components exist.
- Power consumption stays below limits.
- DRC errors do not increase.
- BOM cost remains within budget.
- Simulation results meet defined tolerances.

### I. Immutable Manufacturing Snapshots

Generate reproducible manufacturing snapshots containing:

- Source revision.
- Component versions.
- Dependency versions.
- Manufacturing files.
- Validation reports.
- Simulation results.
- BOM.
- Checksums.

### J. Project-Level AI Knowledge

Maintain structured project documentation containing:

- Functional requirements.
- Electrical assumptions.
- Design decisions.
- Mechanical constraints.
- Manufacturing preferences.
- Known issues.
- Pending decisions.

Expose this context through MCP.

---

## 12. Implementation Phases

Implement functional vertical slices rather than building all features simultaneously.

### Phase 1: Foundation

Deliver:

- Working Docker image.
- tscircuit CLI.
- Persistent project storage.
- Browser-based application.
- Live updates.
- Schematic, PCB, and 3D previews.
- Project management.
- Build diagnostics.
- GHCR publishing.

**Acceptance criterion:**

A user can create a circuit, edit its source, and watch schematic, PCB, and 3D previews update automatically.

### Phase 2: AI Integration

Deliver:

- MCP server.
- Project inspection tools.
- Circuit modification tools.
- Validation tools.
- Preview tools.
- External agent configuration examples.

**Acceptance criterion:**

An external MCP-compatible agent can create a project, modify its circuit, compile it, inspect errors, correct problems, and generate updated previews.

### Phase 3: Simulation

Deliver:

- SPICE integration.
- Simulation configuration.
- Waveform visualization.
- Electrical net tracing.
- Simulation diagnostics.
- MCP access to simulation results.

**Acceptance criterion:**

A user can run a supported analog simulation, inspect waveforms, and correlate signals with schematic nets.

### Phase 4: Manufacturing

Deliver:

- Gerber export.
- Drill export.
- BOM generation.
- Pick-and-place export.
- Manufacturing ZIP.
- Preflight validation.
- Fabricator profiles.

**Acceptance criterion:**

A validated example circuit produces a complete package suitable for upload to a supported PCB manufacturer.

### Phase 5: Advanced Capabilities

Prioritize:

- Component sourcing.
- Requirements validation.
- Design history.
- Visual diffs.
- Cost estimates.
- Agent orchestration.
- Mechanical integration.

---

## 13. Testing Requirements

Implement unit, integration, and end-to-end tests.

### Unit Tests

Cover:

- Project operations.
- Configuration parsing.
- File monitoring.
- Validation processing.
- MCP tools.
- Manufacturing exports.

### Integration Tests

Cover:

- Circuit compilation.
- Preview generation.
- Live updates.
- Simulation execution.
- Manufacturing exports.

### End-to-End Testing

Create a representative circuit containing:

- Power input.
- Voltage regulation.
- Resistors.
- LEDs.
- Connectors.
- Multiple nets.

Verify:

1. Project initialization.
2. Successful compilation.
3. Schematic rendering.
4. PCB rendering.
5. 3D rendering.
6. Live updates after source modification.
7. Diagnostics for deliberate errors.
8. Successful recovery after fixing errors.
9. Supported simulation execution.
10. Manufacturing-file generation.

Execute tests against the actual containerized application, not exclusively mocked services.

---

## 14. Documentation

Provide comprehensive documentation covering:

- Architecture.
- Installation.
- Docker Compose deployment.
- Docker Swarm deployment.
- Reverse proxy configuration.
- Persistent storage.
- Backups.
- Upgrades.
- Security.
- MCP configuration.
- ACP configuration, if implemented.
- Agent integration.
- Circuit development.
- Simulation.
- Manufacturing exports.
- Troubleshooting.

Provide working example projects demonstrating core functionality.

Clearly distinguish production-ready features from experimental or incomplete capabilities.

---

## 15. Definition of Done

The project is successful when I can:

1. Deploy the platform using Docker Swarm.
2. Open the application in a browser.
3. Create an electronics project.
4. Describe a circuit to an external AI agent.
5. Have the agent generate and modify tscircuit source.
6. Watch schematic, PCB, and 3D previews update automatically.
7. Inspect components, nets, dimensions, and layout.
8. Run supported simulations.
9. Inspect simulation waveforms.
10. Trace electrical connectivity.
11. Execute automated engineering validation.
12. Generate PCB fabrication and assembly files.
13. Download a complete manufacturing package.
14. Save, revisit, and version projects.

The platform must remain usable without an AI agent connected.

---

## 16. Execution Instructions

**Do not stop after creating an architecture document or scaffolding a repository. Implement working functionality.**

Begin by:

1. Inspecting the existing repository.
2. Investigating current tscircuit capabilities.
3. Identifying reusable upstream libraries.
4. Mapping requirements to existing functionality.
5. Documenting architectural decisions.
6. Implementing Phase 1.

Continue through subsequent phases, prioritizing functional vertical slices.

### Implementation Rules

- Make sensible engineering decisions independently.
- Do not request approval for minor implementation details.
- Prefer maintained upstream libraries.
- Verify assumptions against actual source code and documentation.
- Do not invent APIs.
- Do not claim functionality is implemented without testing it.
- Avoid unnecessary dependencies.
- Avoid unnecessary infrastructure.
- Run tests after meaningful changes.
- Maintain a deployable application.
- Commit cohesive changes with descriptive messages.
- Push changes when permissions permit.
- Publish container images through GitHub Actions.

If functionality cannot reasonably be implemented, deliver the best functional subset and explicitly document the limitation.

### Critical: Do Not Reinvent Existing Engineering Tools

**DO NOT implement custom versions of:**

- PCB autorouters.
- Schematic rendering engines.
- PCB rendering engines.
- SPICE simulation engines.
- 3D PCB visualization engines.
- Gerber generators.
- Established electrical rule-checking engines.
- Established PCB design rule-checking engines.

**Unless:**

1. No suitable maintained implementation exists.
2. Existing implementations cannot satisfy a documented requirement.
3. Integration alternatives have been evaluated.
4. The technical justification is recorded in an architecture decision record.

Prefer integration through adapters, plugins, and documented APIs.

**The objective is to build an excellent integrated engineering workbench, not spend six months writing a mediocre autorouter.**

### Final Deliverable

Deliver a working, containerized, AI-native electronics development environment.

The result must include:

- Functional browser application.
- Live schematic, PCB, and 3D visualization.
- Docker deployment.
- MCP integration.
- Supported simulation capabilities.
- Engineering validation.
- Manufacturing exports.
- Documentation.
- Automated tests.
- Published GHCR images.

**Prioritize working software over architectural speculation.**
