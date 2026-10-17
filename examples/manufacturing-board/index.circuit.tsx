export default () => (
  <board width="20mm" height="12mm">
    <resistor name="R1" resistance="1k" footprint="0402" pcbX={-3} pcbY={0} />
    <resistor name="R2" resistance="10k" footprint="0603" pcbX={3} pcbY={0} />
    <platedhole name="J1" holeDiameter="1mm" outerDiameter="2mm" pcbX={0} pcbY={4} />
    <hole diameter="2mm" pcbX={0} pcbY={-4} />
  </board>
)
