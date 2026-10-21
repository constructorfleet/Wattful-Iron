import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import { actorCan, refusalMessage, requiredCapability, type Actor } from "./authorization.js"
import { capabilitiesOf, type Role } from "./user-accounts.js"
import { createSessionCodec, readCookies, resolveSessionSecret, SESSION_COOKIE } from "./sessions.js"

const actor = (role: Role): Actor => ({ kind: "user", role, capabilities: capabilitiesOf(role) })

test("reads need read, mutations need write", () => {
  assert.equal(requiredCapability({ method: "GET", path: "/api/projects" }), "read")
  assert.equal(requiredCapability({ method: "GET", path: "/api/projects/abc/nets" }), "read")
  assert.equal(requiredCapability({ method: "PUT", path: "/api/projects/abc/files" }), "write")
  assert.equal(requiredCapability({ method: "POST", path: "/api/projects/abc/build" }), "write")
  // The browser bundle itself is a read.
  assert.equal(requiredCapability({ method: "GET", path: "/assets/index.js" }), "read")
})

test("health checks and the sign-in routes need no capability", () => {
  for (const path of ["/healthz", "/api/auth/login", "/api/auth/logout", "/api/auth/session"]) {
    assert.equal(requiredCapability({ method: path === "/healthz" ? "GET" : "POST", path }), undefined, path)
  }
})

test("the consequential operations need their own capability", () => {
  assert.equal(requiredCapability({ method: "DELETE", path: "/api/projects/abc" }), "delete_project")
  assert.equal(requiredCapability({ method: "GET", path: "/api/auth/users" }), "manage_users")
  assert.equal(requiredCapability({ method: "POST", path: "/api/auth/users" }), "manage_users")
  assert.equal(requiredCapability({ method: "PATCH", path: "/api/auth/users/abc" }), "manage_users")
  // Approval is distinguished by the state being recorded, not by the route.
  assert.equal(requiredCapability({ method: "POST", path: "/api/projects/abc/review", body: { state: "validated" } }), "write")
  assert.equal(requiredCapability({ method: "POST", path: "/api/projects/abc/review", body: { state: "manufacturing_approved" } }), "approve")
  // Deleting a file inside a project is an ordinary write, not a project deletion.
  assert.equal(requiredCapability({ method: "DELETE", path: "/api/projects/abc/files" }), "write")
})

test("roles are allowed exactly what their capabilities say", () => {
  assert.equal(actorCan(actor("viewer"), "read"), true)
  assert.equal(actorCan(actor("viewer"), "write"), false)
  assert.equal(actorCan(actor("engineer"), "write"), true)
  assert.equal(actorCan(actor("engineer"), "approve"), false)
  assert.equal(actorCan(actor("engineer"), "delete_project"), false)
  assert.equal(actorCan(actor("owner"), "approve"), true)
  assert.equal(actorCan(actor("viewer"), undefined), true)
  assert.equal(actorCan({ kind: "anonymous", capabilities: [] }, "read"), false)
})

test("refusals name the role and the operation, and single out agents", () => {
  assert.match(refusalMessage(actor("engineer"), "approve"), /The engineer role may not approve a revision for manufacturing/)
  assert.match(refusalMessage(actor("viewer"), "write"), /The viewer role may not change projects/)
  assert.match(refusalMessage({ kind: "anonymous", capabilities: [] }, "read"), /Sign in to use this workbench/)
  assert.match(refusalMessage({ kind: "mcp", capabilities: ["read", "write"] }, "approve"), /requires a person/)
  assert.match(refusalMessage({ kind: "mcp", capabilities: ["read", "write"] }, "delete_project"), /MCP agents may not delete projects/)
})

test("session cookies are signed, expire, and cannot be tampered with", async () => {
  const codec = createSessionCodec("x".repeat(48), 1000)
  const signed = codec.sign({ userId: "user-1", tokenVersion: 3 })
  const payload = codec.verify(signed.value)
  assert.equal(payload?.userId, "user-1")
  assert.equal(payload?.tokenVersion, 3)

  assert.equal(codec.verify(undefined), undefined)
  assert.equal(codec.verify("not-a-session"), undefined)
  // A different secret must not validate, and neither may an edited payload.
  assert.equal(createSessionCodec("y".repeat(48)).verify(signed.value), undefined)
  const [body, signature] = signed.value.split(".")
  const forged = Buffer.from(JSON.stringify({ userId: "user-2", tokenVersion: 3, issuedAt: Date.now(), expiresAt: Date.now() + 1000 })).toString("base64url")
  assert.equal(codec.verify(`${forged}.${signature}`), undefined)
  assert.ok(body && signature)

  const expired = createSessionCodec("x".repeat(48), -1).sign({ userId: "user-1", tokenVersion: 1 })
  assert.equal(codec.verify(expired.value), undefined)
  assert.throws(() => createSessionCodec("too-short"), /at least 32 bytes/)
})

test("the session secret is reused across restarts and may be configured", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "circuits-secret-"))
  try {
    const first = await resolveSessionSecret(dir)
    assert.ok(Buffer.byteLength(first) >= 32)
    assert.equal(await resolveSessionSecret(dir), first, "a restart must keep existing sessions valid")
    assert.equal(await resolveSessionSecret(dir, "z".repeat(40)), "z".repeat(40))
    await assert.rejects(() => resolveSessionSecret(dir, "short"), /at least 32 bytes/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("parses cookie headers without a dependency", () => {
  assert.deepEqual(readCookies(undefined), {})
  assert.deepEqual(readCookies(`${SESSION_COOKIE}=abc; other=1`), { [SESSION_COOKIE]: "abc", other: "1" })
  assert.deepEqual(readCookies("encoded=a%20b"), { encoded: "a b" })
  assert.deepEqual(readCookies("broken"), {})
})
