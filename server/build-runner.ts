import { randomUUID, timingSafeEqual } from "node:crypto"
import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http"
import { readFile } from "node:fs/promises"
import express, { type Express, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"

const RESULT_PREFIX = "@@WATTFUL_BUILD_RESULT@@"
const MAX_FILES = 200
const MAX_SOURCE_BYTES = 8 * 1024 * 1024
const MAX_RESULT_BYTES = 12 * 1024 * 1024
const MAX_LOG_BYTES = 14 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MEMORY_BYTES = 1024 * 1024 * 1024
const DEFAULT_NANO_CPUS = 2_000_000_000
const DEFAULT_PIDS_LIMIT = 128

const buildRequestSchema = z.object({
  entrypoint: z.string().min(1).max(94),
  files: z.array(z.object({ path: z.string().min(1).max(94), content: z.string() }).strict()).min(1).max(MAX_FILES),
}).strict()

export type BuildRequest = z.infer<typeof buildRequestSchema>
export type DockerContainerSpec = {
  Image: string
  Entrypoint: string[]
  Cmd: string[]
  User: string
  WorkingDir: string
  Env: string[]
  Tty: false
  OpenStdin: false
  HostConfig: {
    Runtime: string
    NetworkMode: "none"
    ReadonlyRootfs: boolean
    CapDrop: ["ALL"]
    SecurityOpt: ["no-new-privileges:true"]
    Memory: number
    NanoCpus: number
    PidsLimit: number
    Tmpfs: Record<string, string>
    Mounts: []
    Binds: []
    Devices: []
    Privileged: false
    AutoRemove: false
    RestartPolicy: { Name: "no" }
    LogConfig: { Type: "local"; Config: { "max-size": string; "max-file": string } }
  }
}

export interface DockerApi {
  createContainer(spec: DockerContainerSpec): Promise<string>
  putArchive(containerId: string, path: string, archive: Buffer): Promise<void>
  startContainer(containerId: string): Promise<void>
  waitContainer(containerId: string): Promise<{ statusCode: number }>
  getLogs(containerId: string, maxBytes: number): Promise<Buffer>
  killContainer(containerId: string): Promise<void>
  removeContainer(containerId: string): Promise<void>
}

export type BuildRunnerOptions = {
  docker: DockerApi
  token: string
  image: string
  runtime: string
  timeoutMs?: number
  memoryBytes?: number
  nanoCpus?: number
  pidsLimit?: number
  maxConcurrentJobs?: number
}

export class BuildRunnerError extends Error {
  constructor(message: string, readonly status: number, readonly timedOut = false) { super(message) }
}

export function createBuildRunnerApp(options: BuildRunnerOptions): Express {
  if (Buffer.byteLength(options.token) < 32) throw new Error("Build runner token must be at least 32 bytes")
  if (!options.image.trim()) throw new Error("Build job image is required")
  if (!new Set(["runsc", "runc"]).has(options.runtime)) throw new Error("BUILD_SANDBOX_RUNTIME must be runsc or runc")
  if (!Number.isInteger(options.maxConcurrentJobs ?? 2) || (options.maxConcurrentJobs ?? 2) < 1) throw new Error("maxConcurrentJobs must be a positive integer")
  const app = express()
  let activeJobs = 0
  const reservedRequests = new WeakSet<Request>()
  const maxConcurrentJobs = options.maxConcurrentJobs ?? 2
  const releaseReservation = (request: Request) => {
    if (reservedRequests.delete(request)) activeJobs--
  }
  app.disable("x-powered-by")
  app.get("/healthz", (_request, response) => response.json({ status: "ok", runtime: options.runtime, isolation: isolationLevel(options.runtime) }))
  app.post("/v1/build", (request, response, next) => {
    if (!authorized(request, options.token)) return response.status(401).json({ error: "Unauthorized" })
    if (activeJobs >= maxConcurrentJobs) return response.status(429).json({ error: "Build runner is at capacity" })
    activeJobs++
    reservedRequests.add(request)
    next()
  }, express.json({ limit: "17mb", strict: true }), (request, response, next) => {
    const parsed = buildRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      releaseReservation(request)
      return response.status(400).json({ error: "Invalid build request", details: parsed.error.issues.map(({ path, message }) => ({ path, message })) })
    }
    try { validateBuildRequest(parsed.data) } catch (error) {
      releaseReservation(request)
      return response.status(400).json({ error: error instanceof Error ? error.message : "Invalid build request" })
    }
    void executeBuild(options, parsed.data).then((result) => response.json(result)).catch(next).finally(() => releaseReservation(request))
  })
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    releaseReservation(_request)
    if (error instanceof BuildRunnerError) {
      response.status(error.status).json({ error: error.message, runtime: options.runtime, isolation: isolationLevel(options.runtime) })
      return
    }
    console.error("Build runner request failed", error)
    if (typeof error === "object" && error !== null && "status" in error && error.status === 400) {
      response.status(400).json({ error: "Invalid build request body" })
      return
    }
    response.status(500).json({ error: "Build runner failed" })
  })
  return app
}

export async function executeBuild(options: BuildRunnerOptions, job: BuildRequest) {
  validateBuildRequest(job)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const containerId = await options.docker.createContainer(containerSpec(options, job.entrypoint))
  try {
    await options.docker.putArchive(containerId, "/app", createTar(job.files.map(({ path, content }) => ({ path: `build/${path}`, content }))))
    await options.docker.startContainer(containerId)
    const wait = await withTimeout(options.docker.waitContainer(containerId), timeoutMs)
    const logs = await options.docker.getLogs(containerId, MAX_LOG_BYTES)
    if (wait.statusCode !== 0) {
      const diagnostic = readBuildError(logs) ?? `tscircuit build exited with status ${wait.statusCode}`
      throw new BuildRunnerError(diagnostic, 422)
    }
    const circuitJson = readBuildResult(logs)
    if (Buffer.byteLength(JSON.stringify(circuitJson)) > MAX_RESULT_BYTES) throw new BuildRunnerError("Circuit JSON output exceeds the configured size limit", 422)
    return { circuitJson, isolation: isolationLevel(options.runtime), runtime: options.runtime }
  } catch (error) {
    if (error instanceof BuildRunnerError && error.timedOut) await options.docker.killContainer(containerId).catch(() => undefined)
    throw error
  } finally {
    await options.docker.removeContainer(containerId).catch(() => undefined)
  }
}

function containerSpec(options: BuildRunnerOptions, entrypoint: string): DockerContainerSpec {
  return {
    Image: options.image,
    Entrypoint: ["node", "/app/dist/server/build-job.js"],
    Cmd: [entrypoint],
    User: "65532:65532",
    WorkingDir: "/tmp",
    Env: ["PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/tmp", "TMPDIR=/tmp", "CI=1", "NODE_ENV=production", "BUN_RUNTIME_TRANSPILER_CACHE_PATH=0"],
    Tty: false,
    OpenStdin: false,
    HostConfig: {
      Runtime: options.runtime,
      NetworkMode: "none",
      // Docker's archive API refuses writes into containers with a read-only
      // rootfs, even when the destination is a bounded tmpfs mount. The job
      // therefore runs as an unprivileged UID against root-owned image files.
      ReadonlyRootfs: false,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Memory: options.memoryBytes ?? DEFAULT_MEMORY_BYTES,
      NanoCpus: options.nanoCpus ?? DEFAULT_NANO_CPUS,
      PidsLimit: options.pidsLimit ?? DEFAULT_PIDS_LIMIT,
      Tmpfs: { "/tmp": "rw,nosuid,nodev,noexec,size=512m,mode=1777" },
      Mounts: [],
      Binds: [],
      Devices: [],
      Privileged: false,
      AutoRemove: false,
      RestartPolicy: { Name: "no" },
      LogConfig: { Type: "local", Config: { "max-size": "16m", "max-file": "2" } },
    },
  }
}

function validateBuildRequest(job: BuildRequest) {
  const paths = new Set<string>()
  let total = 0
  for (const file of job.files) {
    if (!safeBuildPath(file.path)) throw new Error(`Invalid project file path: ${file.path}`)
    if (paths.has(file.path)) throw new Error(`Duplicate project file path: ${file.path}`)
    paths.add(file.path)
    total += Buffer.byteLength(file.content)
    if (total > MAX_SOURCE_BYTES) throw new Error("Project source exceeds the build runner size limit")
  }
  if (!paths.has(job.entrypoint)) throw new Error("Build entrypoint is not included in the source snapshot")
  if (!/\.(circuit\.)?(tsx?|jsx?)$/.test(job.entrypoint)) throw new Error("Build entrypoint must be a TypeScript or JavaScript source file")
}

function safeBuildPath(value: string) {
  if (!value || value.startsWith("/") || value.includes("\\") || value.includes("\0")) return false
  const parts = value.split("/")
  return parts.every((part) => part !== "" && part !== "." && part !== ".." && !part.startsWith(".")) &&
    !parts.some((part) => ["node_modules", "dist", ".workbench", ".git"].includes(part)) &&
    /^[A-Za-z0-9_.@/-]+$/.test(value)
}

function authorized(request: Request, token: string) {
  const supplied = request.get("authorization") ?? ""
  const expected = `Bearer ${token}`
  const actualBytes = Buffer.from(supplied)
  const expectedBytes = Buffer.from(expected)
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

function isolationLevel(runtime: string) { return runtime === "runsc" ? "gvisor" : "container-only" }

function readBuildResult(logs: Buffer): unknown {
  const text = decodeDockerLogs(logs).toString("utf8")
  const line = text.split(/\r?\n/).reverse().find((entry) => entry.startsWith(RESULT_PREFIX))
  if (!line) throw new BuildRunnerError("The isolated build did not return Circuit JSON", 422)
  try { return JSON.parse(line.slice(RESULT_PREFIX.length)) } catch { throw new BuildRunnerError("The isolated build returned invalid Circuit JSON", 422) }
}

function readBuildError(logs: Buffer) {
  const text = decodeDockerLogs(logs).toString("utf8")
  const line = text.split(/\r?\n/).reverse().find((entry) => entry.startsWith("@@WATTFUL_BUILD_ERROR@@"))
  return line?.slice("@@WATTFUL_BUILD_ERROR@@".length).slice(0, 16_000)
}

function decodeDockerLogs(input: Buffer) {
  const output: Buffer[] = []
  let offset = 0
  while (offset + 8 <= input.length) {
    const length = input.readUInt32BE(offset + 4)
    if (offset + 8 + length > input.length) throw new BuildRunnerError("Docker returned incomplete build output", 502)
    output.push(input.subarray(offset + 8, offset + 8 + length))
    offset += 8 + length
  }
  if (offset !== input.length) throw new BuildRunnerError("Docker returned malformed build output", 502)
  return Buffer.concat(output)
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new BuildRunnerError("Isolated build exceeded its time limit", 504, true)), timeoutMs)
    promise.then((value) => { clearTimeout(timer); resolve(value) }, (error) => { clearTimeout(timer); reject(error) })
  })
}

type TarFile = { path: string; content: string }
function createTar(files: TarFile[]) {
  const blocks: Buffer[] = []
  const directories = new Set(["build/"])
  for (const file of files) {
    const parts = file.path.split("/")
    for (let index = 1; index < parts.length; index++) directories.add(`${parts.slice(0, index).join("/")}/`)
  }
  for (const directory of [...directories].sort((left, right) => left.split("/").length - right.split("/").length)) {
    blocks.push(createTarHeader(directory, 0o555, 0, true))
  }
  for (const file of files) {
    const content = Buffer.from(file.content)
    blocks.push(createTarHeader(file.path, 0o444, content.length, false), content)
    const remainder = content.length % 512
    if (remainder) blocks.push(Buffer.alloc(512 - remainder))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

function createTarHeader(filename: string, mode: number, size: number, directory: boolean) {
  const header = Buffer.alloc(512)
  writeTarString(header, 0, 100, filename)
  writeTarOctal(header, 100, 8, mode)
  writeTarOctal(header, 108, 8, 65532)
  writeTarOctal(header, 116, 8, 65532)
  writeTarOctal(header, 124, 12, size)
  writeTarOctal(header, 136, 12, 0)
  header.fill(0x20, 148, 156)
  header[156] = directory ? 0x35 : 0x30
  writeTarString(header, 257, 6, "ustar")
  writeTarString(header, 263, 2, "00")
  writeTarString(header, 265, 32, "node")
  writeTarString(header, 297, 32, "node")
  writeTarOctal(header, 148, 8, header.reduce((sum, byte) => sum + byte, 0))
  return header
}

function writeTarString(buffer: Buffer, offset: number, length: number, value: string) {
  Buffer.from(value).copy(buffer, offset, 0, length)
}
function writeTarOctal(buffer: Buffer, offset: number, length: number, value: number) {
  buffer.write(`${Math.floor(value).toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii")
}

export class DockerEngineApi implements DockerApi {
  readonly basePath: string
  readonly socketPath: string

  constructor(address = process.env.DOCKER_HOST ?? "unix:///var/run/docker.sock") {
    if (!address.startsWith("unix://")) throw new Error("DOCKER_HOST must be a Unix socket path")
    this.basePath = "/v1.43"
    this.socketPath = address.slice("unix://".length)
  }

  async createContainer(spec: DockerContainerSpec) {
    const response = await this.send("POST", `/containers/create?name=wattful-build-${cryptoRandomId()}`, JSON.stringify(spec), "application/json")
    const body = JSON.parse(response.toString("utf8")) as { Id?: string }
    if (!body.Id) throw new Error("Docker did not return a container ID")
    return body.Id
  }
  async putArchive(containerId: string, path: string, archive: Buffer) {
    await this.send("PUT", `/containers/${encodeURIComponent(containerId)}/archive?path=${encodeURIComponent(path)}`, archive, "application/x-tar")
  }
  async startContainer(containerId: string) { await this.send("POST", `/containers/${encodeURIComponent(containerId)}/start`) }
  async waitContainer(containerId: string) {
    const response = await this.send("POST", `/containers/${encodeURIComponent(containerId)}/wait?condition=not-running`, undefined, undefined, DEFAULT_TIMEOUT_MS + 10_000)
    const body = JSON.parse(response.toString("utf8")) as { StatusCode: number }
    return { statusCode: body.StatusCode }
  }
  async getLogs(containerId: string, maxBytes: number) { return this.send("GET", `/containers/${encodeURIComponent(containerId)}/logs?stdout=true&stderr=true`, undefined, undefined, 10_000, maxBytes) }
  async killContainer(containerId: string) { await this.send("POST", `/containers/${encodeURIComponent(containerId)}/kill`).catch(() => undefined) }
  async removeContainer(containerId: string) { await this.send("DELETE", `/containers/${encodeURIComponent(containerId)}?force=true&v=true`).catch(() => undefined) }
  async getInfo() { return JSON.parse((await this.send("GET", "/info")).toString("utf8")) as { Runtimes?: Record<string, unknown> } }
  async hasImage(image: string) {
    try { await this.send("GET", `/images/${encodeURIComponent(image)}/json`); return true } catch { return false }
  }

  private async send(method: string, route: string, body?: string | Buffer, contentType?: string, timeoutMs = 10_000, maxBytes = MAX_LOG_BYTES) {
    const options: RequestOptions = {
      method,
      path: `${this.basePath}${route}`,
      socketPath: this.socketPath,
      headers: { ...(contentType ? { "content-type": contentType } : {}), ...(body ? { "content-length": Buffer.byteLength(body) } : {}) },
    }
    return new Promise<Buffer>((resolve, reject) => {
      const request = httpRequest(options, (response: IncomingMessage) => {
        const chunks: Buffer[] = []
        let total = 0
        response.once("error", reject)
        response.on("data", (chunk: Buffer) => {
          total += chunk.length
          if (total > maxBytes) {
            const error = new Error("Docker response exceeds the output limit")
            response.destroy()
            request.destroy()
            reject(error)
            return
          }
          chunks.push(chunk)
        })
        response.on("end", () => {
          const result = Buffer.concat(chunks)
          if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) reject(new Error(`Docker Engine API returned HTTP ${response.statusCode}: ${result.toString("utf8").slice(0, 1000)}`))
          else resolve(result)
        })
      })
      request.setTimeout(timeoutMs, () => request.destroy(new Error("Docker Engine API request timed out")))
      request.once("error", reject)
      if (body) request.write(body)
      request.end()
    })
  }
}

function cryptoRandomId() { return randomUUID().replaceAll("-", "") }

export async function startBuildRunnerServer() {
  const token = await readRunnerToken()
  if (!token) throw new Error("BUILD_RUNNER_TOKEN is required")
  const app = createBuildRunnerApp({
    docker: new DockerEngineApi(),
    token,
    image: process.env.BUILD_JOB_IMAGE ?? "ghcr.io/constructorfleet/wattful-iron:latest",
    runtime: process.env.BUILD_SANDBOX_RUNTIME ?? "runsc",
  })
  const port = Number(process.env.BUILD_RUNNER_PORT ?? 3020)
  await new Promise<void>((resolve, reject) => {
    const server = app.listen(port, "0.0.0.0", () => resolve())
    server.requestTimeout = 30_000
    server.headersTimeout = 10_000
    server.keepAliveTimeout = 5_000
    server.once("error", reject)
  })
  console.log(`Build runner listening on ${port}; isolation runtime: ${process.env.BUILD_SANDBOX_RUNTIME ?? "runsc"}`)
}

async function readRunnerToken() {
  const filename = process.env.BUILD_RUNNER_TOKEN_FILE
  if (filename) return (await readFile(filename, "utf8")).trim()
  return process.env.BUILD_RUNNER_TOKEN ?? ""
}

export function splitDockerLogFrame(stream: number, payload: Buffer) {
  const header = Buffer.alloc(8)
  header[0] = stream
  header.writeUInt32BE(payload.length, 4)
  return Buffer.concat([header, payload])
}
