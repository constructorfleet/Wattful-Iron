import { describe, expect, it } from 'vitest'
import { applyBoardOutline, getBoardOutline, parseSvgOutline, validateBoardOutline } from './boardOutline'

describe('board outline editing', () => {
  it('rejects outlines that cannot close a manufacturable polygon', () => {
    expect(validateBoardOutline([{ x: 0, y: 0 }, { x: 10, y: 0 }])).toMatch(/at least three/i)
    expect(validateBoardOutline([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }])).toMatch(/area/i)
    expect(validateBoardOutline([{ x: 0, y: 0 }, { x: Number.NaN, y: 0 }, { x: 0, y: 10 }])).toMatch(/finite/i)
    expect(validateBoardOutline([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }])).toMatch(/intersect/i)
  })

  it('opens the editor with the source polygon or the board dimensions', () => {
    expect(getBoardOutline('<board width="30mm" height="20mm" />')).toEqual([
      { x: -15, y: -10 }, { x: 15, y: -10 }, { x: 15, y: 10 }, { x: -15, y: 10 },
    ])
    expect(getBoardOutline('<board outline={[{"x":-2,"y":-3},{"x":2,"y":-3},{"x":0,"y":3}]} />'))
      .toEqual([{ x: -2, y: -3 }, { x: 2, y: -3 }, { x: 0, y: 3 }])
    expect(getBoardOutline('<board outline={customOutline} />', [{
      type: 'pcb_board', outline: [{ x: -8, y: -5 }, { x: 8, y: -5 }, { x: 0, y: 7 }],
    }])).toEqual([{ x: -8, y: -5 }, { x: 8, y: -5 }, { x: 0, y: 7 }])
  })

  it('writes the polygon to the board JSX while preserving other attributes and source', () => {
    const source = 'export default () => <board width="30mm" height="20mm" name="case">\n  <resistor name="R1" />\n</board>'
    const result = applyBoardOutline(source, [{ x: -10, y: -5 }, { x: 10, y: -5 }, { x: 0, y: 8 }])
    expect(result).toContain('outline={[{"x":-10,"y":-5},{"x":10,"y":-5},{"x":0,"y":8}]}')
    expect(result).toContain('name="case"')
    expect(result).toContain('<resistor name="R1" />')
    expect(applyBoardOutline(result, [{ x: -2, y: -2 }, { x: 2, y: -2 }, { x: 0, y: 2 }])).not.toContain('"x":-10')
  })

  it('converts an SVG polygon in millimeters to a centered board outline', () => {
    expect(parseSvgOutline('<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="20mm" viewBox="0 0 400 200"><polygon points="0,0 400,0 300,200 0,200"/></svg>'))
      .toEqual([{ x: -20, y: 10 }, { x: 20, y: 10 }, { x: 10, y: -10 }, { x: -20, y: -10 }])
  })

  it('rejects unsupported or ambiguous SVG outlines', () => {
    expect(() => parseSvgOutline('<svg><path d="M0 0h10v10z"/></svg>')).toThrow(/polygon or polyline/i)
    expect(() => parseSvgOutline('<svg viewBox="0 0 10 10"><polygon points="0,0 10,0 0,10"/></svg>')).toThrow(/width and height/i)
  })

  it('accepts an SVG polyline that repeats its first point to close the edge', () => {
    expect(parseSvgOutline('<svg width="20mm" height="10mm" viewBox="0 0 20 10"><polyline points="0,0 20,0 20,10 0,10 0,0"/></svg>'))
      .toEqual([{ x: -10, y: 5 }, { x: 10, y: 5 }, { x: 10, y: -5 }, { x: -10, y: -5 }])
  })
})
