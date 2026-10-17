export type Project = {
  id: string
  name: string
  entrypoint: string
  revision: string
  updatedAt?: string
}
export type ProjectTemplate = { id: string; name: string; description: string }

export type ProjectFile = { path: string; content: string; revision: string }
export type ProjectRevision = { revision: string; createdAt: string; changedFiles: string[]; sizeBytes: number }
export type RevisionComparison = { from: string; to: string; files: Array<{ path: string; before: string | null; after: string | null }> }
export type BuildStatus = {
  buildId?: string
  revision?: string
  status: 'idle' | 'running' | 'compiling' | 'validating' | 'routing' | 'rendering' | 'ready' | 'failed'
  step?: string
  diagnostics?: Array<{ message: string; path?: string; file?: string; line?: number; column?: number; severity?: string }>
}
export type ProjectEvent =
  | { type: 'project'; project: Project }
  | { type: 'file'; path: string; revision: string }
  | ({ type: 'build.status' } & BuildStatus)
  | { type: 'build.ready'; buildId: string; revision: string; artifacts?: { circuitJsonUrl?: string } }
  | { type: 'build.failed'; buildId: string; revision: string; diagnostics: BuildStatus['diagnostics'] }

export type Preview = { revision: string; kind: PreviewKind; circuitJson: unknown }
export type PreviewKind = 'schematic' | 'pcb' | '3d'
export type Simulation = {
  revision: string
  status: 'complete' | 'failed' | 'not_configured'
  experiments: Array<{ id: string; name: string; type: string }>
  signals: Array<{ id: string; name: string; unit: 'V' | 'A'; netId?: string; samples: Array<{ x: number; y: number }> }>
  diagnostics: Array<{ message: string; severity: 'error' }>
}
export type ManufacturingProfile = { id: string; label: string; description: string; rules: { minTraceWidthMm: number; minNonPlatedHoleMm: number; copperToBoardEdgeMm: number } }
export type ManufacturingCheck = { id: string; status: 'pass' | 'fail' | 'warning'; message: string }
export type ManufacturingPreflight = { ready: boolean; profile: Pick<ManufacturingProfile, 'id' | 'label'>; checks: ManufacturingCheck[] }
type Fetcher = typeof fetch

async function request<T>(url: string, init: RequestInit = {}, fetcher: Fetcher = fetch): Promise<T> {
  const response = await fetcher(url, init)
  if (response.status === 409 || response.status === 412) {
    throw new Error('This file changed on disk. Reload it before saving again.')
  }
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(detail || `Request failed (${response.status})`)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export const listProjects = (fetcher?: Fetcher) => request<Project[]>('/api/projects', undefined, fetcher)
export const listProjectTemplates = (fetcher?: Fetcher) => request<ProjectTemplate[]>('/api/examples', undefined, fetcher)

export const createProject = (name: string, templateId?: string, fetcher?: Fetcher) => request<Project>('/api/projects', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name, templateId }),
}, fetcher)

export const importSchematics = (name: string, files: Array<{ name: string; content: string }>, fetcher?: Fetcher) => request<{
  project: Project
  sourceComponents: number
  warnings: string[]
}>('/api/projects/import', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name, files }),
}, fetcher)

export const getProject = (id: string, fetcher?: Fetcher) => request<Project>(`/api/projects/${encodeURIComponent(id)}`, undefined, fetcher)

const fileUrl = (id: string, path: string) => `/api/projects/${encodeURIComponent(id)}/files?path=${encodeURIComponent(path)}`
export const getProjectFile = (id: string, path: string, fetcher?: Fetcher) => request<ProjectFile>(fileUrl(id, path), undefined, fetcher)

export const saveProjectFile = (id: string, path: string, content: string, revision: string, fetcher?: Fetcher) => request<ProjectFile>(fileUrl(id, path), {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', 'If-Match': revision },
  body: JSON.stringify({ content, revision }),
}, fetcher)

export const getProjectHistory = (id: string, fetcher?: Fetcher) => request<{ revisions: ProjectRevision[] }>(`/api/projects/${encodeURIComponent(id)}/history`, undefined, fetcher)

export const compareProjectRevisions = (id: string, from: string, to: string, fetcher?: Fetcher) => request<RevisionComparison>(
  `/api/projects/${encodeURIComponent(id)}/history/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  undefined,
  fetcher,
)

export const restoreProjectRevision = (id: string, targetRevision: string, currentRevision: string, fetcher?: Fetcher) => request<{ revision: string; restoredFrom: string; changedFiles: string[] }>(
  `/api/projects/${encodeURIComponent(id)}/history/${encodeURIComponent(targetRevision)}/restore`,
  { method: 'POST', headers: { 'If-Match': currentRevision } },
  fetcher,
)

export const startBuild = (id: string, fetcher?: Fetcher) => request<{ buildId: string; status: BuildStatus['status'] }>(`/api/projects/${encodeURIComponent(id)}/build`, {
  method: 'POST',
}, fetcher)

export const getPreview = (id: string, kind: PreviewKind, fetcher?: Fetcher) => request<Preview>(
  `/api/projects/${encodeURIComponent(id)}/preview?kind=${encodeURIComponent(kind)}`,
  undefined,
  fetcher,
)

export const getSimulation = (id: string, fetcher?: Fetcher) => request<Simulation>(`/api/projects/${encodeURIComponent(id)}/simulation`, undefined, fetcher)

export const getManufacturingProfiles = (fetcher?: Fetcher) => request<{ profiles: ManufacturingProfile[] }>('/api/manufacturing/profiles', undefined, fetcher)

export const getManufacturingPreflight = (id: string, profile = 'board-default', fetcher?: Fetcher) => request<{ projectRevision: string; previewRevision: string; preflight: ManufacturingPreflight }>(
  `/api/projects/${encodeURIComponent(id)}/manufacturing?profile=${encodeURIComponent(profile)}`,
  undefined,
  fetcher,
)

export async function getManufacturingArchive(id: string, profile = 'board-default', fetcher: Fetcher = fetch) {
  const response = await fetcher(`/api/projects/${encodeURIComponent(id)}/manufacturing.zip?profile=${encodeURIComponent(profile)}`)
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string; preflight?: { checks?: Array<{ status: string; message: string }> } }
    const failures = payload.preflight?.checks?.filter((check) => check.status === 'fail').map((check) => check.message) ?? []
    throw new Error([payload.error || `Manufacturing export failed (${response.status})`, ...failures].join(': '))
  }
  return response.blob()
}

export function subscribeToProject(id: string, onEvent: (event: ProjectEvent) => void): () => void {
  const source = new EventSource(`/api/projects/${encodeURIComponent(id)}/events`)
  const eventNames = ['project', 'file', 'build.status', 'build.ready', 'build.failed'] as const
  for (const type of eventNames) {
    source.addEventListener(type, (event) => {
      try {
        onEvent({ type, ...JSON.parse((event as MessageEvent<string>).data) } as ProjectEvent)
      } catch {
        // Ignore malformed events; the next valid event or reload can recover state.
      }
    })
  }
  return () => source.close()
}
