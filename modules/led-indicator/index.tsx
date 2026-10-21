export interface LedIndicatorProps {
  /** Reference designator for the LED. */
  ledRef?: string
  /** Reference designator for the series resistor. */
  resistorRef?: string
  /** Series resistance that sets the LED current. */
  resistance?: string
  pcbX?: number
  pcbY?: number
  schX?: number
  schY?: number
}

/**
 * An LED with a series current-limiting resistor.
 *
 * Terminals: `.<resistorRef> > .pin1` is the drive input and `.<ledRef> > .cathode` the
 * return. The junction between them carries the `LED_DRIVE` net.
 */
export const LedIndicator = ({
  ledRef = "D1",
  resistorRef = "R1",
  resistance = "1k",
  pcbX = 0,
  pcbY = 0,
  schX = 0,
  schY = 0,
}: LedIndicatorProps) => (
  <group name={`led_indicator_${ledRef}`} pcbX={pcbX} pcbY={pcbY} schX={schX} schY={schY}>
    <resistor name={resistorRef} resistance={resistance} footprint="0603" pcbX={-2.5} pcbY={0} schX={-1.5} schY={0} />
    <led name={ledRef} footprint="0603" pcbX={2.5} pcbY={0} schX={1.5} schY={0} />
    <trace from={`.${resistorRef} > .pin2`} to={`.${ledRef} > .anode`} name="LED_DRIVE" />
  </group>
)

export default LedIndicator
