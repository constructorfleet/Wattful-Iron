import assert from "node:assert/strict"
import { createServer } from "node:http"
import test from "node:test"
import { executeRemoteBuild } from "./build-client.js"

const token = "unit-test-build-runner-token-with-32-bytes"
const source = { entrypoint: "index.circuit.tsx", files: [{ path: "index.circuit.tsx", content: "export default () => <board />" }] }

test("app build client sends only the source snapshot with its private bearer token", async () => {
  let received: { authorization?: string; body?: unknown } = {}
  const server = createServer((request, response) => {
    let body = ""
    request.on("data", (chunk) => { body += chunk })
    request.on("end", () => {
      received = { authorization: request.headers.authorization, body: JSON.parse(body) }
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ circuitJson: [{ type: "pcb_board" }], isolation: "gvisor", runtime: "runsc" }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  try {
    const result = await executeRemoteBuild(source, { url: `http://127.0.0.1:${address.port}`, token })
    assert.deepEqual(received, { authorization: `Bearer ${token}`, body: source })
    assert.equal(result.isolation, "gvisor")
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
})

test("app build client rejects unexpected runner response fields", async () => {
  const server = createServer((_request, response) => response.end(JSON.stringify({ circuitJson: [], isolation: "gvisor", runtime: "runsc", command: "unsafe" })))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  try { await assert.rejects(executeRemoteBuild(source, { url: `http://127.0.0.1:${address.port}`, token })) }
  finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
})
