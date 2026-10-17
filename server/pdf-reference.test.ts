import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import request from "supertest"
import { createApp } from "./app.js"

const pdf = Buffer.from("%PDF-1.4\nminimal visual reference\n%%EOF")

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "circuits-pdf-reference-"))
  const app = createApp({ projectsDir: root, watchFiles: false, buildCircuit: async () => [] })
  return { root, app, cleanup: async () => { await (app.locals.projectService as { close: () => Promise<void> }).close(); await rm(root, { recursive: true, force: true }) } }
}

test("creates a project from a PDF reference and serves the retained document inline", async () => {
  const f = await fixture()
  try {
    const imported = await request(f.app)
      .post("/api/projects/import-pdf")
      .query({ name: "Shim reference", filename: "rev1shimSCH.pdf" })
      .set("Content-Type", "application/pdf")
      .send(pdf)
      .expect(201)
    const reference = imported.body.referencePdfs[0]
    assert.equal(reference.name, "rev1shimSCH.pdf")
    const file = path.join(f.root, imported.body.id, ".workbench", "references", `${reference.id}.pdf`)
    assert.deepEqual(await readFile(file), pdf)
    const response = await request(f.app).get(`/api/projects/${imported.body.id}/references/${reference.id}`).buffer(true).parse((res, callback) => {
      const chunks: Buffer[] = []
      res.on("data", (chunk: Buffer) => chunks.push(chunk))
      res.on("end", () => callback(null, Buffer.concat(chunks)))
    }).expect(200)
    assert.equal(response.headers["content-type"], "application/pdf")
    assert.match(response.headers["content-disposition"] ?? "", /^inline/)
    assert.deepEqual(response.body, pdf)
  } finally { await f.cleanup() }
})

test("rejects non-PDF payloads, unsupported filenames, and oversized PDF uploads", async () => {
  const f = await fixture()
  try {
    await request(f.app).post("/api/projects/import-pdf").query({ name: "Bad", filename: "drawing.png" }).set("Content-Type", "application/pdf").send(pdf).expect(400)
    await request(f.app).post("/api/projects/import-pdf").query({ name: "Bad", filename: "drawing.pdf" }).set("Content-Type", "application/pdf").send(Buffer.from("not a PDF")).expect(400)
    await request(f.app).post("/api/projects/import-pdf").query({ name: "Too large", filename: "large.pdf" }).set("Content-Type", "application/pdf").send(Buffer.concat([pdf, Buffer.alloc(20 * 1024 * 1024)])).expect(413)
  } finally { await f.cleanup() }
})
