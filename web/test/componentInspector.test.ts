import { describe, expect, it } from 'vitest'
import { getInspectedComponents } from '../src/componentInspector'

describe('getInspectedComponents', () => {
  it('joins source components to placements, pins, and nets by Circuit JSON IDs', () => {
    const result = getInspectedComponents([
      { type: 'source_component', source_component_id: 'sc-1', name: 'R1', display_name: '10k resistor', ftype: 'simple_resistor', resistance: 1000 },
      { type: 'source_component', source_component_id: 'sc-2', name: 'D1' },
      { type: 'pcb_component', source_component_id: 'sc-1', center: { x: 2, y: 3 }, rotation: 90, layer: 'top' },
      { type: 'source_port', source_component_id: 'sc-1', source_port_id: 'sp-1', name: 'pin1', pin_number: 1 },
      { type: 'source_trace', source_trace_id: 'st-1', name: 'VCC', connected_source_port_ids: ['sp-1'] },
    ])

    expect(result).toEqual([
      {
        id: 'sc-1', name: 'R1 · 10k resistor', properties: [['display_name', '10k resistor'], ['ftype', 'simple_resistor'], ['resistance', 1000]],
        placement: { type: 'pcb_component', source_component_id: 'sc-1', center: { x: 2, y: 3 }, rotation: 90, layer: 'top' },
        pins: [{ id: 'sp-1', name: 'pin1', connections: ['VCC'] }],
      },
      { id: 'sc-2', name: 'D1', properties: [], placement: undefined, pins: [] },
    ])
  })

  it('ignores malformed records and components without stable IDs', () => {
    expect(getInspectedComponents(null)).toEqual([])
    expect(getInspectedComponents([null, { type: 'source_component', name: 'R1' }, { type: 'pcb_component', source_component_id: 'sc-1' }])).toEqual([])
  })
})
