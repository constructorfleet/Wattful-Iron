import { unzipSync, zipSync, type Unzipped } from "fflate"

const MANIFEST_PATH = "_wattful_project.json"
const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024
const MAX_EXPANDED_BYTES = 50 * 1024 * 1024
const MAX_FILE_BYTES = 10 * 1024 * 1024
const MAX_ENTRIES = 500
const utf8 = new TextDecoder("utf-8", { fatal: true })

export type ProjectArchiveManifest = { version: 1; name: string; entrypoint: string }
export type ProjectArchiveFile = { path: string; content: string }

export function createProjectArchive(manifest: ProjectArchiveManifest, files: ProjectArchiveFile[]) {
  const entries: Record<string, Uint8Array> = { [MANIFEST_PATH]: new TextEncoder().encode(JSON.stringify(manifest)) }
  for (const file of files) entries[file.path] = new TextEncoder().encode(file.content)
  const archive = zipSync(entries, { level: 6 })
  if (archive.byteLength > MAX_ARCHIVE_BYTES) throw new Error("Project archive exceeds the 20 MB download limit")
  return archive
}

export function parseProjectArchive(archive: Buffer): { manifest: ProjectArchiveManifest; files: ProjectArchiveFile[] } {
  if (archive.byteLength < 22 || archive.byteLength > MAX_ARCHIVE_BYTES) throw new Error("Project archive must be between 22 bytes and 20 MB")
  const entries = inspectCentralDirectory(archive)
  if (entries.length > MAX_ENTRIES) throw new Error("Project archive contains too many entries")
  let expandedBytes = 0
  for (const entry of entries) {
    if (entry.originalSize > MAX_FILE_BYTES) throw new Error("Project archive contains a file larger than 10 MB")
    expandedBytes += entry.originalSize
    if (expandedBytes > MAX_EXPANDED_BYTES) throw new Error("Expanded project archive exceeds 50 MB")
  }
  const decoded = unzipSync(archive, { filter: () => true }) as Unzipped
  const files: ProjectArchiveFile[] = []
  let manifest: ProjectArchiveManifest | undefined
  for (const [name, content] of Object.entries(decoded)) {
    if (name.endsWith("/")) continue
    if (name === MANIFEST_PATH) {
      if (content.byteLength > 16_384) throw new Error("Project archive manifest is too large")
      let parsed: unknown
      try { parsed = JSON.parse(utf8.decode(content)) } catch { throw new Error("Project archive manifest must be valid UTF-8 JSON") }
      if (!isManifest(parsed)) throw new Error("Project archive manifest must include version 1, a project name, and an entrypoint")
      manifest = parsed
      continue
    }
    let text: string
    try { text = utf8.decode(content) } catch { throw new Error(`Project archive file ${name} must be UTF-8 text`) }
    files.push({ path: name, content: text })
  }
  if (!manifest) throw new Error("Project archive is missing _wattful_project.json")
  if (files.length === 0 || files.length > MAX_ENTRIES) throw new Error("Project archive must contain between 1 and 500 project files")
  if (new Set(files.map(({ path }) => path)).size !== files.length) throw new Error("Project archive filenames must be unique")
  for (const file of files) if (files.some(({ path }) => path.startsWith(`${file.path}/`))) throw new Error("Project archive file paths may not overlap")
  if (!files.some(({ path }) => path === manifest!.entrypoint)) throw new Error("Project archive entrypoint is missing")
  return { manifest, files }
}

function isManifest(value: unknown): value is ProjectArchiveManifest {
  if (typeof value !== "object" || value === null) return false
  const item = value as Record<string, unknown>
  return item.version === 1 && typeof item.name === "string" && item.name.trim().length > 0 && item.name.length <= 100 &&
    typeof item.entrypoint === "string" && item.entrypoint.length > 0 && item.entrypoint.length <= 240
}

function inspectCentralDirectory(archive: Buffer): Array<{ name: string; originalSize: number }> {
  const min = Math.max(0, archive.length - 65_557)
  let eocd = -1
  for (let offset = archive.length - 22; offset >= min; offset--) {
    if (archive.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break }
  }
  if (eocd < 0) throw new Error("Project archive is not a valid ZIP file")
  const count = archive.readUInt16LE(eocd + 10)
  const directorySize = archive.readUInt32LE(eocd + 12)
  const directoryOffset = archive.readUInt32LE(eocd + 16)
  if (count === 0xffff || directoryOffset === 0xffffffff || directorySize === 0xffffffff || directoryOffset + directorySize > eocd) {
    throw new Error("Project archive uses unsupported ZIP64 metadata")
  }
  if (count > MAX_ENTRIES || directoryOffset + directorySize > archive.length) throw new Error("Project archive contains too many entries or invalid directory metadata")
  const entries: Array<{ name: string; originalSize: number }> = []
  let offset = directoryOffset
  for (let index = 0; index < count; index++) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== 0x02014b50) throw new Error("Project archive has an invalid central directory")
    const flags = archive.readUInt16LE(offset + 8)
    const compressedSize = archive.readUInt32LE(offset + 20)
    const originalSize = archive.readUInt32LE(offset + 24)
    const nameLength = archive.readUInt16LE(offset + 28)
    const extraLength = archive.readUInt16LE(offset + 30)
    const commentLength = archive.readUInt16LE(offset + 32)
    const externalAttributes = archive.readUInt32LE(offset + 38)
    const madeBy = archive.readUInt16LE(offset + 4) >>> 8
    const end = offset + 46 + nameLength + extraLength + commentLength
    if (end > archive.length || flags & 1) throw new Error("Project archive contains invalid or encrypted entries")
    if (compressedSize === 0xffffffff || originalSize === 0xffffffff) throw new Error("Project archive uses unsupported ZIP64 metadata")
    const rawName = archive.subarray(offset + 46, offset + 46 + nameLength)
    let name: string
    try { name = utf8.decode(rawName) } catch { throw new Error("Project archive filenames must be UTF-8") }
    if (!name || /[\u0000-\u001f\u007f]/.test(name) || name.includes("\\") || name.includes(":") || name.startsWith("/") || name.split("/").some((part) => part === ".." || part === "." || part === "" && !name.endsWith("/"))) {
      throw new Error("Project archive contains an unsafe path")
    }
    if ((externalAttributes & 0x400) !== 0) throw new Error("Project archive may not contain reparse-point entries")
    const unixType = (externalAttributes >>> 16) & 0xf000
    if (madeBy === 3 && unixType !== 0 && unixType !== 0x8000 && !(name.endsWith("/") && unixType === 0x4000)) {
      throw new Error("Project archive may contain only regular files and directories")
    }
    if ((name !== MANIFEST_PATH && name.split("/").some((part) => part.startsWith("."))) || name === "node_modules" || name.startsWith("node_modules/") || name === "dist" || name.startsWith("dist/")) {
      throw new Error("Project archive contains a reserved path")
    }
    entries.push({ name, originalSize })
    offset = end
  }
  if (offset !== directoryOffset + directorySize) throw new Error("Project archive has inconsistent directory metadata")
  if (new Set(entries.map(({ name }) => name)).size !== entries.length) throw new Error("Project archive filenames must be unique")
  return entries
}
