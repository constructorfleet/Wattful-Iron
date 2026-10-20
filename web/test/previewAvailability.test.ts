import { describe, expect, it } from 'vitest'
import { hasPcbPreviewData } from '../src/previewAvailability'

describe('hasPcbPreviewData', () => {
  it('returns false for schematic-only Circuit JSON', () => {
    expect(hasPcbPreviewData([{ type: 'schematic_component' }, { type: 'source_net' }])).toBe(false)
  })

  it('returns true when PCB geometry or a placed component is present', () => {
    expect(hasPcbPreviewData([{ type: 'pcb_component' }])).toBe(true)
    expect(hasPcbPreviewData([{ type: 'pcb_board' }])).toBe(true)
  })

  it('handles absent and non-array previews', () => {
    expect(hasPcbPreviewData(null)).toBe(false)
    expect(hasPcbPreviewData({ type: 'pcb_component' })).toBe(false)
  })
})
