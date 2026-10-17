export default () => (
  <board name="Current-limited LED indicator" width="24mm" height="12mm">
    <connector name="J1" standard="jst_ph" pinCount={2} pcbX={-9} pcbY={0} pcbRotation={90} schX={-4} schY={0} pinLabels={{ pin1: "VCC", pin2: "GND" }} />
    <resistor name="R1" resistance="1k" footprint="0603" pcbX={0} pcbY={0} schX={0} schY={0} />
    <led name="D1" color="green" footprint="led0603" mpn="LTST-C190KGKT" pcbX={5} pcbY={0} schX={4} schY={0} />
    <trace from=".J1 > .VCC" to=".R1 > .pin1" name="VCC" />
    <trace from=".R1 > .pin2" to=".D1 > .pin1" name="LED_CURRENT" />
    <trace from=".D1 > .pin2" to=".J1 > .GND" name="GND" />
    <schematicsheet name="Indicator" displayName="Indicator" sheetIndex={0}>
      <schematictext text="3.3-5 V input · 1 kΩ current limit" schX={0} schY={5} />
    </schematicsheet>
  </board>
)
