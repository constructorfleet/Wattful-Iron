import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import request from "supertest"
import { createApp } from "./app.js"
import { createUserStore } from "./user-accounts.js"
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from "./sessions.js"

const circuit = [
  { type: "pcb_board", pcb_board_id: "b1", width: 20, height: 20, center: { x: 0, y: 0 }, thickness: 1.6, num_layers: 2, material: "fr4" },
  { type: "source_component", source_component_id: "sc1", name: "R1", ftype: "simple_resistor", resistance: 1000, value: "1k", manufacturer_part_number: "0603WAF1001" },
  { type: "pcb_component", pcb_component_id: "pc1", source_component_id: "sc1", center: { x: 0, y: 0 }, width: 1.6, height: 0.8, rotation: 0, layer: "top" },
]
const password = "correct horse battery staple"

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "circuits-auth-"))
  const authDir = path.join(root, "auth")
  const users = createUserStore({ dir: authDir, scryptCost: 1024 })
  for (const role of ["owner", "engineer", "viewer"] as const) {
    await users.create({ email: `${role}@example.com`, password, role })
  }
  const app = createApp({
    projectsDir: path.join(root, "projects"),
    buildCircuit: async () => circuit,
    watchFiles: false,
    userAccounts: true,
    authDir,
    sessionSecret: "s".repeat(48),
    authScryptCost: 1024,
  })
  return {
    app,
    cleanup: async () => {
      await (app.locals.projectService as { close: () => Promise<void> }).close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

/** Sign in and keep the cookies plus the CSRF token the browser would echo. */
async function signIn(app: ReturnType<typeof createApp>, role: "owner" | "engineer" | "viewer") {
  const response = await request(app).post("/api/auth/login").send({ email: `${role}@example.com`, password }).expect(200)
  const cookies = (response.headers["set-cookie"] as unknown as string[]).map((value) => value.split(";")[0]!)
  const csrf = decodeURIComponent(cookies.find((value) => value.startsWith(`${CSRF_COOKIE}=`))!.split("=")[1]!)
  return { cookie: cookies.join("; "), csrf, user: response.body.user, capabilities: response.body.capabilities }
}

const authed = (app: ReturnType<typeof createApp>, session: { cookie: string; csrf: string }) => ({
  get: (url: string) => request(app).get(url).set("Cookie", session.cookie),
  post: (url: string) => request(app).post(url).set("Cookie", session.cookie).set(CSRF_HEADER, session.csrf),
  put: (url: string) => request(app).put(url).set("Cookie", session.cookie).set(CSRF_HEADER, session.csrf),
  patch: (url: string) => request(app).patch(url).set("Cookie", session.cookie).set(CSRF_HEADER, session.csrf),
  delete: (url: string) => request(app).delete(url).set("Cookie", session.cookie).set(CSRF_HEADER, session.csrf),
})

test("an unauthenticated request is refused while health checks stay open", async () => {
  const f = await fixture()
  try {
    await request(f.app).get("/healthz").expect(200)
    const refused = await request(f.app).get("/api/projects").expect(401)
    assert.match(refused.body.error, /Sign in/)
    await request(f.app).post("/api/projects").send({ name: "No session" }).expect(401)
    const session = await request(f.app).get("/api/auth/session").expect(200)
    assert.equal(session.body.accountsEnabled, true)
    assert.equal(session.body.authenticated, false)
  } finally { await f.cleanup() }
})

test("sign-in rejects a wrong password and returns the account's capabilities", async () => {
  const f = await fixture()
  try {
    await request(f.app).post("/api/auth/login").send({ email: "owner@example.com", password: "wrong password here" }).expect(401)
    await request(f.app).post("/api/auth/login").send({ email: "owner@example.com" }).expect(400)
    const session = await signIn(f.app, "engineer")
    assert.deepEqual(session.capabilities, ["read", "write"])
    assert.equal(session.user.role, "engineer")
    assert.equal("passwordHash" in session.user, false)

    const me = await authed(f.app, session).get("/api/auth/session").expect(200)
    assert.equal(me.body.user.email, "engineer@example.com")
    assert.equal(me.body.kind, "user")

    await request(f.app).post("/api/auth/logout").expect(204)
  } finally { await f.cleanup() }
})

test("a viewer may read but not change anything", async () => {
  const f = await fixture()
  try {
    const owner = await signIn(f.app, "owner")
    const { body: project } = await authed(f.app, owner).post("/api/projects").send({ name: "Viewer test" }).expect(201)

    const viewer = await signIn(f.app, "viewer")
    await authed(f.app, viewer).get("/api/projects").expect(200)
    await authed(f.app, viewer).get(`/api/projects/${project.id}`).expect(200)
    const refused = await authed(f.app, viewer).post("/api/projects").send({ name: "Nope" }).expect(403)
    assert.match(refused.body.error, /The viewer role may not change projects/)
    await authed(f.app, viewer).put(`/api/projects/${project.id}/files`).query({ path: project.entrypoint })
      .set("If-Match", project.revision).send({ content: "export default () => null", revision: project.revision }).expect(403)
    await authed(f.app, viewer).delete(`/api/projects/${project.id}`).expect(403)
  } finally { await f.cleanup() }
})

test("an engineer may edit but may not approve or delete a project", async () => {
  const f = await fixture()
  try {
    const engineer = await signIn(f.app, "engineer")
    const { body: project } = await authed(f.app, engineer).post("/api/projects").send({ name: "Engineer test" }).expect(201)
    for (let attempt = 0; attempt < 60; attempt++) {
      const state = await authed(f.app, engineer).get(`/api/projects/${project.id}`).expect(200)
      if (state.body.lastBuild?.status === "ready" && state.body.lastBuild.revision === state.body.revision) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const current = await authed(f.app, engineer).get(`/api/projects/${project.id}`).expect(200)

    await authed(f.app, engineer).post(`/api/projects/${project.id}/review`).set("If-Match", current.body.revision).send({ state: "validated" }).expect(200)
    await authed(f.app, engineer).post(`/api/projects/${project.id}/review`).set("If-Match", current.body.revision).send({ state: "reviewed" }).expect(200)
    const refused = await authed(f.app, engineer).post(`/api/projects/${project.id}/review`)
      .set("If-Match", current.body.revision).send({ state: "manufacturing_approved" }).expect(403)
    assert.match(refused.body.error, /engineer role may not approve a revision for manufacturing/)

    await authed(f.app, engineer).get("/api/auth/users").expect(403)
    await authed(f.app, engineer).delete(`/api/projects/${project.id}`).expect(403)

    // The owner can approve the same revision, and the entry records who did it.
    const owner = await signIn(f.app, "owner")
    const approved = await authed(f.app, owner).post(`/api/projects/${project.id}/review`)
      .set("If-Match", current.body.revision).send({ state: "manufacturing_approved", note: "Approved for the first build." }).expect(200)
    assert.equal(approved.body.state, "manufacturing_approved")
    assert.equal(approved.body.current.actor.email, "owner@example.com")
    assert.equal(approved.body.current.actor.role, "owner")
  } finally { await f.cleanup() }
})

test("a cookie session must present the CSRF token", async () => {
  const f = await fixture()
  try {
    const owner = await signIn(f.app, "owner")
    // The cookie alone is not enough: another site could send that.
    const refused = await request(f.app).post("/api/projects").set("Cookie", owner.cookie).send({ name: "No CSRF" }).expect(403)
    assert.match(refused.body.error, /CSRF/)
    await request(f.app).post("/api/projects").set("Cookie", owner.cookie).set(CSRF_HEADER, "stale-token").send({ name: "Bad CSRF" }).expect(403)
    await authed(f.app, owner).post("/api/projects").send({ name: "With CSRF" }).expect(201)
  } finally { await f.cleanup() }
})

test("owners manage accounts, and a disabled account's session stops working", async () => {
  const f = await fixture()
  try {
    const owner = await signIn(f.app, "owner")
    const listed = await authed(f.app, owner).get("/api/auth/users").expect(200)
    assert.deepEqual(listed.body.users.map((user: { email: string }) => user.email), ["engineer@example.com", "owner@example.com", "viewer@example.com"])

    const created = await authed(f.app, owner).post("/api/auth/users")
      .send({ email: "new@example.com", password, role: "viewer", displayName: "New Teammate" }).expect(201)
    assert.equal(created.body.role, "viewer")
    await authed(f.app, owner).post("/api/auth/users").send({ email: "weak@example.com", password: "short", role: "viewer" }).expect(400)
    await authed(f.app, owner).post("/api/auth/users").send({ email: "role@example.com", password, role: "admin" }).expect(400)

    const promoted = await authed(f.app, owner).patch(`/api/auth/users/${created.body.id}`).send({ role: "engineer" }).expect(200)
    assert.equal(promoted.body.role, "engineer")

    // Disabling an account invalidates the session it already holds.
    const teammate = await request(f.app).post("/api/auth/login").send({ email: "new@example.com", password }).expect(200)
    const teammateCookie = (teammate.headers["set-cookie"] as unknown as string[]).map((value) => value.split(";")[0]!).join("; ")
    await request(f.app).get("/api/projects").set("Cookie", teammateCookie).expect(200)
    await authed(f.app, owner).patch(`/api/auth/users/${created.body.id}`).send({ disabled: true }).expect(200)
    await request(f.app).get("/api/projects").set("Cookie", teammateCookie).expect(401)
    await request(f.app).post("/api/auth/login").send({ email: "new@example.com", password }).expect(401)

    await authed(f.app, owner).delete(`/api/auth/users/${created.body.id}`).expect(204)
    await authed(f.app, owner).delete(`/api/auth/users/${owner.user.id}`).expect(400)
    assert.ok(owner.cookie.includes(SESSION_COOKIE))
  } finally { await f.cleanup() }
})

test("without accounts configured the workbench keeps its previous open behavior", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "circuits-open-"))
  const app = createApp({ projectsDir: root, buildCircuit: async () => circuit, watchFiles: false })
  try {
    await request(app).get("/api/projects").expect(200)
    const { body: project } = await request(app).post("/api/projects").send({ name: "Open mode" }).expect(201)
    assert.ok(project.id)
    const session = await request(app).get("/api/auth/session").expect(200)
    assert.equal(session.body.accountsEnabled, false)
    assert.deepEqual(session.body.capabilities, ["read", "write", "approve", "manage_users", "delete_project"])
    await request(app).post("/api/auth/login").send({ email: "owner@example.com", password }).expect(400)
  } finally {
    await (app.locals.projectService as { close: () => Promise<void> }).close()
    await rm(root, { recursive: true, force: true })
  }
})
