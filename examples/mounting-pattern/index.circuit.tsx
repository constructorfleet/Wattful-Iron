export default () => (
  <board name="Sensor breakout mechanical study" width="32mm" height="22mm">
    <resistor name="R1" resistance="4.7k" footprint="0603" pcbX={-5} pcbY={5} />
    <resistor name="R2" resistance="4.7k" footprint="0603" pcbX={5} pcbY={5} />
    <resistor name="R3" resistance="100k" footprint="0603" pcbX={0} pcbY={-5} />
    <platedhole name="J1" holeDiameter="0.8mm" outerDiameter="1.6mm" pcbX={-11} pcbY={0} />
    <platedhole name="J2" holeDiameter="0.8mm" outerDiameter="1.6mm" pcbX={11} pcbY={0} />
    <hole name="MH1" diameter="2.2mm" pcbX={-13} pcbY={-8} />
    <hole name="MH2" diameter="2.2mm" pcbX={13} pcbY={-8} />
    <hole name="MH3" diameter="2.2mm" pcbX={-13} pcbY={8} />
    <hole name="MH4" diameter="2.2mm" pcbX={13} pcbY={8} />
  </board>
)
