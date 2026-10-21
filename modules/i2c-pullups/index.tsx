export interface I2cPullupsProps {
  /** Reference designator for the four-pin bus header. */
  connectorRef?: string
  /** Reference designator for the SDA pull-up. */
  sdaRef?: string
  /** Reference designator for the SCL pull-up. */
  sclRef?: string
  /** Pull-up resistance on both lines. */
  resistance?: string
  pcbX?: number
  pcbY?: number
  schX?: number
  schY?: number
}

/**
 * An I2C bus header with a pull-up on each line.
 *
 * Terminals: the header's VCC, GND, SDA, and SCL pins. Both pull-ups return to VCC, so the
 * bus voltage is whatever the header's VCC pin is tied to.
 */
export const I2cPullups = ({
  connectorRef = "J1",
  sdaRef = "R1",
  sclRef = "R2",
  resistance = "4.7k",
  pcbX = 0,
  pcbY = 0,
  schX = 0,
  schY = 0,
}: I2cPullupsProps) => (
  <group name={`i2c_${connectorRef}`} pcbX={pcbX} pcbY={pcbY} schX={schX} schY={schY}>
    <pinheader name={connectorRef} pinCount={4} footprint="pinrow4" pinLabels={["VCC", "GND", "SDA", "SCL"]} pcbX={-5} pcbY={0} schX={-3} schY={0} />
    <resistor name={sdaRef} resistance={resistance} footprint="0603" pcbX={3} pcbY={2.5} schX={2} schY={2} />
    <resistor name={sclRef} resistance={resistance} footprint="0603" pcbX={3} pcbY={-2.5} schX={2} schY={-2} />
    <trace from={`.${connectorRef} > .SDA`} to={`.${sdaRef} > .pin1`} name="SDA" />
    <trace from={`.${connectorRef} > .SCL`} to={`.${sclRef} > .pin1`} name="SCL" />
    <trace from={`.${sdaRef} > .pin2`} to={`.${connectorRef} > .VCC`} name="VCC" />
    <trace from={`.${sclRef} > .pin2`} to={`.${connectorRef} > .VCC`} name="VCC" />
  </group>
)

export default I2cPullups
