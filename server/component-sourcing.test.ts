import assert from "node:assert/strict"
import { test } from "node:test"
import {
  checkComponentAvailability,
  createSourcingClient,
  estimateBomCost,
  listDesignParts,
  normalizeLcscPartNumber,
} from "./component-sourcing.js"

const part = (lcsc: number, overrides: Record<string, unknown> = {}) => ({
  lcsc, mfr: `MFR-${lcsc}`, package: "0603", is_basic: true, is_preferred: false,
  description: "Thick film resistor", stock: 1000, price: 0.0123, ...overrides,
})

/** A fetch stub that answers JLCSearch-shaped requests and records the URLs it received. */
function stubFetch(responder: (url: string) => { status?: number; body: string }) {
  const calls: string[] = []
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    const { status = 200, body } = responder(url)
    return new Response(body, { status })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const client = (responder: (url: string) => { status?: number; body: string }) => {
  const { fetchImpl, calls } = stubFetch(responder)
  return { client: createSourcingClient({ baseUrl: "https://parts.example/", fetchImpl }), calls }
}

test("normalizes LCSC part numbers and rejects anything else", () => {
  assert.equal(normalizeLcscPartNumber("C2040"), "C2040")
  assert.equal(normalizeLcscPartNumber(" c2040 "), "C2040")
  assert.equal(normalizeLcscPartNumber("2040"), "C2040")
  assert.equal(normalizeLcscPartNumber("RP2040"), undefined)
  assert.equal(normalizeLcscPartNumber(undefined), undefined)
})

test("reads supplier fields for a part and caches the lookup", async () => {
  const { client: sourcing, calls } = client(() => ({ body: JSON.stringify({ components: [part(1), part(2040, { mfr: "RP2040", price: 0.9941, stock: 47778, is_basic: false })] }) }))
  const sourced = await sourcing.lookup("C2040")
  assert.deepEqual(sourced, {
    lcscPartNumber: "C2040",
    manufacturerPartNumber: "RP2040",
    package: "0603",
    description: "Thick film resistor",
    stockQuantity: 47778,
    unitPriceUsd: 0.9941,
    isBasicPart: false,
    isPreferredPart: false,
  })
  await sourcing.lookup("c2040")
  assert.equal(calls.length, 1, "the second lookup is served from cache")
  assert.match(calls[0]!, /^https:\/\/parts\.example\/api\/search\?q=C2040&limit=10$/)
})

test("reads the first quantity-break price when the supplier returns price tiers", async () => {
  const { client: sourcing } = client(() => ({ body: JSON.stringify({ components: [part(2286, { price: "1-999:0.0073,1000-:0.0034" })] }) }))
  assert.equal((await sourcing.lookup("C2286"))?.unitPriceUsd, 0.0073)
})

test("reports supplier failures instead of returning an empty part", async () => {
  const notFound = client(() => ({ body: JSON.stringify({ components: [part(1)] }) }))
  assert.equal(await notFound.client.lookup("C999"), null)

  const broken = client(() => ({ status: 502, body: "bad gateway" }))
  await assert.rejects(() => broken.client.lookup("C12"), /Component sourcing lookup for C12 failed: supplier responded with HTTP 502/)

  const garbage = client(() => ({ body: "<html>maintenance</html>" }))
  await assert.rejects(() => garbage.client.lookup("C12"), /not JSON/)

  const { client: sourcing } = client(() => ({ body: "{}" }))
  await assert.rejects(() => sourcing.lookup("RP2040"), /is not an LCSC part number/)
  assert.throws(() => createSourcingClient({ baseUrl: "ftp://parts.example" }), /must use http or https/)
})

const circuit = [
  { type: "source_component", source_component_id: "sc1", name: "R1", ftype: "simple_resistor", manufacturer_part_number: "0603WAF1002", supplier_part_numbers: { jlcpcb: ["C25804"] } },
  { type: "source_component", source_component_id: "sc2", name: "R2", ftype: "simple_resistor", manufacturer_part_number: "0603WAF1002", supplier_part_numbers: { jlcpcb: ["C25804"] } },
  { type: "source_component", source_component_id: "sc3", name: "U1", ftype: "simple_chip", supplier_part_numbers: { jlcpcb: ["C2040"] } },
  { type: "source_component", source_component_id: "sc4", name: "J1", ftype: "simple_connector" },
]

test("groups identical design parts and counts how many the board needs", () => {
  const parts = listDesignParts(circuit)
  assert.deepEqual(parts.map(({ name, quantity, lcscPartNumbers }) => [name, quantity, lcscPartNumbers]), [
    ["R1, R2", 2, ["C25804"]],
    ["U1", 1, ["C2040"]],
    ["J1", 1, []],
  ])
})

test("prices the BOM for a board quantity and lists every part it could not price", async () => {
  const { client: sourcing } = client((url) => ({
    body: url.includes("C25804")
      ? JSON.stringify({ components: [part(25804, { price: 0.002, stock: 500000 })] })
      : JSON.stringify({ components: [part(2040, { price: undefined, stock: 10 })] }),
  }))

  const estimate = await estimateBomCost(circuit, sourcing, 10)
  assert.equal(estimate.boards, 10)
  assert.deepEqual(estimate.lines.map(({ name, quantity, extendedPriceUsd }) => [name, quantity, extendedPriceUsd]), [
    ["R1, R2", 20, 0.04],
    ["U1", 10, undefined],
  ])
  assert.equal(estimate.componentCostUsd, 0.04)
  assert.deepEqual(estimate.unpriced, [
    { name: "U1", reason: "The supplier index lists no price for C2040." },
    { name: "J1", reason: "Circuit JSON records no LCSC part number for this component." },
  ])
  assert.ok(estimate.limitations.some((item) => item.includes("Board fabrication, assembly")))
  await assert.rejects(() => estimateBomCost(circuit, sourcing, 0), /between 1 and 10000/)
})

test("keeps a supplier outage out of the total instead of pricing it as zero", async () => {
  const { client: sourcing } = client(() => ({ status: 500, body: "down" }))
  const estimate = await estimateBomCost(circuit, sourcing)
  assert.equal(estimate.componentCostUsd, undefined)
  assert.equal(estimate.lines.length, 0)
  assert.match(estimate.unpriced[0]!.reason, /HTTP 500/)
})

test("separates in-stock, short, and unknown parts when checking availability", async () => {
  const { client: sourcing } = client((url) => ({
    body: url.includes("C25804")
      ? JSON.stringify({ components: [part(25804, { stock: 1 })] })
      : JSON.stringify({ components: [part(2040, { stock: 500 })] }),
  }))

  const report = await checkComponentAvailability(circuit, sourcing, 1)
  assert.deepEqual(report.parts.map(({ name, status }) => [name, status]), [["R1, R2", "out-of-stock"], ["U1", "in-stock"], ["J1", "unknown"]])
  assert.deepEqual(report.outOfStock, ["R1, R2 (C25804: 1 in stock, 2 needed)"])
  assert.deepEqual(report.unknown, [{ name: "J1", reason: "Circuit JSON records no LCSC part number for this component." }])
})
