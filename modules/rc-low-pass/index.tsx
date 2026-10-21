export interface RcLowPassProps {
  /** Reference designator for the series resistor. */
  resistorRef?: string
  /** Reference designator for the shunt capacitor. */
  capacitorRef?: string
  /** Series resistance. */
  resistance?: string
  /** Shunt capacitance. */
  capacitance?: string
  pcbX?: number
  pcbY?: number
  schX?: number
  schY?: number
}

/**
 * A single-pole RC low-pass filter. Its corner frequency is 1 / (2 * pi * R * C).
 *
 * Terminals: `.<resistorRef> > .pin1` is the input, `.<capacitorRef> > .pin2` the return,
 * and the junction carries the filtered output on the `FILTERED` net.
 */
export const RcLowPass = ({
  resistorRef = "R1",
  capacitorRef = "C1",
  resistance = "10k",
  capacitance = "100nF",
  pcbX = 0,
  pcbY = 0,
  schX = 0,
  schY = 0,
}: RcLowPassProps) => (
  <group name={`rc_low_pass_${resistorRef}`} pcbX={pcbX} pcbY={pcbY} schX={schX} schY={schY}>
    <resistor name={resistorRef} resistance={resistance} footprint="0603" pcbX={-2.5} pcbY={0} schX={-1.5} schY={0} />
    <capacitor name={capacitorRef} capacitance={capacitance} footprint="0603" pcbX={2.5} pcbY={0} schX={1.5} schY={0} />
    <trace from={`.${resistorRef} > .pin2`} to={`.${capacitorRef} > .pin1`} name="FILTERED" />
  </group>
)

export default RcLowPass
