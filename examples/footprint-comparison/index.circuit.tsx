export default () => (
  <board name="Indicator footprint study" width="28mm" height="18mm">
    <resistor name="R1" resistance="1k" footprint="0402" pcbX={-8} pcbY={4} />
    <resistor name="R2" resistance="1k" footprint="0603" pcbX={0} pcbY={4} />
    <resistor name="R3" resistance="1k" footprint="0805" pcbX={8} pcbY={4} />
    <resistor name="R4" resistance="10k" footprint="0402" pcbX={-8} pcbY={-4} />
    <resistor name="R5" resistance="10k" footprint="0603" pcbX={0} pcbY={-4} />
    <resistor name="R6" resistance="10k" footprint="0805" pcbX={8} pcbY={-4} />
    <platedhole name="J1" holeDiameter="1mm" outerDiameter="2mm" pcbX={-11} pcbY={0} />
    <platedhole name="J2" holeDiameter="1mm" outerDiameter="2mm" pcbX={11} pcbY={0} />
  </board>
)
