export interface ResistorDividerProps {
  /** Reference designator for the high-side resistor. */
  topRef?: string
  /** Reference designator for the low-side resistor. */
  bottomRef?: string
  /** High-side resistance. */
  top?: string
  /** Low-side resistance. */
  bottom?: string
  pcbX?: number
  pcbY?: number
  schX?: number
  schY?: number
}

/**
 * A two-resistor divider. The division ratio is bottom / (top + bottom).
 *
 * Terminals: `.<topRef> > .pin1` is the input, `.<bottomRef> > .pin2` the return, and the
 * junction between them carries the divided output on the `SENSE` net.
 */
export const ResistorDivider = ({
  topRef = "R1",
  bottomRef = "R2",
  top = "10k",
  bottom = "10k",
  pcbX = 0,
  pcbY = 0,
  schX = 0,
  schY = 0,
}: ResistorDividerProps) => (
  <group name={`divider_${topRef}`} pcbX={pcbX} pcbY={pcbY} schX={schX} schY={schY}>
    <resistor name={topRef} resistance={top} footprint="0603" pcbX={-2.5} pcbY={0} schX={-1.5} schY={0} />
    <resistor name={bottomRef} resistance={bottom} footprint="0603" pcbX={2.5} pcbY={0} schX={1.5} schY={0} />
    <trace from={`.${topRef} > .pin2`} to={`.${bottomRef} > .pin1`} name="SENSE" />
  </group>
)

export default ResistorDivider
