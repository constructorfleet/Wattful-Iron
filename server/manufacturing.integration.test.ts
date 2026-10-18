import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import request from "supertest"
import { createApp } from "./app.js"

test("a built Circuit JSON downloads a preflight-approved manufacturing ZIP", async () => {
  const projectsDir = await mkdtemp(path.join(tmpdir(), "circuits-manufacturing-http-"))
  const app = createApp({ projectsDir, watchFiles: false, buildExecutionMode: "trusted-local" })
  try {
    const { body: project } = await request(app).post("/api/projects").send({ name: "Fab HTTP test" }).expect(201)
    const source = await readFile(path.resolve("examples/manufacturing-board/index.circuit.tsx"), "utf8")
    const currentFile = await request(app).get(`/api/projects/${project.id}/files`).query({ path: project.entrypoint }).expect(200)
    const saved = await request(app).put(`/api/projects/${project.id}/files`).query({ path: project.entrypoint })
      .set("If-Match", currentFile.body.revision)
      .send({ content: source, revision: currentFile.body.revision }).expect(200)
    await waitForBuild(app, project.id, saved.body.revision)

    const preflight = await request(app).get(`/api/projects/${project.id}/manufacturing`).expect(200)
    assert.equal(preflight.body.preflight.ready, true, JSON.stringify(preflight.body.preflight.checks))

    const download = await request(app).get(`/api/projects/${project.id}/manufacturing.zip`)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = []
        res.on("data", (chunk: Buffer) => chunks.push(chunk))
        res.on("end", () => callback(null, Buffer.concat(chunks)))
      })
      .expect(200)
    assert.equal(download.body.readUInt32LE(0), 0x04034b50)
    const sizes = archiveEntrySizes(download.body)
    for (const filename of ["F_Cu.gbr", "Edge_Cuts.gbr", "drill-L1-L2.drl", "drill_npth.drl", "bom.csv", "pick_and_place.csv"]) {
      assert.ok((sizes.get(filename) ?? 0) > 0, `missing or empty ${filename}`)
    }
  } finally {
    await (app.locals.projectService as { close(): Promise<void> }).close()
    await rm(projectsDir, { recursive: true, force: true })
  }
})

function archiveEntrySizes(buffer: Buffer) {
  let endOffset = -1
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65_557); offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { endOffset = offset; break }
  }
  assert.ok(endOffset >= 0, "invalid ZIP end record")
  const count = buffer.readUInt16LE(endOffset + 10)
  let offset = buffer.readUInt32LE(endOffset + 16)
  const sizes = new Map<string, number>()
  for (let index = 0; index < count; index++) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, "invalid ZIP central directory")
    const size = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength)
    sizes.set(name.split("/").at(-1)!, size)
    offset += 46 + nameLength + extraLength + commentLength
  }
  return sizes
}

async function waitForBuild(app: import("express").Express, id: string, revision: string) {
  for (let attempt = 0; attempt < 1200; attempt++) {
    const { body: project } = await request(app).get(`/api/projects/${id}`).expect(200)
    if (project.lastBuild?.revision === revision && project.lastBuild.status === "ready") return
    if (project.lastBuild?.revision === revision && project.lastBuild.status === "failed") {
      assert.fail(JSON.stringify(project.lastBuild.diagnostics))
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.fail("project build did not finish")
}
