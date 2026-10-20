export function hasPcbPreviewData(circuitJson: unknown): boolean {
  return Array.isArray(circuitJson) && circuitJson.some((item) =>
    item !== null && typeof item === 'object' && 'type' in item &&
    typeof item.type === 'string' && item.type.startsWith('pcb_'),
  )
}
