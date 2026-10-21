export interface PowerInputProps {
  /** Reference designator for the input header. */
  connectorRef?: string
  /** Reference designator for the bulk capacitor. */
  capacitorRef?: string
  /** Bulk capacitance across the input. */
  capacitance?: string
  pcbX?: number
  pcbY?: number
  schX?: number
  schY?: number
}

/**
 * A two-pin power input header with a bulk capacitor across it.
 *
 * Terminals: the header's VIN and GND pins, and the capacitor pins that sit on the same
 * nets. Wire the rest of the board to `.<connectorRef> > .VIN` and `.<connectorRef> > .GND`.
 */
export const PowerInput = ({
  connectorRef = "J1",
  capacitorRef = "C1",
  capacitance = "10uF",
  pcbX = 0,
  pcbY = 0,
  schX = 0,
  schY = 0,
}: PowerInputProps) => (
  <group name={`power_input_${connectorRef}`} pcbX={pcbX} pcbY={pcbY} schX={schX} schY={schY}>
    <pinheader name={connectorRef} pinCount={2} footprint="pinrow2" pinLabels={["VIN", "GND"]} pcbX={-4} pcbY={0} schX={-2} schY={0} />
    <capacitor name={capacitorRef} capacitance={capacitance} footprint="0805" pcbX={4} pcbY={0} schX={2} schY={0} />
    <trace from={`.${connectorRef} > .VIN`} to={`.${capacitorRef} > .pin1`} name="VIN" />
    <trace from={`.${connectorRef} > .GND`} to={`.${capacitorRef} > .pin2`} name="GND" />
  </group>
)

export default PowerInput
