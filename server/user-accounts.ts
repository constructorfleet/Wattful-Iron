import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto"
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: string,
  keyLength: number,
  options: ScryptOptions,
) => Promise<Buffer>

/** What a signed-in person may do. Capabilities are granted by role, never per project. */
export type Capability = "read" | "write" | "approve" | "manage_users" | "delete_project"
export type Role = "owner" | "engineer" | "viewer"

export type PublicUser = {
  id: string
  email: string
  displayName: string
  role: Role
  disabled: boolean
  createdAt: string
  updatedAt: string
}

type StoredUser = PublicUser & {
  passwordHash: string
  passwordSalt: string
  /** Bumped on a password change or a disable, which invalidates existing sessions. */
  tokenVersion: number
}

export type UserStore = {
  count(): Promise<number>
  list(): Promise<PublicUser[]>
  get(id: string): Promise<StoredUser | undefined>
  create(input: { email: string; password: string; displayName?: string; role: Role }): Promise<PublicUser>
  update(id: string, patch: { role?: Role; displayName?: string; disabled?: boolean; password?: string }): Promise<PublicUser>
  remove(id: string): Promise<void>
  /** Verify a sign-in. Returns undefined for a wrong password, an unknown email, or a disabled account. */
  verify(email: string, password: string): Promise<StoredUser | undefined>
}

export const roles: Role[] = ["owner", "engineer", "viewer"]

/**
 * Capabilities per role. An engineer may edit and record validation or review; approving a
 * revision for manufacturing, managing accounts, and deleting projects are owner-only,
 * because each is consequential and hard to undo.
 */
const ROLE_CAPABILITIES: Record<Role, Capability[]> = {
  owner: ["read", "write", "approve", "manage_users", "delete_project"],
  engineer: ["read", "write"],
  viewer: ["read"],
}

/** scrypt parameters. The cost is configurable so tests need not pay the production cost. */
const SCRYPT = { keyLength: 64, cost: 16384, blockSize: 8, parallelization: 1 }
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MIN_PASSWORD_LENGTH = 12
const MAX_PASSWORD_LENGTH = 200

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (roles as string[]).includes(value)
}

export function can(role: Role, capability: Capability) {
  return ROLE_CAPABILITIES[role].includes(capability)
}

export function capabilitiesOf(role: Role): Capability[] {
  return [...ROLE_CAPABILITIES[role]]
}

export function toPublicUser(user: StoredUser | PublicUser): PublicUser {
  const { id, email, displayName, role, disabled, createdAt, updatedAt } = user
  return { id, email, displayName, role, disabled, createdAt, updatedAt }
}

/**
 * A file-backed account store. Accounts live in one JSON file beside project storage, so a
 * self-hosted deployment needs no database. Writes are serialized and atomic.
 */
export function createUserStore(options: { dir: string; fileName?: string; scryptCost?: number }): UserStore {
  const file = path.join(options.dir, options.fileName ?? "users.json")
  const cost = options.scryptCost ?? SCRYPT.cost
  let queue: Promise<unknown> = Promise.resolve()

  const read = async (): Promise<StoredUser[]> => {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as unknown
      if (!Array.isArray(parsed)) return []
      return parsed.filter((user): user is StoredUser => isStoredUser(user))
    } catch { return [] }
  }

  const write = async (users: StoredUser[]) => {
    await mkdir(options.dir, { recursive: true })
    const temporary = `${file}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(users, null, 2) + "\n", { mode: 0o600 })
    await rename(temporary, file)
    await chmod(file, 0o600).catch(() => undefined)
  }

  /** Serialize mutations so two concurrent writes cannot drop an account. */
  const mutate = <T>(action: (users: StoredUser[]) => Promise<{ users: StoredUser[]; result: T }>): Promise<T> => {
    const next = queue.then(async () => {
      const { users, result } = await action(await read())
      await write(users)
      return result
    })
    queue = next.catch(() => undefined)
    return next
  }

  return {
    async count() { return (await read()).length },
    async list() { return (await read()).map(toPublicUser).sort((left, right) => left.email.localeCompare(right.email)) },
    async get(id) { return (await read()).find((user) => user.id === id) },

    create(input) {
      return mutate(async (users) => {
        const email = normalizeEmail(input.email)
        if (!EMAIL_PATTERN.test(email)) throw badRequest("A user needs a valid email address")
        if (users.some((user) => user.email === email)) throw badRequest(`An account already exists for ${email}`)
        if (!isRole(input.role)) throw badRequest("role must be owner, engineer, or viewer")
        const { hash, salt } = await hashPassword(input.password, cost)
        const now = new Date().toISOString()
        const user: StoredUser = {
          id: randomUUID(),
          email,
          displayName: (input.displayName ?? email.split("@")[0] ?? email).slice(0, 100),
          role: input.role,
          disabled: false,
          createdAt: now,
          updatedAt: now,
          passwordHash: hash,
          passwordSalt: salt,
          tokenVersion: 1,
        }
        return { users: [...users, user], result: toPublicUser(user) }
      })
    },

    update(id, patch) {
      return mutate(async (users) => {
        const existing = users.find((user) => user.id === id)
        if (!existing) throw notFound("No such user")
        if (patch.role !== undefined && !isRole(patch.role)) throw badRequest("role must be owner, engineer, or viewer")
        // Keep at least one enabled owner, so an instance can never lock everyone out.
        const wouldRemoveLastOwner = existing.role === "owner" && (patch.role !== undefined && patch.role !== "owner" || patch.disabled === true)
        if (wouldRemoveLastOwner && users.filter((user) => user.role === "owner" && !user.disabled).length <= 1) {
          throw badRequest("This is the only enabled owner; promote another owner first")
        }
        const credentials = patch.password === undefined ? undefined : await hashPassword(patch.password, cost)
        const updated: StoredUser = {
          ...existing,
          ...(patch.role === undefined ? {} : { role: patch.role }),
          ...(patch.displayName === undefined ? {} : { displayName: patch.displayName.slice(0, 100) }),
          ...(patch.disabled === undefined ? {} : { disabled: patch.disabled }),
          ...(credentials ? { passwordHash: credentials.hash, passwordSalt: credentials.salt } : {}),
          // A password change or a disable must end that user's existing sessions.
          tokenVersion: credentials || patch.disabled === true ? existing.tokenVersion + 1 : existing.tokenVersion,
          updatedAt: new Date().toISOString(),
        }
        return { users: users.map((user) => user.id === id ? updated : user), result: toPublicUser(updated) }
      })
    },

    remove(id) {
      return mutate(async (users) => {
        const existing = users.find((user) => user.id === id)
        if (!existing) throw notFound("No such user")
        if (existing.role === "owner" && users.filter((user) => user.role === "owner" && !user.disabled).length <= 1) {
          throw badRequest("This is the only enabled owner; promote another owner first")
        }
        return { users: users.filter((user) => user.id !== id), result: undefined }
      })
    },

    async verify(email, password) {
      const users = await read()
      const user = users.find((candidate) => candidate.email === normalizeEmail(email))
      // Hash even when the email is unknown, so a wrong email and a wrong password cost the same.
      const salt = user?.passwordSalt ?? randomBytes(16).toString("hex")
      const derived = await derive(password, salt, cost)
      if (!user || user.disabled) return undefined
      const stored = Buffer.from(user.passwordHash, "hex")
      if (stored.length !== derived.length || !timingSafeEqual(stored, derived)) return undefined
      return user
    },
  }
}

async function hashPassword(password: string, cost: number) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw badRequest(`A password must contain at least ${MIN_PASSWORD_LENGTH} characters`)
  }
  if (password.length > MAX_PASSWORD_LENGTH) throw badRequest(`A password must contain at most ${MAX_PASSWORD_LENGTH} characters`)
  const salt = randomBytes(16).toString("hex")
  return { hash: (await derive(password, salt, cost)).toString("hex"), salt }
}

async function derive(password: string, salt: string, cost: number) {
  return await scrypt(password, salt, SCRYPT.keyLength, {
    cost,
    blockSize: SCRYPT.blockSize,
    parallelization: SCRYPT.parallelization,
  })
}

function normalizeEmail(email: unknown) {
  return typeof email === "string" ? email.trim().toLowerCase() : ""
}

function isStoredUser(value: unknown): value is StoredUser {
  if (typeof value !== "object" || value === null) return false
  const user = value as StoredUser
  return typeof user.id === "string" && typeof user.email === "string" && isRole(user.role)
    && typeof user.passwordHash === "string" && typeof user.passwordSalt === "string"
}

function badRequest(message: string) {
  return Object.assign(new Error(message), { status: 400 })
}

function notFound(message: string) {
  return Object.assign(new Error(message), { status: 404 })
}
