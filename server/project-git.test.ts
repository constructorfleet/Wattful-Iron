import assert from "node:assert/strict"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import { createProjectGit } from "./project-git.js"

async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), "circuits-git-"))
  await writeFile(path.join(dir, "index.circuit.tsx"), "export default () => <board width=\"20mm\" />\n", "utf8")
  await mkdir(path.join(dir, "node_modules"), { recursive: true })
  await writeFile(path.join(dir, "node_modules", "ignored.js"), "module.exports = {}", "utf8")
  await mkdir(path.join(dir, ".workbench"), { recursive: true })
  await writeFile(path.join(dir, ".workbench", "circuit.json"), "[]", "utf8")
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test("commits each revision and keeps build output and dependencies untracked", async (t) => {
  const git = createProjectGit()
  if (!await git.isAvailable()) return t.skip("git is not installed in this environment")
  const { dir, cleanup } = await project()
  try {
    const first = await git.commitRevision(dir, "11111111-1111-1111-1111-111111111111", ["index.circuit.tsx"])
    assert.ok(first, "the first revision should produce a commit")
    await writeFile(path.join(dir, "index.circuit.tsx"), "export default () => <board width=\"24mm\" />\n", "utf8")
    const second = await git.commitRevision(dir, "22222222-2222-2222-2222-222222222222", ["index.circuit.tsx"])
    assert.ok(second && second !== first)

    const revisions = await git.listRevisions(dir)
    assert.deepEqual(revisions.map(({ revision }) => revision), [
      "22222222-2222-2222-2222-222222222222",
      "11111111-1111-1111-1111-111111111111",
    ])
    assert.deepEqual(revisions[0]?.changedFiles, ["index.circuit.tsx"])
    assert.match(revisions[0]?.message ?? "", /Update index\.circuit\.tsx/)
    assert.ok(Date.parse(revisions[0]!.createdAt) > 0)

    // The repository lives beside the project, so the project's own files are unchanged.
    assert.ok(!(await readdir(dir)).includes(".git"))
    const tracked = await git.filesAt(dir, first!)
    assert.deepEqual(Object.keys(tracked), ["index.circuit.tsx"])
    assert.match(tracked["index.circuit.tsx"]!, /20mm/)
  } finally { await cleanup() }
})

test("resolves a project revision to its commit and rejects anything that is not one", async (t) => {
  const git = createProjectGit()
  if (!await git.isAvailable()) return t.skip("git is not installed in this environment")
  const { dir, cleanup } = await project()
  try {
    const commit = await git.commitRevision(dir, "33333333-3333-3333-3333-333333333333", [])
    assert.equal(await git.resolveRevision(dir, "33333333-3333-3333-3333-333333333333"), commit)
    assert.equal(await git.resolveRevision(dir, "44444444-4444-4444-4444-444444444444"), undefined)
    assert.equal(await git.resolveRevision(dir, "not a revision"), undefined)
    await assert.rejects(() => git.filesAt(dir, "0000000000000000000000000000000000000000"), /could not read revision/)
  } finally { await cleanup() }
})

test("stays inert when git history is disabled", async () => {
  const git = createProjectGit({ enabled: false })
  const { dir, cleanup } = await project()
  try {
    assert.equal(await git.isAvailable(), false)
    assert.equal(await git.commitRevision(dir, "55555555-5555-5555-5555-555555555555", []), undefined)
    assert.deepEqual(await git.listRevisions(dir), [])
    assert.equal(await git.resolveRevision(dir, "55555555-5555-5555-5555-555555555555"), undefined)
    assert.ok(!(await readdir(path.join(dir, ".workbench"))).includes("git"))
  } finally { await cleanup() }
})

test("reports an unusable git binary as unavailable instead of throwing", async () => {
  const git = createProjectGit({ gitPath: path.join(tmpdir(), "definitely-not-git") })
  assert.equal(await git.isAvailable(), false)
})
