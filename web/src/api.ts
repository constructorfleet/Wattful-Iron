export type Project = {
  id: string
  name: string
  entrypoint: string
  revision: string
  updatedAt?: string
  referencePdfs?: Array<{ id: string; name: string }>
}
export type ProjectTemplate = { id: string; name: string; description: string }

export type ProjectFile = { path: string; content: string; revision: string }
export type ProjectRevision = {
  revision: string
  createdAt: string
  changedFiles: string[]
  sizeBytes?: number
  commit?: string
  retainedSnapshot: boolean
  hasDesignSummary: boolean
}
export type ProjectHistory = { gitBacked: boolean; snapshotRetention: number; revisions: ProjectRevision[] }
export type DesignComponentSummary = { name: string; ftype?: string; value?: string; manufacturerPartNumber?: string; footprint?: string; pinCount: number }
export type DesignNetSummary = { name: string; pinCount: number; routing: string }
export type DesignChange = { name: string; changes: Array<{ property: string; before?: string | number; after?: string | number }> }
export type DesignDiff =
  | {
    available: true
    board: Array<{ property: string; before?: number; after?: number }>
    components: { added: DesignComponentSummary[]; removed: DesignComponentSummary[]; changed: DesignChange[] }
    nets: { added: DesignNetSummary[]; removed: DesignNetSummary[]; changed: DesignChange[] }
    counts: Array<{ metric: string; before: number; after: number }>
    simulation: Array<{ property: string; before: string | number; after: string | number }>
    limitations: string[]
  }
  | { available: false; reason: string }
export type RevisionComparison = { from: string; to: string; files: Array<{ path: string; before: string | null; after: string | null }>; design: DesignDiff }
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
export type SimulationOperatingPoint = { id: string; name: string; unit: 'V' | 'A'; value: number; netId?: string; sourceComponentId?: string; experimentId?: string }
export type SimulationSweep = {
  id: string
  name: string
  kind: 'dc' | 'ac'
  unit: 'V' | 'A'
  xLabel: string
  netId?: string
  samples: Array<{ x: number; y: number }>
  magnitudeDb?: Array<{ x: number; y: number }>
  phaseDeg?: Array<{ x: number; y: number }>
}
export type Simulation = {
  revision: string
  status: 'complete' | 'failed' | 'not_configured'
  experiments: Array<{ id: string; name: string; type: string }>
  signals: Array<{ id: string; name: string; unit: 'V' | 'A'; netId?: string; samples: Array<{ x: number; y: number }> }>
  operatingPoints: SimulationOperatingPoint[]
  sweeps: SimulationSweep[]
  analyses: Array<{ type: string; experiments: number; resultCount: number }>
  diagnostics: Array<{ message: string; severity: 'error' }>
  notEvaluated: Array<{ analysis: string; reason: string }>
}
export type PowerAnalysis = {
  revision: string
  status: 'complete' | 'partial' | 'not-evaluated'
  assumptions: string[]
  traceCapacity: Array<{ pcbTraceId?: string; widthMm: number; layers: string[]; maxCurrentA: number }>
  narrowestTrace?: { pcbTraceId?: string; widthMm: number; layers: string[]; maxCurrentA: number }
  nodeVoltages: Array<{ name: string; voltageV: number; netId?: string }>
  branchCurrents: Array<{ name: string; currentA: number; netId?: string; sourceComponentId?: string; componentName?: string }>
  componentPower: Array<{ sourceComponentId: string; name: string; ftype?: string; dissipationW: number; method: 'I2R' | 'V2R' }>
  supplyLoads: Array<{ sourceComponentId?: string; name: string; currentA: number; voltageV?: number; powerW?: number }>
  traceLoads: Array<{ pcbTraceId?: string; netId?: string; netName?: string; currentA: number; maxCurrentA: number; utilization: number; status: 'ok' | 'over-capacity' }>
  totalSupplyCurrentA?: number
  totalDissipationW?: number
  notEvaluated: Array<{ quantity: string; reason: string }>
}
export type NetPin = { sourcePortId: string; pinName: string; pinNumber?: number; sourceComponentId?: string; componentName?: string; pcbPortId?: string; routed: boolean }
export type NetCopperTrace = { pcbTraceId: string; layers: string[]; widthMm?: number; lengthMm: number; connectedPcbPortIds: string[] }
export type NetVia = { pcbViaId: string; x: number; y: number; fromLayer?: string; toLayer?: string }
export type NetSimulationSignal = { id: string; name: string; unit: 'V' | 'A' }
export type TracedNet = {
  id: string
  name: string
  names: string[]
  connectivityKey?: string
  sourceTraceIds: string[]
  pins: NetPin[]
  schematicTraces: Array<{ schematicTraceId: string; edgeCount: number }>
  copperTraces: NetCopperTrace[]
  vias: NetVia[]
  simulationSignals: NetSimulationSignal[]
  routing: 'routed' | 'partially-routed' | 'unrouted' | 'not-applicable'
}
export type NetTraceIndex = { revision: string; nets: TracedNet[]; uncorrelatedSimulationSignals: NetSimulationSignal[]; limitations: string[] }
export type SourcedPart = {
  lcscPartNumber: string
  manufacturerPartNumber?: string
  package?: string
  description?: string
  stockQuantity?: number
  unitPriceUsd?: number
  isBasicPart?: boolean
  isPreferredPart?: boolean
}
export type ComponentSourcing = { configured: boolean; provider?: string; part?: SourcedPart; error?: string }
export type BomCost = {
  configured: boolean
  provider?: string
  revision: string
  boards?: number
  lines?: Array<{ name: string; quantity: number; lcscPartNumber?: string; unitPriceUsd?: number; extendedPriceUsd?: number; stockQuantity?: number; isBasicPart?: boolean }>
  unpriced?: Array<{ name: string; reason: string }>
  componentCostUsd?: number
  limitations?: string[]
  parts?: Array<{ name: string; quantity: number; lcscPartNumbers: string[]; manufacturerPartNumber?: string }>
  message?: string
}
export type ReviewState = 'draft' | 'validated' | 'reviewed' | 'manufacturing_approved'
export type ReviewEntry = {
  state: ReviewState
  revision: string
  at: string
  note?: string
  source: 'browser' | 'mcp'
  evidence?: { buildStatus?: string; assertions?: { passed: number; failed: number; notEvaluated: number }; preflightReady?: boolean; components?: number; nets?: number }
}
export type ReviewView = {
  state: ReviewState
  revision: string
  current?: ReviewEntry
  supersededFrom?: { state: ReviewState; revision: string; at: string }
  locked: boolean
  history: ReviewEntry[]
  evidence: { buildStatus?: string; buildRevision?: string; projectRevision: string; assertions?: { passed: number; failed: number; notEvaluated: number }; assertionsConfigured?: boolean; preflightReady?: boolean }
  transitions: Array<{ state: ReviewState; allowed: boolean; reason?: string; agentAllowed: boolean }>
}
export type AssertionResult = { id: string; status: 'pass' | 'fail' | 'not-evaluated'; message: string }
export type AssertionCheck = {
  configured: boolean
  revision: string
  previewRevision?: string
  message?: string
  report?: { results: AssertionResult[]; passed: number; failed: number; notEvaluated: number; baselineRevision?: string }
}
export type ManufacturingProfile = {
  id: string
  label: string
  description: string
  rules: {
    minTraceWidthMm: number
    minNonPlatedHoleMm: number
    copperToBoardEdgeMm: number
    minViaHoleMm: number
    minViaDiameterMm: number
    minAnnularRingMm: number
  }
}
export type ManufacturingCheckIssue = { severity: 'error' | 'warning'; type: string; category: string; message: string; affectedIds: string[] }
export type ManufacturingCheck = { id: string; status: 'pass' | 'fail' | 'warning' | 'not-evaluated'; message: string; issues?: ManufacturingCheckIssue[] }
export type ManufacturingPreflight = { ready: boolean; profile: Pick<ManufacturingProfile, 'id' | 'label'>; checks: ManufacturingCheck[] }
type Fetcher = typeof fetch

function responseErrorMessage(detail: string, fallback: string) {
  try {
    const payload = JSON.parse(detail) as { error?: unknown }
    if (typeof payload.error === 'string') return payload.error
  } catch { /* Keep a plain-text server message as-is. */ }
  return detail || fallback
}

async function request<T>(url: string, init: RequestInit = {}, fetcher: Fetcher = fetch): Promise<T> {
  const response = await fetcher(url, init)
  if (response.status === 409 || response.status === 412) {
    const payload = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(payload.error || 'The project changed while this action was in progress. Reload it and try again.')
  }
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(responseErrorMessage(detail, `Request failed (${response.status})`))
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

export const duplicateProject = (id: string, name: string, revision: string, fetcher?: Fetcher) => request<Project>(`/api/projects/${encodeURIComponent(id)}/duplicate`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'If-Match': revision },
  body: JSON.stringify({ name }),
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

export const importPdfReference = (name: string, file: File, fetcher?: Fetcher) => {
  const query = new URLSearchParams({ name, filename: file.name }).toString()
  return request<Project>(`/api/projects/import-pdf?${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf' },
    body: file,
  }, fetcher)
}

export const importProjectArchive = (file: File, fetcher?: Fetcher) => request<Project>('/api/projects/import-archive', {
  method: 'POST',
  headers: { 'Content-Type': 'application/zip' },
  body: file,
}, fetcher)

export async function exportProjectArchive(id: string, fetcher: Fetcher = fetch) {
  const response = await fetcher(`/api/projects/${encodeURIComponent(id)}/export`)
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(responseErrorMessage(detail, `Project export failed (${response.status})`))
  }
  return response.blob()
}

export const getProjectReferencePdfUrl = (projectId: string, referenceId: string) =>
  `/api/projects/${encodeURIComponent(projectId)}/references/${encodeURIComponent(referenceId)}`

export const getProject = (id: string, fetcher?: Fetcher) => request<Project>(`/api/projects/${encodeURIComponent(id)}`, undefined, fetcher)

const fileUrl = (id: string, path: string) => `/api/projects/${encodeURIComponent(id)}/files?path=${encodeURIComponent(path)}`
export const getProjectFile = (id: string, path: string, fetcher?: Fetcher) => request<ProjectFile>(fileUrl(id, path), undefined, fetcher)
export const getProjectFiles = (id: string, fetcher?: Fetcher) => request<string[]>(`/api/projects/${encodeURIComponent(id)}/file-list`, undefined, fetcher)

export const saveProjectFile = (id: string, path: string, content: string, revision: string, fetcher?: Fetcher) => request<ProjectFile>(fileUrl(id, path), {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', 'If-Match': revision },
  body: JSON.stringify({ content, revision }),
}, fetcher)

export const getProjectHistory = (id: string, fetcher?: Fetcher) => request<ProjectHistory>(`/api/projects/${encodeURIComponent(id)}/history`, undefined, fetcher)

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

export const generatePcbDraft = (id: string, revision: string, fetcher?: Fetcher) => request<{ revision: string; placements: number }>(`/api/projects/${encodeURIComponent(id)}/generate-pcb`, {
  method: 'POST', headers: { 'If-Match': revision },
}, fetcher)

export const getPreview = (id: string, kind: PreviewKind, fetcher?: Fetcher) => request<Preview>(
  `/api/projects/${encodeURIComponent(id)}/preview?kind=${encodeURIComponent(kind)}`,
  undefined,
  fetcher,
)

export const getSimulation = (id: string, fetcher?: Fetcher) => request<Simulation>(`/api/projects/${encodeURIComponent(id)}/simulation`, undefined, fetcher)

export async function getComponentSourcing(part: string, fetcher: Fetcher = fetch): Promise<ComponentSourcing> {
  const response = await fetcher(`/api/components/${encodeURIComponent(part)}`)
  if (response.status === 503) return { configured: false, ...(await response.json().catch(() => ({}))) as { error?: string } }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string }
    return { configured: true, error: payload.error || `Supplier lookup failed (${response.status})` }
  }
  return response.json() as Promise<ComponentSourcing>
}

export const getBomCost = (id: string, boards = 1, fetcher?: Fetcher) => request<BomCost>(
  `/api/projects/${encodeURIComponent(id)}/bom-cost?boards=${encodeURIComponent(String(boards))}`,
  undefined,
  fetcher,
)

export const getReviewState = (id: string, fetcher?: Fetcher) => request<ReviewView>(`/api/projects/${encodeURIComponent(id)}/review`, undefined, fetcher)

export const setReviewState = (id: string, state: ReviewState, revision: string, note?: string, fetcher?: Fetcher) => request<ReviewView>(
  `/api/projects/${encodeURIComponent(id)}/review`,
  { method: 'POST', headers: { 'Content-Type': 'application/json', 'If-Match': revision }, body: JSON.stringify({ state, ...(note ? { note } : {}) }) },
  fetcher,
)

export const getAssertionCheck = (id: string, fetcher?: Fetcher) => request<AssertionCheck>(`/api/projects/${encodeURIComponent(id)}/assertions/check`, undefined, fetcher)

export const getPower = (id: string, fetcher?: Fetcher) => request<PowerAnalysis>(`/api/projects/${encodeURIComponent(id)}/power`, undefined, fetcher)

export const getNets = (id: string, fetcher?: Fetcher) => request<NetTraceIndex>(`/api/projects/${encodeURIComponent(id)}/nets`, undefined, fetcher)

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
