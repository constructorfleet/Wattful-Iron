import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import { can, capabilitiesOf, createUserStore, isRole } from "./user-accounts.js"

async function store() {
  const dir = await mkdtemp(path.join(tmpdir(), "circuits-users-"))
  // A low scrypt cost keeps the suite fast; production uses the module default.
  return { dir, users: createUserStore({ dir, scryptCost: 1024 }), cleanup: () => rm(dir, { recursive: true, force: true }) }
}

const strongPassword = "correct horse battery staple"

test("grants capabilities by role, with the consequential ones reserved for owners", () => {
  assert.deepEqual(capabilitiesOf("viewer"), ["read"])
  assert.deepEqual(capabilitiesOf("engineer"), ["read", "write"])
  assert.deepEqual(capabilitiesOf("owner"), ["read", "write", "approve", "manage_users", "delete_project"])
  for (const capability of ["approve", "manage_users", "delete_project"] as const) {
    assert.equal(can("engineer", capability), false, capability)
    assert.equal(can("viewer", capability), false, capability)
    assert.equal(can("owner", capability), true, capability)
  }
  assert.equal(can("viewer", "write"), false)
  assert.equal(isRole("admin"), false)
  assert.equal(isRole("owner"), true)
})

test("creates an account, hides its credentials, and stores the file for the owner only", async () => {
  const { dir, users, cleanup } = await store()
  try {
    const created = await users.create({ email: " Owner@Example.COM ", password: strongPassword, role: "owner" })
    assert.equal(created.email, "owner@example.com")
    assert.equal(created.displayName, "owner")
    assert.equal(created.role, "owner")
    assert.equal(created.disabled, false)
    assert.equal("passwordHash" in created, false, "a public user must not carry credentials")

    const file = path.join(dir, "users.json")
    const contents = await readFile(file, "utf8")
    assert.equal(contents.includes(strongPassword), false, "the password must never be stored in the clear")
    const mode = (await stat(file)).mode & 0o777
    assert.equal(mode, 0o600)
  } finally { await cleanup() }
})

test("verifies a correct password and refuses wrong, unknown, and disabled accounts", async () => {
  const { users, cleanup } = await store()
  try {
    const created = await users.create({ email: "engineer@example.com", password: strongPassword, role: "engineer" })
    assert.equal((await users.verify("engineer@example.com", strongPassword))?.id, created.id)
    assert.equal((await users.verify("ENGINEER@example.com", strongPassword))?.id, created.id, "email matching is case-insensitive")
    assert.equal(await users.verify("engineer@example.com", "wrong password here"), undefined)
    assert.equal(await users.verify("nobody@example.com", strongPassword), undefined)

    await users.update(created.id, { disabled: true })
    assert.equal(await users.verify("engineer@example.com", strongPassword), undefined, "a disabled account cannot sign in")
  } finally { await cleanup() }
})

test("rejects weak passwords, bad emails, duplicates, and unknown roles", async () => {
  const { users, cleanup } = await store()
  try {
    await assert.rejects(() => users.create({ email: "a@example.com", password: "short", role: "owner" }), /at least 12 characters/)
    await assert.rejects(() => users.create({ email: "not-an-email", password: strongPassword, role: "owner" }), /valid email address/)
    await assert.rejects(() => users.create({ email: "a@example.com", password: "x".repeat(300), role: "owner" }), /at most 200 characters/)
    await users.create({ email: "a@example.com", password: strongPassword, role: "owner" })
    await assert.rejects(() => users.create({ email: "A@example.com", password: strongPassword, role: "owner" }), /already exists/)
    await assert.rejects(() => users.create({ email: "b@example.com", password: strongPassword, role: "admin" as never }), /role must be/)
  } finally { await cleanup() }
})

test("ends existing sessions when a password changes or an account is disabled", async () => {
  const { users, cleanup } = await store()
  try {
    const created = await users.create({ email: "engineer@example.com", password: strongPassword, role: "engineer" })
    const before = (await users.get(created.id))?.tokenVersion
    await users.update(created.id, { password: "another long password" })
    const afterPassword = (await users.get(created.id))?.tokenVersion
    assert.ok(before !== undefined && afterPassword !== undefined && afterPassword > before)
    assert.equal((await users.verify("engineer@example.com", "another long password"))?.id, created.id)

    await users.update(created.id, { disabled: true })
    assert.ok(((await users.get(created.id))?.tokenVersion ?? 0) > afterPassword)
  } finally { await cleanup() }
})

test("never leaves an instance without an enabled owner", async () => {
  const { users, cleanup } = await store()
  try {
    const owner = await users.create({ email: "owner@example.com", password: strongPassword, role: "owner" })
    await users.create({ email: "engineer@example.com", password: strongPassword, role: "engineer" })
    await assert.rejects(() => users.update(owner.id, { role: "viewer" }), /only enabled owner/)
    await assert.rejects(() => users.update(owner.id, { disabled: true }), /only enabled owner/)
    await assert.rejects(() => users.remove(owner.id), /only enabled owner/)

    // With a second owner, the first may be demoted; the remaining one is then protected.
    const second = await users.create({ email: "second@example.com", password: strongPassword, role: "owner" })
    await users.update(owner.id, { role: "viewer" })
    assert.equal((await users.list()).find(({ id }) => id === owner.id)?.role, "viewer")
    await assert.rejects(() => users.remove(second.id), /only enabled owner/)

    const engineer = (await users.list()).find(({ role }) => role === "engineer")
    await users.remove(engineer!.id)
    assert.deepEqual((await users.list()).map(({ email }) => email), ["owner@example.com", "second@example.com"])
  } finally { await cleanup() }
})

test("ignores malformed records instead of failing to read the store", async () => {
  const { dir, users, cleanup } = await store()
  try {
    await users.create({ email: "owner@example.com", password: strongPassword, role: "owner" })
    const file = path.join(dir, "users.json")
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown[]
    const { writeFile } = await import("node:fs/promises")
    await writeFile(file, JSON.stringify([...parsed, { id: "broken" }, "nonsense"]))
    assert.equal((await users.list()).length, 1)
  } finally { await cleanup() }
})
