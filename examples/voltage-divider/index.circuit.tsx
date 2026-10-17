export default () => (
  <board name="Filtered voltage divider" width="26mm" height="14mm">
    <connector name="J1" standard="jst_ph" pinCount={2} pcbX={-10} pcbY={0} pcbRotation={90} schX={-6} schY={0} pinLabels={{ pin1: "VIN", pin2: "GND" }} />
    <resistor name="R1" resistance="10k" footprint="0603" pcbX={-3} pcbY={0} schX={-2} schY={0} />
    <resistor name="R2" resistance="10k" footprint="0603" pcbX={2} pcbY={0} schX={2} schY={0} />
    <capacitor name="C1" capacitance="100nF" footprint="0603" pcbX={8} pcbY={0} schX={6} schY={0} />
    <trace from=".J1 > .VIN" to=".R1 > .pin1" name="VCC" />
    <trace from=".R1 > .pin2" to=".R2 > .pin1" name="SENSE" />
    <trace from=".C1 > .pin1" to=".R1 > .pin2" name="SENSE" />
    <trace from=".R2 > .pin2" to=".J1 > .GND" name="GND" />
    <trace from=".C1 > .pin2" to=".J1 > .GND" name="GND" />
    <schematicsheet name="Divider" displayName="Divider" sheetIndex={0}>
      <schematictext text="1:2 divider with output low-pass filter" schX={0} schY={6} />
    </schematicsheet>
  </board>
)
