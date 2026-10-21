import type { Capability, PublicUser, Role } from "./user-accounts.js"

/** Who is making a request, and what they may do. */
export type Actor = {
  kind: "user" | "shared-token" | "mcp" | "anonymous"
  capabilities: Capability[]
  user?: PublicUser
  role?: Role
}

/** A request's path and method, plus the parsed body for routes whose target depends on it. */
export type RequestShape = { method: string; path: string; body?: unknown }

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

/** Paths that never require a capability, so health checks and signing in always work. */
const PUBLIC_PATHS = new Set(["/healthz", "/api/auth/login", "/api/auth/logout", "/api/auth/session"])

/**
 * The capability a request needs. Reads need `read`; mutations need `write`, except the
 * three consequential ones: approving a revision for manufacturing, managing accounts, and
 * deleting a project.
 */
export function requiredCapability(request: RequestShape): Capability | undefined {
  if (PUBLIC_PATHS.has(request.path)) return undefined
  if (!request.path.startsWith("/api/")) return READ_METHODS.has(request.method) ? "read" : "write"
  if (request.path.startsWith("/api/auth/users")) return "manage_users"
  if (READ_METHODS.has(request.method)) return "read"
  if (request.method === "DELETE" && /^\/api\/projects\/[^/]+$/.test(request.path)) return "delete_project"
  if (/^\/api\/projects\/[^/]+\/review$/.test(request.path) && isApproval(request.body)) return "approve"
  return "write"
}

export function actorCan(actor: Actor, capability: Capability | undefined) {
  if (capability === undefined) return true
  return actor.capabilities.includes(capability)
}

/** The message a refusal returns. It names the capability so an agent can report why it stopped. */
export function refusalMessage(actor: Actor, capability: Capability) {
  if (actor.kind === "anonymous") return "Sign in to use this workbench"
  if (actor.kind === "mcp") {
    return capability === "approve"
      ? "Approving a revision for manufacturing requires a person: it is not available to MCP agents"
      : `MCP agents may not ${describe(capability)}`
  }
  const role = actor.role ? `The ${actor.role} role` : "This account"
  return `${role} may not ${describe(capability)}`
}

function describe(capability: Capability) {
  switch (capability) {
    case "read": return "read this workbench"
    case "write": return "change projects"
    case "approve": return "approve a revision for manufacturing"
    case "manage_users": return "manage user accounts"
    case "delete_project": return "delete projects"
  }
}

function isApproval(body: unknown) {
  return typeof body === "object" && body !== null && (body as { state?: unknown }).state === "manufacturing_approved"
}
