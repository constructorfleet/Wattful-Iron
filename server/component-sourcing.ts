type Element = Record<string, unknown> & { type?: string }

export type SourcedPart = {
  lcscPartNumber: string
  manufacturerPartNumber?: string
  package?: string
  description?: string
  stockQuantity?: number
  unitPriceUsd?: number
  isBasicPart?: boolean
  isPreferredPart?: boolean
}

/** One component in the design, with the supplier part numbers Circuit JSON records for it. */
export type DesignPart = {
  sourceComponentId?: string
  name: string
  manufacturerPartNumber?: string
  lcscPartNumbers: string[]
  quantity: number
}

export type BomCostLine = {
  name: string
  quantity: number
  lcscPartNumber?: string
  unitPriceUsd?: number
  extendedPriceUsd?: number
  stockQuantity?: number
  isBasicPart?: boolean
}

export type BomCostEstimate = {
  boards: number
  lines: BomCostLine[]
  unpriced: Array<{ name: string; reason: string }>
  componentCostUsd?: number
  limitations: string[]
}

export type AvailabilityReport = {
  parts: Array<{ name: string; lcscPartNumber?: string; stockQuantity?: number; status: "in-stock" | "out-of-stock" | "unknown" }>
  outOfStock: string[]
  unknown: Array<{ name: string; reason: string }>
}

export type SourcingClient = {
  readonly provider: string
  readonly baseUrl: string
  lookup(partNumber: string): Promise<SourcedPart | null>
}

export type SourcingConfig = {
  baseUrl: string
  provider?: string
  timeoutMs?: number
  cacheTtlMs?: number
  fetchImpl?: typeof fetch
}

const MAX_RESPONSE_BYTES = 512 * 1024
const DEFAULT_TIMEOUT_MS = 8000
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000
const LCSC_PATTERN = /^C?(\d{2,12})$/i

const BOM_LIMITATIONS = [
  "Component cost only. Board fabrication, assembly, tooling, shipping, and taxes are not included.",
  "Unit price is the supplier's listed price for the queried part at the time of the lookup, not a quote.",
  "Quantities come from the components emitted in Circuit JSON. Panelization, attrition, and spares are not added.",
  "Only parts carrying an LCSC part number in Circuit JSON can be priced. Parts without one are listed as unpriced.",
]

/** Normalize an LCSC reference such as `C2040`, `c2040`, or `2040` to `C2040`. */
export function normalizeLcscPartNumber(value: unknown) {
  const match = typeof value === "string" ? LCSC_PATTERN.exec(value.trim()) : null
  return match ? `C${match[1]}` : undefined
}

/**
 * Create a lookup client for a JLCPCB/LCSC part index that exposes the tscircuit
 * JLCSearch `/api/search` shape. Results are cached in memory for the configured TTL so
 * repeated BOM estimates for one build do not re-query the supplier.
 */
export function createSourcingClient(config: SourcingConfig): SourcingClient {
  const url = new URL(config.baseUrl)
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Component sourcing base URL must use http or https")
  const baseUrl = url.toString().replace(/\/$/, "")
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const cacheTtlMs = config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  const fetchImpl = config.fetchImpl ?? fetch
  const cache = new Map<string, { part: SourcedPart | null; expiresAt: number }>()

  return {
    provider: config.provider ?? "jlcsearch",
    baseUrl,
    async lookup(partNumber: string) {
      const lcsc = normalizeLcscPartNumber(partNumber)
      if (!lcsc) throw new Error(`'${partNumber}' is not an LCSC part number such as C2040`)
      const cached = cache.get(lcsc)
      if (cached && cached.expiresAt > Date.now()) return cached.part
      const part = await requestPart(fetchImpl, `${baseUrl}/api/search?q=${encodeURIComponent(lcsc)}&limit=10`, lcsc, timeoutMs)
      cache.set(lcsc, { part, expiresAt: Date.now() + cacheTtlMs })
      return part
    },
  }
}

async function requestPart(fetchImpl: typeof fetch, requestUrl: string, lcsc: string, timeoutMs: number): Promise<SourcedPart | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let body: string
  try {
    const response = await fetchImpl(requestUrl, { signal: controller.signal, headers: { Accept: "application/json" } })
    if (!response.ok) throw new Error(`supplier responded with HTTP ${response.status}`)
    body = await response.text()
  } catch (error) {
    throw new Error(`Component sourcing lookup for ${lcsc} failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    clearTimeout(timer)
  }
  if (body.length > MAX_RESPONSE_BYTES) throw new Error(`Component sourcing lookup for ${lcsc} returned more than ${MAX_RESPONSE_BYTES} bytes`)
  let payload: unknown
  try {
    payload = JSON.parse(body)
  } catch {
    throw new Error(`Component sourcing lookup for ${lcsc} returned a response that is not JSON`)
  }
  const components = isElement(payload) && Array.isArray(payload.components) ? payload.components.filter(isElement) : []
  const match = components.find((component) => normalizeLcscPartNumber(String(component.lcsc)) === lcsc)
  if (!match) return null
  return {
    lcscPartNumber: lcsc,
    manufacturerPartNumber: text(match.mfr),
    package: text(match.package),
    description: text(match.description),
    stockQuantity: finite(match.stock),
    unitPriceUsd: finite(match.price) ?? firstTierPrice(match.price),
    isBasicPart: typeof match.is_basic === "boolean" ? match.is_basic : undefined,
    isPreferredPart: typeof match.is_preferred === "boolean" ? match.is_preferred : undefined,
  }
}

/** List the design's components with the LCSC part numbers Circuit JSON carries for them. */
export function listDesignParts(circuitJson: unknown): DesignPart[] {
  const elements = Array.isArray(circuitJson) ? circuitJson.filter(isElement) : []
  const byKey = new Map<string, DesignPart>()
  for (const component of elements.filter((element) => element.type === "source_component")) {
    const name = text(component.name) ?? text(component.reference_designator) ?? "(unnamed component)"
    const suppliers = isElement(component.supplier_part_numbers) ? component.supplier_part_numbers : {}
    const lcscPartNumbers = [...new Set([
      ...(Array.isArray(suppliers.jlcpcb) ? suppliers.jlcpcb : []),
      ...(Array.isArray(suppliers.lcsc) ? suppliers.lcsc : []),
    ].flatMap((value) => {
      const normalized = normalizeLcscPartNumber(value)
      return normalized ? [normalized] : []
    }))]
    const manufacturerPartNumber = text(component.manufacturer_part_number)
    const key = `${manufacturerPartNumber ?? ""}|${lcscPartNumbers[0] ?? name}`
    const existing = byKey.get(key)
    if (existing) {
      existing.quantity += 1
      existing.name = `${existing.name}, ${name}`
      continue
    }
    byKey.set(key, {
      sourceComponentId: text(component.source_component_id),
      name,
      manufacturerPartNumber,
      lcscPartNumbers,
      quantity: 1,
    })
  }
  return [...byKey.values()]
}

/** Price the design's components for a board quantity, listing every part that could not be priced. */
export async function estimateBomCost(circuitJson: unknown, client: SourcingClient, boards = 1): Promise<BomCostEstimate> {
  if (!Number.isInteger(boards) || boards < 1 || boards > 10000) throw new Error("Board quantity must be a whole number between 1 and 10000")
  const parts = listDesignParts(circuitJson)
  const lines: BomCostLine[] = []
  const unpriced: Array<{ name: string; reason: string }> = []
  let componentCostUsd: number | undefined

  for (const part of parts) {
    const quantity = part.quantity * boards
    const lcscPartNumber = part.lcscPartNumbers[0]
    if (!lcscPartNumber) {
      unpriced.push({ name: part.name, reason: "Circuit JSON records no LCSC part number for this component." })
      continue
    }
    let sourced: SourcedPart | null
    try {
      sourced = await client.lookup(lcscPartNumber)
    } catch (error) {
      unpriced.push({ name: part.name, reason: error instanceof Error ? error.message : String(error) })
      continue
    }
    if (!sourced) {
      unpriced.push({ name: part.name, reason: `The supplier index returned no part for ${lcscPartNumber}.` })
      continue
    }
    const extendedPriceUsd = sourced.unitPriceUsd === undefined ? undefined : round(sourced.unitPriceUsd * quantity)
    if (extendedPriceUsd === undefined) unpriced.push({ name: part.name, reason: `The supplier index lists no price for ${lcscPartNumber}.` })
    else componentCostUsd = round((componentCostUsd ?? 0) + extendedPriceUsd)
    lines.push({
      name: part.name,
      quantity,
      lcscPartNumber,
      unitPriceUsd: sourced.unitPriceUsd,
      extendedPriceUsd,
      stockQuantity: sourced.stockQuantity,
      isBasicPart: sourced.isBasicPart,
    })
  }

  return {
    boards,
    lines,
    unpriced,
    ...(componentCostUsd === undefined ? {} : { componentCostUsd }),
    limitations: BOM_LIMITATIONS,
  }
}

/** Report supplier stock for each design part, so preflight can flag parts that cannot be bought. */
export async function checkComponentAvailability(circuitJson: unknown, client: SourcingClient, boards = 1): Promise<AvailabilityReport> {
  const parts = listDesignParts(circuitJson)
  const report: AvailabilityReport = { parts: [], outOfStock: [], unknown: [] }
  for (const part of parts) {
    const lcscPartNumber = part.lcscPartNumbers[0]
    if (!lcscPartNumber) {
      report.parts.push({ name: part.name, status: "unknown" })
      report.unknown.push({ name: part.name, reason: "Circuit JSON records no LCSC part number for this component." })
      continue
    }
    let sourced: SourcedPart | null
    try {
      sourced = await client.lookup(lcscPartNumber)
    } catch (error) {
      report.parts.push({ name: part.name, lcscPartNumber, status: "unknown" })
      report.unknown.push({ name: part.name, reason: error instanceof Error ? error.message : String(error) })
      continue
    }
    const stockQuantity = sourced?.stockQuantity
    const required = part.quantity * boards
    if (stockQuantity === undefined) {
      report.parts.push({ name: part.name, lcscPartNumber, status: "unknown" })
      report.unknown.push({ name: part.name, reason: sourced ? `The supplier index lists no stock for ${lcscPartNumber}.` : `The supplier index returned no part for ${lcscPartNumber}.` })
      continue
    }
    const status = stockQuantity >= required ? "in-stock" : "out-of-stock"
    report.parts.push({ name: part.name, lcscPartNumber, stockQuantity, status })
    if (status === "out-of-stock") report.outOfStock.push(`${part.name} (${lcscPartNumber}: ${stockQuantity} in stock, ${required} needed)`)
  }
  return report
}

/** Parse a `1-999:0.0073,1000-:0.0034` price-tier string, returning the first tier's price. */
function firstTierPrice(value: unknown) {
  if (typeof value !== "string") return undefined
  const first = value.split(",")[0]?.split(":")[1]
  return finite(Number(first))
}

function isElement(value: unknown): value is Element {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
function text(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}
function finite(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}
function round(value: number) {
  return Math.round(value * 1e4) / 1e4
}
