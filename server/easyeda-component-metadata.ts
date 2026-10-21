import { execFile as execFileCallback } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { KicadToCircuitJsonConverter } from "kicad-to-circuit-json"
import { convertSchematicV6 } from "easyeda2kicad6"

const execFile = promisify(execFileCallback)

type Item = Record<string, unknown>

type EasyedaComponent = { x: number; y: number; reference: string; value: string; package?: string; manufacturerPartNumber?: string }

function attribute(library: string, key: string) {
  const marker = `${key}\``
  const start = library.indexOf(marker)
  if (start < 0) return undefined
  const valueStart = start + marker.length
  const end = library.indexOf("`", valueStart)
  return library.slice(valueStart, end < 0 ? undefined : end).trim()
}

function placedComponents(document: unknown): EasyedaComponent[] {
  const root = document as { schematics?: Array<{ dataStr?: { shape?: unknown[] } }> }
  const shapes = root.schematics?.[0]?.dataStr?.shape
  if (!Array.isArray(shapes)) return []
  return shapes.flatMap((value) => {
    if (typeof value !== "string" || !value.startsWith("LIB~")) return []
    const chunks = value.split("#@$")
    const fields = chunks[0]!.split("~")
    const x = Number(fields[1]), y = Number(fields[2])
    const reference = chunks.find((part) => part.startsWith("T~P~"))?.split("~")[12]?.trim()
    const displayValue = chunks.find((part) => part.startsWith("T~N~"))?.split("~")[12]?.trim()
    if (!Number.isFinite(x) || !Number.isFinite(y) || !reference || !/^[A-Z]+\d+$/i.test(reference)) return []
    const manufacturerPartNumber = attribute(chunks[0]!, "Manufacturer Part")
    return [{ x, y, reference, value: displayValue ?? "", package: attribute(chunks[0]!, "package"), manufacturerPartNumber: manufacturerPartNumber && manufacturerPartNumber !== "?" ? manufacturerPartNumber : undefined }]
  })
}

function centerPoint(value: unknown): { x: number; y: number } | undefined {
  if (!value || typeof value !== "object") return undefined
  const { x, y } = value as { x?: unknown; y?: unknown }
  return typeof x === "number" && typeof y === "number" ? { x, y } : undefined
}

/** Restores EasyEDA instance fields the KiCad intermediate converter flattens into free text. */
export function enrichEasyedaComponentMetadata(circuit: unknown, documents: unknown[]): unknown {
  if (!Array.isArray(circuit)) return circuit
  const instances = documents.flatMap(placedComponents)
  const components = (circuit as Item[]).filter((item) => item.type === "source_component")
  const symbols = (circuit as Item[]).filter((item) => item.type === "schematic_component")
  const used = new Set<number>()
  const enriched = new Map<string, EasyedaComponent>()
  for (const component of components) {
    const symbol = symbols.find((item) => item.source_component_id === component.source_component_id)
    const center = centerPoint(symbol?.center)
    if (!center || !Number.isFinite(center.x) || !Number.isFinite(center.y)) continue
    // easyeda2kicad6's sheet coordinates map to Circuit JSON at this scale and origin.
    const rawX = (center.x + 7) / (25.4 / 1500)
    const rawY = (9.9 - center.y) / (25.4 / 1500)
    let bestIndex = -1, bestDistance = Infinity
    instances.forEach((instance, index) => {
      if (used.has(index)) return
      const distance = Math.hypot(instance.x - rawX, instance.y - rawY)
      if (distance < bestDistance) { bestDistance = distance; bestIndex = index }
    })
    if (bestIndex >= 0 && bestDistance < 1.5) {
      used.add(bestIndex)
      enriched.set(String(component.source_component_id), instances[bestIndex]!)
    }
  }
  return (circuit as Item[]).map((item) => {
    if (item.type !== "source_component") return item
    const instance = enriched.get(String(item.source_component_id))
    if (!instance) return item
    return {
      ...item,
      name: instance.reference,
      display_name: instance.value || item.display_name,
      display_value: instance.value || item.display_value,
      ...(instance.manufacturerPartNumber ? { manufacturer_part_number: instance.manufacturerPartNumber } : { manufacturer_part_number: undefined }),
      ...(instance.package ? { easyeda_package: instance.package } : {}),
    }
  })
}

export async function convertEasyedaFileToCircuit(filename: string, contents: string, kicadCliPath: string): Promise<unknown> {
  let document: { docType?: unknown; schematics?: unknown }
  try { document = JSON.parse(contents) as typeof document } catch { throw new Error("Retained EasyEDA file is not valid JSON") }
  if (document.docType !== "5" || !Array.isArray(document.schematics) || !document.schematics.length) throw new Error("Retained file is not an EasyEDA Standard schematic")
  const [converted] = convertSchematicV6(document as never, 1, filename.replace(/\.json$/i, ""))
  if (!converted?.trim()) throw new Error("EasyEDA converter returned an empty schematic")
  const directory = await mkdtemp(path.join(tmpdir(), "wattful-easyeda-refresh-"))
  try {
    const schematicPath = path.join(directory, `${path.basename(filename, ".json")}.kicad_sch`)
    await writeFile(schematicPath, converted)
    await execFile(kicadCliPath, ["sch", "upgrade", "--force", schematicPath], { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 })
    const upgraded = await readFile(schematicPath, "utf8")
    const converter = new KicadToCircuitJsonConverter()
    converter.addFile(path.basename(schematicPath), upgraded.replace(/\s+\((?:show_name|do_not_autoplace)\s+(?:yes|no)\)/g, ""))
    converter.runUntilFinished()
    return enrichEasyedaComponentMetadata(converter.getOutput(), [document])
  } finally { await rm(directory, { recursive: true, force: true }) }
}
