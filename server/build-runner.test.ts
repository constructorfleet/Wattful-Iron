import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import request from "supertest"
import { createBuildRunnerApp, DockerEngineApi, splitDockerLogFrame, type DockerApi, type DockerContainerSpec } from "./build-runner.js"

class FakeDockerApi implements DockerApi {
  created?: DockerContainerSpec
  copied?: { containerId: string; path: string; archive: Buffer }
  removed: string[] = []
  killed: string[] = []
  wait: Promise<{ statusCode: number }> = Promise.resolve({ statusCode: 0 })
  logs = splitDockerLogFrame(1, Buffer.from(`@@WATTFUL_BUILD_RESULT@@${JSON.stringify([{ type: "pcb_board" }])}\n`))

  async createContainer(spec: DockerContainerSpec) { this.created = spec; return "job-1" }
  async putArchive(containerId: string, path: string, archive: Buffer) { this.copied = { containerId, path, archive } }
  async startContainer() {}
  async waitContainer() { return this.wait }
  async getLogs() { return this.logs }
  async killContainer(containerId: string) { this.killed.push(containerId) }
  async removeContainer(containerId: string) { this.removed.push(containerId) }
}

const token = "runner-secret-with-at-least-32-bytes-long"
const job = { entrypoint: "index.circuit.tsx", files: [{ path: "index.circuit.tsx", content: "export default () => <board />" }] }

test("runner creates a fixed, isolated, bounded container and removes it after success", async () => {
  const docker = new FakeDockerApi()
  const app = createBuildRunnerApp({ docker, token, image: "circuits:dev", runtime: "runsc" })
  const response = await request(app).post("/v1/build").set("Authorization", `Bearer ${token}`).send(job).expect(200)

  assert.deepEqual(response.body, { circuitJson: [{ type: "pcb_board" }], isolation: "gvisor", runtime: "runsc" })
  assert.equal(docker.created?.Image, "circuits:dev")
  assert.equal(docker.created?.HostConfig.Runtime, "runsc")
  assert.deepEqual(docker.created?.Entrypoint, ["node", "/app/dist/server/build-job.js"])
  assert.deepEqual(docker.created?.Cmd, ["index.circuit.tsx"])
  assert.equal(docker.created?.User, "node")
  assert.equal(docker.created?.HostConfig.NetworkMode, "none")
  assert.equal(docker.created?.HostConfig.ReadonlyRootfs, true)
  assert.deepEqual(docker.created?.HostConfig.CapDrop, ["ALL"])
  assert.deepEqual(docker.created?.HostConfig.SecurityOpt, ["no-new-privileges:true"])
  assert.ok(docker.created?.HostConfig.Memory && docker.created.HostConfig.Memory > 0)
  assert.ok(docker.created?.HostConfig.NanoCpus && docker.created.HostConfig.NanoCpus > 0)
  assert.ok(docker.created?.HostConfig.PidsLimit && docker.created.HostConfig.PidsLimit > 0)
  assert.deepEqual(docker.created?.HostConfig.Mounts, [])
  assert.deepEqual(docker.removed, ["job-1"])
  assert.equal(docker.copied?.path, "/tmp")
  assert.ok(docker.copied?.archive.includes(Buffer.from("build/index.circuit.tsx")))
})

test("runner rejects extra container controls and unsafe paths before contacting Docker", async () => {
  const docker = new FakeDockerApi()
  const app = createBuildRunnerApp({ docker, token, image: "circuits:dev", runtime: "runsc" })

  await request(app).post("/v1/build").set("Authorization", `Bearer ${token}`).send({ ...job, command: "id" }).expect(400)
  await request(app).post("/v1/build").set("Authorization", `Bearer ${token}`).send({
    entrypoint: "index.circuit.tsx",
    files: [{ path: "../outside.ts", content: "x" }, ...job.files],
  }).expect(400)
  assert.equal(docker.created, undefined)
})

test("runner requires its private bearer token", async () => {
  const docker = new FakeDockerApi()
  const app = createBuildRunnerApp({ docker, token, image: "circuits:dev", runtime: "runsc" })
  await request(app).post("/v1/build").send(job).expect(401)
  assert.equal(docker.created, undefined)
})

test("standard runc is reported explicitly and job failure still cleans up", async () => {
  const docker = new FakeDockerApi()
  docker.wait = Promise.resolve({ statusCode: 1 })
  docker.logs = splitDockerLogFrame(2, Buffer.from("@@WATTFUL_BUILD_ERROR@@compiler failed\n"))
  const app = createBuildRunnerApp({ docker, token, image: "circuits:dev", runtime: "runc" })
  const response = await request(app).post("/v1/build").set("Authorization", `Bearer ${token}`).send(job).expect(422)
  assert.equal(response.body.runtime, "runc")
  assert.equal(response.body.isolation, "container-only")
  assert.deepEqual(docker.removed, ["job-1"])
})

test("runner timeouts kill and remove the one-shot job container", async () => {
  const docker = new FakeDockerApi()
  docker.wait = new Promise(() => {})
  const app = createBuildRunnerApp({ docker, token, image: "circuits:dev", runtime: "runsc", timeoutMs: 10 })
  await request(app).post("/v1/build").set("Authorization", `Bearer ${token}`).send(job).expect(504)
  assert.deepEqual(docker.killed, ["job-1"])
  assert.deepEqual(docker.removed, ["job-1"])
})

test("runner bounds concurrent containers and rejects excess queued work", async () => {
  const docker = new FakeDockerApi()
  docker.wait = new Promise(() => {})
  const app = createBuildRunnerApp({ docker, token, image: "circuits:dev", runtime: "runsc", timeoutMs: 100, maxConcurrentJobs: 1 })
  const active = request(app).post("/v1/build").set("Authorization", `Bearer ${token}`).send(job).then((response) => response)
  await new Promise((resolve) => setTimeout(resolve, 1))
  await request(app).post("/v1/build").set("Authorization", `Bearer ${token}`).send(job).expect(429)
  assert.equal(docker.created?.Image, "circuits:dev")
  await active
})

test("Docker Engine log reads stop once the caller's byte cap is exceeded", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "fake-docker-engine-"))
  const socketPath = path.join(directory, "engine.sock")
  const server = createServer((_request, response) => response.end(Buffer.alloc(1025)))
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  try {
    const docker = new DockerEngineApi(`unix://${socketPath}`)
    await assert.rejects(docker.getLogs("job-1", 1024), /output limit/)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})

test("Docker integration runs a source snapshot in runsc when a local engine is available", { timeout: 180_000 }, async (context) => {
  const docker = new DockerEngineApi()
  const image = process.env.BUILD_JOB_IMAGE ?? "wattful-iron-build-job:local"
  let info: { Runtimes?: Record<string, unknown> }
  try { info = await docker.getInfo() } catch { context.skip("Docker Engine socket is unavailable") ; return }
  if (!info.Runtimes?.runsc) { context.skip("Docker Engine does not have the runsc runtime configured"); return }
  if (!await docker.hasImage(image)) { context.skip(`Build job image ${image} is not available locally`); return }
  const app = createBuildRunnerApp({ docker, token, image, runtime: "runsc" })
  const response = await request(app).post("/v1/build").set("Authorization", `Bearer ${token}`).send({
    entrypoint: "index.circuit.tsx",
    files: [{ path: "index.circuit.tsx", content: 'export default () => <board width="10mm" height="10mm" />' }],
  }).expect(200)
  assert.ok(response.body.circuitJson.some((item: { type?: string }) => item.type === "pcb_board"))
  assert.equal(response.body.isolation, "gvisor")
})
