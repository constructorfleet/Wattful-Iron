import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

export const SESSION_COOKIE = "wattful_session"
export const CSRF_COOKIE = "wattful_csrf"
export const CSRF_HEADER = "x-csrf-token"

export type SessionPayload = {
  userId: string
  /** Matched against the account's token version, so a password change ends existing sessions. */
  tokenVersion: number
  issuedAt: number
  expiresAt: number
}

export type SessionCodec = {
  sign(payload: Omit<SessionPayload, "issuedAt" | "expiresAt">): { value: string; expiresAt: number }
  verify(value: string | undefined): SessionPayload | undefined
  readonly lifetimeMs: number
}

const DEFAULT_LIFETIME_MS = 12 * 60 * 60 * 1000

/**
 * Stateless signed session cookies: the payload is HMAC-signed, so no session table is
 * needed. Revocation works through the account's token version rather than server state.
 */
export function createSessionCodec(secret: string, lifetimeMs = DEFAULT_LIFETIME_MS): SessionCodec {
  if (Buffer.byteLength(secret) < 32) throw new Error("The session secret must contain at least 32 bytes")

  const signature = (body: string) => createHmac("sha256", secret).update(body).digest("base64url")

  return {
    lifetimeMs,

    sign(payload) {
      const issuedAt = Date.now()
      const expiresAt = issuedAt + lifetimeMs
      const body = Buffer.from(JSON.stringify({ ...payload, issuedAt, expiresAt })).toString("base64url")
      return { value: `${body}.${signature(body)}`, expiresAt }
    },

    verify(value) {
      if (!value) return undefined
      const separator = value.lastIndexOf(".")
      if (separator <= 0) return undefined
      const body = value.slice(0, separator)
      const provided = Buffer.from(value.slice(separator + 1))
      const expected = Buffer.from(signature(body))
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return undefined
      let payload: SessionPayload
      try { payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload }
      catch { return undefined }
      if (typeof payload.userId !== "string" || typeof payload.tokenVersion !== "number") return undefined
      if (typeof payload.expiresAt !== "number" || payload.expiresAt <= Date.now()) return undefined
      return payload
    },
  }
}

/**
 * Read the session secret from the environment, or generate and persist one so sessions
 * survive a restart without any configuration.
 */
export async function resolveSessionSecret(dir: string, configured?: string): Promise<string> {
  if (configured) {
    if (Buffer.byteLength(configured) < 32) throw new Error("AUTH_SESSION_SECRET must contain at least 32 bytes")
    return configured
  }
  const file = path.join(dir, "session-secret")
  try {
    const existing = (await readFile(file, "utf8")).trim()
    if (Buffer.byteLength(existing) >= 32) return existing
  } catch { /* Fall through and generate one. */ }
  const generated = randomBytes(48).toString("hex")
  await mkdir(dir, { recursive: true })
  await writeFile(file, generated + "\n", { mode: 0o600 })
  await chmod(file, 0o600).catch(() => undefined)
  return generated
}

export function newCsrfToken() {
  return randomBytes(24).toString("base64url")
}

/** Parse a Cookie header without pulling in a parser dependency. */
export function readCookies(header: string | undefined): Record<string, string> {
  if (!header) return {}
  const cookies: Record<string, string> = {}
  for (const part of header.split(";")) {
    const separator = part.indexOf("=")
    if (separator < 0) continue
    const name = part.slice(0, separator).trim()
    if (!name) continue
    try { cookies[name] = decodeURIComponent(part.slice(separator + 1).trim()) }
    catch { cookies[name] = part.slice(separator + 1).trim() }
  }
  return cookies
}

export function sessionCookie(value: string, options: { secure: boolean; maxAgeMs: number }) {
  return cookie(SESSION_COOKIE, value, { ...options, httpOnly: true })
}

/**
 * The CSRF cookie is deliberately readable by the page: the browser echoes it in a header,
 * and the server compares the two. A cross-site request cannot read it.
 */
export function csrfCookie(value: string, options: { secure: boolean; maxAgeMs: number }) {
  return cookie(CSRF_COOKIE, value, { ...options, httpOnly: false })
}

export function clearedCookies(secure: boolean) {
  return [
    cookie(SESSION_COOKIE, "", { secure, maxAgeMs: 0, httpOnly: true }),
    cookie(CSRF_COOKIE, "", { secure, maxAgeMs: 0, httpOnly: false }),
  ]
}

function cookie(name: string, value: string, options: { secure: boolean; maxAgeMs: number; httpOnly: boolean }) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(options.maxAgeMs / 1000))}`,
    ...(options.httpOnly ? ["HttpOnly"] : []),
    ...(options.secure ? ["Secure"] : []),
  ].join("; ")
}
