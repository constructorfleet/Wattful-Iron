import { z } from "zod"

const MAX_SOURCE_BYTES = 8 * 1024 * 1024
const MAX_RESPONSE_BYTES = 13 * 1024 * 1024
const runnerResponseSchema = z.object({
  circuitJson: z.array(z.record(z.string(), z.unknown())),
  isolation: z.enum(["gvisor", "container-only"]),
  runtime: z.string().min(1).max(64),
}).strict()

export type BuildSource = { entrypoint: string; files: Array<{ path: string; content: string }> }
export type IsolatedBuildResult = { circuitJson: unknown; isolation: "gvisor" | "container-only"; runtime: string }

export async function executeRemoteBuild(source: BuildSource, options: { url: string; token: string; timeoutMs?: number }): Promise<IsolatedBuildResult> {
  if (!options.token || Buffer.byteLength(options.token) < 32) throw new Error("Isolated build runner is not configured: BUILD_RUNNER_TOKEN must be at least 32 bytes")
  if (!options.url) throw new Error("Isolated build runner is not configured: BUILD_RUNNER_URL is required")
  const size = source.files.reduce((total, file) => total + Buffer.byteLength(file.path) + Buffer.byteLength(file.content), 0)
  if (size > MAX_SOURCE_BYTES) throw new Error("Project source exceeds the isolated build size limit")
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 160_000)
  try {
    const response = await fetch(new URL("/v1/build", options.url), {
      method: "POST",
      headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
      body: JSON.stringify(source),
      signal: controller.signal,
    })
    const body = await readLimited(response, MAX_RESPONSE_BYTES)
    let decoded: unknown
    try { decoded = JSON.parse(body) } catch { throw new Error("Build runner returned invalid JSON") }
    if (!response.ok) {
      const error = z.object({ error: z.string().max(16_000).optional() }).passthrough().safeParse(decoded)
      throw new Error(error.success && error.data.error ? error.data.error : `Build runner returned HTTP ${response.status}`)
    }
    const result = runnerResponseSchema.parse(decoded)
    return result
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Isolated build runner timed out")
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function readLimited(response: globalThis.Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ""
  const chunks: Buffer[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new Error("Build runner response exceeds the size limit")
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks).toString("utf8")
}
