import path from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import { runCommand } from "./build-process.js"

export type GitRevision = {
  revision?: string
  commit: string
  createdAt: string
  message: string
  changedFiles: string[]
}

export type ProjectGit = {
  /** Whether a usable `git` binary was found. Checked once and cached. */
  isAvailable(): Promise<boolean>
  commitRevision(projectDir: string, revision: string, changedFiles: string[]): Promise<string | undefined>
  listRevisions(projectDir: string, limit?: number): Promise<GitRevision[]>
  filesAt(projectDir: string, commit: string): Promise<Record<string, string>>
  resolveRevision(projectDir: string, revision: string): Promise<string | undefined>
}

/** Paths the project repository never tracks: build output, dependencies, and workbench state. */
const EXCLUDES = ["node_modules/", "dist/", "output/", ".workbench/", "*.tsbuildinfo"]
const REVISION_TRAILER = "Workbench-Revision"
const COMMIT_SEPARATOR = "@@wattful-commit@@"
const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_LIMIT = 200
/** Git refuses to commit without an identity; the workbench commits as itself. */
const IDENTITY = ["-c", "user.name=Wattful-Iron", "-c", "user.email=workbench@localhost", "-c", "commit.gpgsign=false"]

/**
 * Keep every project revision in a Git repository beside the project, so history is not
 * limited by snapshot retention and comparisons use Git's own view of the tracked source.
 * The repository lives in `.workbench/git` with the project directory as its work tree, so
 * no `.git` directory appears among the project's own files.
 */
export function createProjectGit(options: { gitPath?: string; timeoutMs?: number; enabled?: boolean } = {}): ProjectGit {
  const gitPath = options.gitPath ?? "git"
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let availability: Promise<boolean> | undefined

  const run = (projectDir: string, args: string[]) => runCommand(gitPath, [
    "--git-dir", gitDir(projectDir),
    "--work-tree", projectDir,
    "-c", "core.bare=false",
    ...args,
  ], { cwd: projectDir, env: isolatedEnv(), timeoutMs })

  const isAvailable = () => {
    if (options.enabled === false) return Promise.resolve(false)
    availability ??= runCommand(gitPath, ["--version"], { cwd: process.cwd(), env: isolatedEnv(), timeoutMs })
      .then((result) => result.exitCode === 0)
      .catch(() => false)
    return availability
  }

  const ensureRepo = async (projectDir: string) => {
    const dir = gitDir(projectDir)
    const existing = await runCommand(gitPath, ["--git-dir", dir, "rev-parse", "--git-dir"], { cwd: projectDir, env: isolatedEnv(), timeoutMs })
    if (existing.exitCode === 0) return true
    await mkdir(path.dirname(dir), { recursive: true })
    const init = await runCommand(gitPath, ["--git-dir", dir, "init", "--quiet", "--bare", "--initial-branch", "main"], { cwd: projectDir, env: isolatedEnv(), timeoutMs })
    if (init.exitCode !== 0) return false
    await mkdir(path.join(dir, "info"), { recursive: true })
    await writeFile(path.join(dir, "info", "exclude"), EXCLUDES.join("\n") + "\n", "utf8")
    return true
  }

  return {
    isAvailable,

    /** Commit the project's tracked files for one revision, returning the commit it created. */
    async commitRevision(projectDir, revision, changedFiles) {
      if (!await isAvailable()) return undefined
      if (!await ensureRepo(projectDir)) return undefined
      const add = await run(projectDir, ["add", "--all"])
      if (add.exitCode !== 0) return undefined
      const summary = changedFiles.length
        ? `Update ${changedFiles.slice(0, 3).join(", ")}${changedFiles.length > 3 ? ` and ${changedFiles.length - 3} more` : ""}`
        : "Record project revision"
      const message = `${summary}\n\n${REVISION_TRAILER}: ${revision}\n`
      const commit = await run(projectDir, [...IDENTITY, "commit", "--allow-empty", "--quiet", "--message", message])
      if (commit.exitCode !== 0) return undefined
      const head = await run(projectDir, ["rev-parse", "HEAD"])
      return head.exitCode === 0 ? head.stdout.trim() || undefined : undefined
    },

    /** List commits newest first, with the revision each one recorded and the files it changed. */
    async listRevisions(projectDir, limit = DEFAULT_LIMIT) {
      if (!await isAvailable()) return []
      const log = await run(projectDir, [
        "log", `--max-count=${limit}`, "--name-only", "--no-renames",
        `--format=${COMMIT_SEPARATOR}%H%x09%cI%x09%s%x09%(trailers:key=${REVISION_TRAILER},valueonly)`,
      ])
      if (log.exitCode !== 0) return []
      return log.stdout.split(COMMIT_SEPARATOR).flatMap((entry): GitRevision[] => {
        const [header, ...rest] = entry.split("\n")
        if (!header) return []
        const [commit, createdAt, message, trailer] = header.split("\t")
        if (!commit || !createdAt) return []
        const revision = trailer?.trim()
        return [{
          commit,
          createdAt,
          message: message ?? "",
          ...(revision ? { revision } : {}),
          changedFiles: rest.map((line) => line.trim()).filter(Boolean).sort(),
        }]
      })
    },

    /** Read every tracked file as it stood at one commit. */
    async filesAt(projectDir, commit) {
      if (!await isAvailable()) return {}
      const listed = await run(projectDir, ["ls-tree", "-r", "--name-only", "--full-tree", commit])
      if (listed.exitCode !== 0) throw new Error(`Git could not read revision ${commit}`)
      const files: Record<string, string> = {}
      for (const relative of listed.stdout.split("\n").map((line) => line.trim()).filter(Boolean)) {
        const shown = await run(projectDir, ["show", `${commit}:${relative}`])
        if (shown.exitCode !== 0) throw new Error(`Git could not read ${relative} at revision ${commit}`)
        files[relative] = shown.stdout
      }
      return files
    },

    /** Find the commit that recorded a project revision. */
    async resolveRevision(projectDir, revision) {
      if (!await isAvailable()) return undefined
      if (!/^[0-9a-f-]{8,40}$/i.test(revision)) return undefined
      const found = await run(projectDir, ["log", "--max-count=1", "--format=%H", "--fixed-strings", `--grep=${REVISION_TRAILER}: ${revision}`])
      if (found.exitCode !== 0) return undefined
      return found.stdout.trim() || undefined
    },
  }
}

function gitDir(projectDir: string) {
  return path.join(projectDir, ".workbench", "git")
}

/**
 * Run Git without reading the host's user or system configuration, and with timestamps in
 * UTC so commit times are comparable with the workbench's own ISO timestamps.
 */
function isolatedEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    TZ: "UTC",
  }
}
