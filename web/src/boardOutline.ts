export type BoardOutlinePoint = {
  x: number
  y: number
  isCastellatedHole?: boolean
  holeDiameter?: number | string
  padDiameter?: number | string
  connectsTo?: string | string[]
}

export function validateBoardOutline(points: BoardOutlinePoint[]): string | null {
  if (points.some(({ x, y }) => !Number.isFinite(x) || !Number.isFinite(y))) return 'All outline coordinates must be finite numbers.'
  if (points.length < 3) return 'A board outline needs at least three points.'
  if (points.some((point, index) => samePoint(point, points[(index + 1) % points.length]!))) return 'Adjacent outline points must be different.'
  if (hasSelfIntersection(points)) return 'The outline cannot intersect itself.'
  if (Math.abs(signedArea(points)) < 0.000001) return 'The outline must enclose a non-zero area.'
  return null
}

export function getBoardOutline(source: string, circuitJson?: unknown): BoardOutlinePoint[] {
  const tag = /<board(?=[\s/>])[^>]*>/.exec(source)?.[0]
  if (!tag) return rectangle(20, 12)
  const attribute = /\boutline\s*=\s*\{(\[[^\]]*\])\}/.exec(tag)
  if (attribute) {
    try {
      const points = JSON.parse(attribute[1]!) as BoardOutlinePoint[]
      if (!validateBoardOutline(points)) return points
    } catch { /* Non-literal outlines open at the declared board dimensions. */ }
  }
  const board = Array.isArray(circuitJson) ? circuitJson.find((item) => isRecord(item) && item.type === 'pcb_board') : undefined
  if (isRecord(board) && Array.isArray(board.outline)) {
    const points = board.outline.map((point) => isRecord(point) ? { ...point, x: Number(point.x), y: Number(point.y) } : point) as BoardOutlinePoint[]
    if (!validateBoardOutline(points)) return points
  }
  const width = dimension(tag, 'width') ?? 20
  const height = dimension(tag, 'height') ?? 12
  return rectangle(width, height)
}

export function applyBoardOutline(source: string, points: BoardOutlinePoint[]): string {
  const openTag = /<board(?=[\s/>])[^>]*>/g
  const match = openTag.exec(source)
  if (!match) throw new Error('Could not find a <board> element in the active source file.')
  const start = match.index
  const end = start + match[0].length
  const tag = match[0]
  const attrStart = /\boutline\s*=\s*\{/.exec(tag)?.index
  const value = `outline={${JSON.stringify(points)}}`
  let updated: string
  if (attrStart === undefined) {
    const slash = tag.endsWith('/>') ? tag.length - 2 : tag.length - 1
    updated = `${tag.slice(0, slash).trimEnd()} ${value}${tag.slice(slash)}`
  } else {
    const openBrace = tag.indexOf('{', attrStart)
    const closeBrace = findClosingBrace(tag, openBrace)
    updated = `${tag.slice(0, attrStart)}${value}${tag.slice(closeBrace + 1)}`
  }
  return `${source.slice(0, start)}${updated}${source.slice(end)}`
}

export function parseSvgOutline(svg: string): BoardOutlinePoint[] {
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml')
  if (document.querySelector('parsererror')) throw new Error('The SVG file could not be parsed.')
  const svgElement = document.documentElement
  const shape = svgElement.querySelector('polygon, polyline')
  if (!shape) throw new Error('SVG upload must contain one polygon or polyline outline.')
  if (svgElement.querySelectorAll('polygon, polyline').length !== 1) throw new Error('SVG upload must contain exactly one polygon or polyline outline.')
  const viewBox = (svgElement.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number)
  if (viewBox.length !== 4 || viewBox.some((value) => !Number.isFinite(value)) || viewBox[2]! <= 0 || viewBox[3]! <= 0) {
    throw new Error('SVG upload needs a valid viewBox and width and height.')
  }
  const widthMm = svgLengthMm(svgElement.getAttribute('width'))
  const heightMm = svgLengthMm(svgElement.getAttribute('height'))
  if (!widthMm || !heightMm) throw new Error('SVG upload needs width and height in mm, cm, inches, or px.')
  const rawPoints = (shape.getAttribute('points') ?? '').trim().split(/[\s,]+/).map(Number)
  if (rawPoints.length < 6 || rawPoints.length % 2 !== 0 || rawPoints.some((value) => !Number.isFinite(value))) {
    throw new Error('The SVG polygon or polyline needs at least three valid points.')
  }
  const [, , viewWidth, viewHeight] = viewBox as [number, number, number, number]
  const parsed: BoardOutlinePoint[] = []
  for (let index = 0; index < rawPoints.length; index += 2) {
    parsed.push({ x: ((rawPoints[index]! - viewBox[0]!) * widthMm) / viewWidth, y: -((rawPoints[index + 1]! - viewBox[1]!) * heightMm) / viewHeight })
  }
  if (parsed.length > 3 && samePoint(parsed[0]!, parsed.at(-1)!)) parsed.pop()
  const minX = Math.min(...parsed.map(({ x }) => x))
  const maxX = Math.max(...parsed.map(({ x }) => x))
  const minY = Math.min(...parsed.map(({ y }) => y))
  const maxY = Math.max(...parsed.map(({ y }) => y))
  const centered = parsed.map(({ x, y }) => ({ x: tidy(x - (minX + maxX) / 2), y: tidy(y - (minY + maxY) / 2) }))
  const error = validateBoardOutline(centered)
  if (error) throw new Error(error)
  return centered
}

function svgLengthMm(value: string | null): number | null {
  if (!value) return null
  const match = /^\s*((?:\d+(?:\.\d*)?|\.\d+))\s*(mm|cm|in|px)\s*$/i.exec(value)
  if (!match) return null
  const amount = Number(match[1])
  const unit = match[2]!.toLowerCase()
  return amount * (unit === 'cm' ? 10 : unit === 'in' ? 25.4 : unit === 'px' ? 25.4 / 96 : 1)
}

function findClosingBrace(source: string, open: number): number {
  let depth = 0
  let quote = ''
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]!
    if (quote) {
      if (char === quote && source[index - 1] !== '\\') quote = ''
      continue
    }
    if (char === '"' || char === "'" || char === '`') quote = char
    else if (char === '{') depth += 1
    else if (char === '}' && --depth === 0) return index
  }
  throw new Error('The existing board outline expression is incomplete.')
}

function signedArea(points: BoardOutlinePoint[]): number {
  return points.reduce((area, point, index) => {
    const next = points[(index + 1) % points.length]!
    return area + point.x * next.y - next.x * point.y
  }, 0) / 2
}

function hasSelfIntersection(points: BoardOutlinePoint[]): boolean {
  for (let first = 0; first < points.length; first += 1) {
    const firstEnd = (first + 1) % points.length
    for (let second = first + 1; second < points.length; second += 1) {
      const secondEnd = (second + 1) % points.length
      if (first === second || firstEnd === second || secondEnd === first) continue
      if (segmentsIntersect(points[first]!, points[firstEnd]!, points[second]!, points[secondEnd]!)) return true
    }
  }
  return false
}

function segmentsIntersect(a: BoardOutlinePoint, b: BoardOutlinePoint, c: BoardOutlinePoint, d: BoardOutlinePoint): boolean {
  const orient = (p: BoardOutlinePoint, q: BoardOutlinePoint, r: BoardOutlinePoint) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
  const onSegment = (p: BoardOutlinePoint, q: BoardOutlinePoint, r: BoardOutlinePoint) =>
    q.x <= Math.max(p.x, r.x) && q.x >= Math.min(p.x, r.x) && q.y <= Math.max(p.y, r.y) && q.y >= Math.min(p.y, r.y)
  const abC = orient(a, b, c)
  const abD = orient(a, b, d)
  const cdA = orient(c, d, a)
  const cdB = orient(c, d, b)
  if (abC === 0 && onSegment(a, c, b)) return true
  if (abD === 0 && onSegment(a, d, b)) return true
  if (cdA === 0 && onSegment(c, a, d)) return true
  if (cdB === 0 && onSegment(c, b, d)) return true
  return (abC > 0) !== (abD > 0) && (cdA > 0) !== (cdB > 0)
}

function samePoint(a: BoardOutlinePoint, b: BoardOutlinePoint): boolean { return a.x === b.x && a.y === b.y }
function tidy(value: number): number { return Math.round(value * 1_000_000) / 1_000_000 }

function rectangle(width: number, height: number): BoardOutlinePoint[] {
  return [{ x: -width / 2, y: -height / 2 }, { x: width / 2, y: -height / 2 }, { x: width / 2, y: height / 2 }, { x: -width / 2, y: height / 2 }]
}

function dimension(tag: string, name: string): number | null {
  const value = new RegExp(`\\b${name}\\s*=\\s*["']([\\d.]+)\\s*mm["']`).exec(tag)?.[1]
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null }
