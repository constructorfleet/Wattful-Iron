# Reusable circuit modules

The workbench ships a small library of parameterised circuit modules. Adding one writes its
source into the project at `modules/<id>.tsx`; you then import it and place it in your
board. The project source stays authoritative — a module is ordinary tscircuit source you
can read and edit.

| Module | What it is | Terminals |
| --- | --- | --- |
| `power-input` | Two-pin power header with a bulk capacitor across the rails | VIN, GND |
| `resistor-divider` | Two-resistor divider; the junction carries the divided output | input, SENSE, return |
| `led-indicator` | LED with a series current-limiting resistor | drive, LED_DRIVE, return |
| `rc-low-pass` | Single-pole RC filter with a corner at 1 / (2 pi R C) | input, FILTERED, return |
| `i2c-pullups` | Four-pin I2C header with a pull-up on SDA and SCL | VCC, GND, SDA, SCL |

Every module takes `pcbX`, `pcbY`, `schX`, and `schY`, so it can be positioned without
editing its source, plus reference-designator and value parameters. Position goes on the
module's own `<group>`; its children sit at offsets inside it.

```tsx
import { PowerInput } from "./modules/power-input"
import { RcLowPass } from "./modules/rc-low-pass"

export default () => (
  <board name="sensor front end" width="40mm" height="20mm">
    <PowerInput capacitance="22uF" pcbX={-12} schX={-6} />
    <RcLowPass resistance="1k" capacitance="1uF" pcbX={6} schX={3} />
    <trace from=".C1 > .pin1" to=".R1 > .pin1" name="VIN" />
    <schematicsheet name="Main" displayName="Main" sheetIndex={0} />
  </board>
)
```

Give each instance its own reference designators when you place a module twice
(`<LedIndicator ledRef="D2" resistorRef="R4" />`), and keep instances far enough apart that
their courtyards do not overlap — a build reports an overlap as a placement error and skips
autorouting.

## What a module is not

Each module carries `notes` naming its limits, and the library is deliberately small:

- A module is a **starting point, not a verified design**. Values are defaults, not
  calculations: the LED series resistor, the divider ratio, and the filter corner are yours
  to choose and to verify with simulation or measurement.
- Terminals are left unconnected on purpose, so a build warns about them until you wire the
  module into your circuit.
- Headers use built-in `pinrow` footprints so they resolve **without network access**,
  which is what build containers have. A build may report that such a footprint differs
  from the supplier's.
- Generic parts carry no manufacturer part number, so builds warn until you specify one.

The project brief also lists USB-C power input, ESP32 support circuits, buck converters,
level shifters, and protection circuits. Those are **not** included: each needs a real part
whose footprint and pin mapping resolve from the supplier registry, which the network-less
build container cannot reach, and shipping a hand-drawn approximation of a regulator or an
MCU support circuit would look verified without being verified. Add them to a project
directly, with a part number, when you have network access to resolve the part.

## API

- `GET /api/modules` lists the library with parameters, terminals, usage, and notes.
- `GET /api/modules/:id` adds the module's source and the import line it needs.
- `POST /api/projects/:id/modules/:moduleId` writes the module into the project. Send the
  current project revision in `If-Match`; a stale revision returns HTTP 409.

MCP exposes `list_circuit_modules` and `add_circuit_module`. The browser's **Modules**
dialog lists each module with its notes and adds it to the open project.

Every shipped module is composed onto one board and built with the real tscircuit CLI in
`server/circuit-modules.test.ts`, which also runs the design checks over the result — so
the library cannot claim a module builds when it does not.
