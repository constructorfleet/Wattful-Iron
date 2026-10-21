import { Fragment, lazy, Suspense, useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import Editor from '@monaco-editor/react'
import { configureMonaco } from './configureMonaco'
import { hasPcbPreviewData } from './previewAvailability'
import { getInspectedComponents } from './componentInspector'
import { WaveformViewer } from './WaveformViewer'
import { applyBoardOutline, getBoardOutline, parseSvgOutline, validateBoardOutline, type BoardOutlinePoint } from './boardOutline'
import {
  compareProjectRevisions,
  createProject,
  duplicateProject as duplicateProjectApi,
  exportProjectArchive,
  getManufacturingArchive,
  getManufacturingPreflight,
  getAssertionCheck,
  getReviewState,
  setReviewState,
  getBomCost,
  getComponentSourcing,
  getManufacturingProfiles,
  getNets,
  getPower,
  getPreview,
  getProject,
  getProjectFile,
  getProjectFiles,
  getProjectHistory,
  getProjectReferencePdfUrl,
  generatePcbDraft,
  getSimulation,
  importPdfReference,
  importProjectArchive,
  importSchematics,
  listProjects,
  listProjectTemplates,
  saveProjectFile,
  restoreProjectRevision,
  startBuild,
  subscribeToProject,
  type BuildStatus,
  type ManufacturingCheck,
  type ManufacturingPreflight,
  type AssertionCheck,
  type ReviewState as ReviewStateName,
  type ReviewView,
  type BomCost,
  type ComponentSourcing,
  type ManufacturingProfile,
  type NetTraceIndex,
  type PowerAnalysis,
  type PreviewKind,
  type Project,
  type ProjectTemplate,
  type ProjectEvent,
  type TracedNet,
  type ProjectRevision,
  type DesignDiff,
  type RevisionComparison,
  type Simulation,
  type SimulationSweep,
} from './api'

const views: Array<{ kind: PreviewKind | 'simulation'; label: string; tab: 'schematic' | 'pcb' | 'cad' | 'simulation' }> = [
  { kind: 'schematic', label: 'Schematic', tab: 'schematic' },
  { kind: 'pcb', label: 'PCB', tab: 'pcb' },
  { kind: '3d', label: '3D', tab: 'cad' },
  { kind: 'simulation', label: 'Simulation', tab: 'simulation' },
]

function editorLanguage(path: string) {
  const extension = path.toLowerCase().split('.').pop()
  return ({ tsx: 'typescript', ts: 'typescript', jsx: 'javascript', js: 'javascript', json: 'json', css: 'css', html: 'html', md: 'markdown', yml: 'yaml', yaml: 'yaml' } as Record<string, string>)[extension ?? ''] ?? 'plaintext'
}

const initialBuild: BuildStatus = { status: 'idle' }
const CircuitJsonPreview = lazy(() => import('@tscircuit/runframe').then((module) => ({ default: module.CircuitJsonPreview })))
const PcbPreview = lazy(() => import('./PcbPreview'))
type PcbCircuitJson = import('./PcbPreview').PcbCircuitJson

function Divider({ index, widths, drag, resizePanel }: { index: number; widths: number[]; drag: { current: { index: number; startX: number; width: number; lastDelta: number } | null }; resizePanel: (index: number, amount: number) => void }) {
  // biome-ignore lint/a11y/useSemanticElements: <hr> cannot carry the focusable drag handle this divider needs
  return <div className="multiview-divider" role="separator" aria-orientation="vertical" aria-label={index === 0 ? 'Resize schematic and PCB previews' : 'Resize PCB and 3D previews'} aria-valuemin={15} aria-valuemax={85} aria-valuenow={Math.round(widths[index])} tabIndex={0}
    onKeyDown={(event) => { if (event.key === 'ArrowLeft') { event.preventDefault(); resizePanel(index, -2) } if (event.key === 'ArrowRight') { event.preventDefault(); resizePanel(index, 2) } }}
    onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => { drag.current = { index, startX: event.clientX, width: event.currentTarget.parentElement?.getBoundingClientRect().width || 1, lastDelta: 0 }; event.currentTarget.setPointerCapture(event.pointerId) }}
    onPointerMove={(event: ReactPointerEvent<HTMLDivElement>) => { const start = drag.current; if (!start || start.index !== index) return; const delta = (event.clientX - start.startX) / start.width * 100; drag.current = { ...start, lastDelta: delta }; resizePanel(index, delta - start.lastDelta) }}
    onPointerUp={() => { drag.current = null }} />
}

async function fetchPdfUrl(value: string): Promise<File> {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('Enter a valid public PDF URL') }
  if (url.protocol !== 'https:') throw new Error('PDF URLs must use HTTPS')
  if (url.username || url.password) throw new Error('PDF URLs must not contain credentials')
  let filename: string
  try { filename = decodeURIComponent(url.pathname.split('/').pop() ?? '') } catch { filename = '' }
  if (!filename || !/\.pdf$/i.test(filename)) throw new Error('The URL must end in a .pdf filename')
  let response: Response
  try { response = await fetch(url, { mode: 'cors', credentials: 'omit' }) } catch { throw new Error('Could not read the PDF URL. It must allow public cross-origin access, or choose the file from disk.') }
  if (!response.ok) throw new Error(`PDF download failed with HTTP ${response.status}`)
  const declaredSize = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredSize) && declaredSize > 20 * 1024 * 1024) throw new Error('PDF references must be 20 MB or smaller')
  const content = await response.blob()
  if (content.size > 20 * 1024 * 1024) throw new Error('PDF references must be 20 MB or smaller')
  return new File([content], filename, { type: 'application/pdf' })
}

export default function App() {
  const [projects, setProjects] = useState<Project[]>([])
  const [project, setProject] = useState<Project | null>(null)
  const [filePath, setFilePath] = useState('')
  const [projectFiles, setProjectFiles] = useState<string[]>([])
  const [source, setSource] = useState('')
  const [revision, setRevision] = useState('')
  const [dirty, setDirty] = useState(false)
  const [unsavedDialogOpen, setUnsavedDialogOpen] = useState(false)
  const [view, setView] = useState<PreviewKind | 'simulation'>('schematic')
  const [showAllViews, setShowAllViews] = useState(false)
  const [panelWidths, setPanelWidths] = useState([33.3, 33.4, 33.3])
  const panelDrag = useRef<{ index: number; startX: number; width: number; lastDelta: number } | null>(null)
  const [preview, setPreview] = useState<unknown>(null)
  const [componentInspectorOpen, setComponentInspectorOpen] = useState(false)
  const [boardOutlineOpen, setBoardOutlineOpen] = useState(false)
  const [boardOutlinePoints, setBoardOutlinePoints] = useState<BoardOutlinePoint[]>([])
  const [boardOutlineError, setBoardOutlineError] = useState('')
  const [selectedComponentId, setSelectedComponentId] = useState('')
  const [simulation, setSimulation] = useState<Simulation | null>(null)
  const [netIndex, setNetIndex] = useState<NetTraceIndex | null>(null)
  const [power, setPower] = useState<PowerAnalysis | null>(null)
  const [netInspectorOpen, setNetInspectorOpen] = useState(false)
  const [selectedNetId, setSelectedNetId] = useState('')
  const [build, setBuild] = useState<BuildStatus>(initialBuild)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [historyDialogOpen, setHistoryDialogOpen] = useState(false)
  const [referencePdfOpen, setReferencePdfOpen] = useState(false)
  const [historyRevisions, setHistoryRevisions] = useState<ProjectRevision[]>([])
  const [historyGitBacked, setHistoryGitBacked] = useState(false)
  const [historyFrom, setHistoryFrom] = useState('')
  const [historyTo, setHistoryTo] = useState('')
  const [revisionToRestore, setRevisionToRestore] = useState('')
  const [revisionComparison, setRevisionComparison] = useState<RevisionComparison | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [restoringHistory, setRestoringHistory] = useState(false)
  const [creating, setCreating] = useState(false)
  const [archiveFile, setArchiveFile] = useState<File | null>(null)
  const [importingArchive, setImportingArchive] = useState(false)
  const [exportingArchive, setExportingArchive] = useState(false)
  const [duplicatingProjectId, setDuplicatingProjectId] = useState('')
  const [projectName, setProjectName] = useState('')
  const [projectTemplate, setProjectTemplate] = useState('blank-board')
  const [schematicFiles, setSchematicFiles] = useState<File[]>([])
  const [referencePdf, setReferencePdf] = useState<File | null>(null)
  const [referencePdfUrl, setReferencePdfUrl] = useState('')
  const [projectTemplates, setProjectTemplates] = useState<ProjectTemplate[]>([])
  const [saving, setSaving] = useState(false)
  const [exportingManufacturing, setExportingManufacturing] = useState(false)
  const [manufacturingProfile, setManufacturingProfile] = useState('board-default')
  const [manufacturingProfiles, setManufacturingProfiles] = useState<ManufacturingProfile[]>([])
  const [manufacturingPreflight, setManufacturingPreflight] = useState<ManufacturingPreflight | null>(null)
  const [manufacturingDialogOpen, setManufacturingDialogOpen] = useState(false)
  const [bomCost, setBomCost] = useState<BomCost | null>(null)
  const [assertionCheck, setAssertionCheck] = useState<AssertionCheck | null>(null)
  const [review, setReview] = useState<ReviewView | null>(null)
  const [reviewDialogOpen, setReviewDialogOpen] = useState(false)
  const [reviewNote, setReviewNote] = useState('')
  const [recordingReview, setRecordingReview] = useState(false)
  const [boardQuantity, setBoardQuantity] = useState(1)
  const [componentSourcing, setComponentSourcing] = useState<ComponentSourcing | null>(null)
  const [loadingManufacturing, setLoadingManufacturing] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sourceRef = useRef(source)
  const revisionRef = useRef(revision)
  const restoringHistoryRef = useRef(false)
  const pendingNavigationRef = useRef<(() => Promise<void>) | null>(null)
  const inspectedComponents = getInspectedComponents(preview)
  const tracedNets = netIndex?.nets ?? []
  const selectedNet = tracedNets.find(({ id }) => id === selectedNetId) ?? tracedNets[0]
  const selectedComponent = inspectedComponents.find(({ id }) => id === selectedComponentId) ?? inspectedComponents[0]
  const selectedComponentLcscPart = lcscPartNumberOf(selectedComponent?.properties)

  useEffect(() => { sourceRef.current = source }, [source])
  useEffect(() => { revisionRef.current = revision }, [revision])

  const refreshPreview = useCallback(async (id: string, kind: PreviewKind | 'simulation') => {
    try {
      const result = await getPreview(id, kind === 'simulation' ? 'schematic' : kind)
      if (kind === view && kind !== 'simulation') setPreview(result.circuitJson)
      const sim = await getSimulation(id)
      if (sim.revision === result.revision) setSimulation(sim)
      const nets = await getNets(id)
      if (nets.revision === result.revision) setNetIndex(nets)
      const powerAnalysis = await getPower(id)
      if (powerAnalysis.revision === result.revision) setPower(powerAnalysis)
    } catch {
      if (kind === view) setPreview(null)
    }
  }, [view])

  const loadProject = useCallback(async (listedProject: Project) => {
    setError('')
    setReferencePdfOpen(false)
    setPreview(null)
    setSimulation(null)
    setNetIndex(null)
    setPower(null)
    setSelectedNetId('')
    setBuild(initialBuild)
    try {
      const opened = await getProject(listedProject.id)
      const path = opened.entrypoint || listedProject.entrypoint || 'index.tsx'
      const [file, files] = await Promise.all([getProjectFile(opened.id, path), getProjectFiles(opened.id)])
      setProject(opened)
      setProjects((current) => current.some((item) => item.id === opened.id) ? current : [opened, ...current])
      setFilePath(file.path)
      setProjectFiles(files)
      setSource(file.content)
      setRevision(file.revision)
      setDirty(false)
      setBuild(initialBuild)
      void refreshPreview(opened.id, view)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to open project')
    }
  }, [refreshPreview, view])

  const requestNavigation = useCallback((action: () => Promise<void>) => {
    if (dirty) {
      pendingNavigationRef.current = action
      setUnsavedDialogOpen(true)
      return
    }
    void action()
  }, [dirty])

  const openProject = useCallback((listedProject: Project) => {
    requestNavigation(() => loadProject(listedProject))
  }, [loadProject, requestNavigation])

  const duplicateExistingProject = (item: Project) => requestNavigation(async () => {
    setError('')
    setDuplicatingProjectId(item.id)
    try {
      const current = await getProject(item.id)
      const duplicate = await duplicateProjectApi(item.id, `${item.name.slice(0, 95)} copy`, current.revision)
      setProjects((items) => [duplicate, ...items.filter(({ id }) => id !== duplicate.id)])
      await loadProject(duplicate)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to duplicate project')
    } finally {
      setDuplicatingProjectId('')
    }
  })

  const handleArchiveImport = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!archiveFile) return
    setError('')
    setImportingArchive(true)
    try {
      const imported = await importProjectArchive(archiveFile)
      setProjects((items) => [imported, ...items.filter(({ id }) => id !== imported.id)])
      setArchiveFile(null)
      const input = document.getElementById('project-archive') as HTMLInputElement | null
      if (input) input.value = ''
      openProject(imported)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to import project archive')
    } finally {
      setImportingArchive(false)
    }
  }

  const downloadProjectArchive = async () => {
    if (!project) return
    setError('')
    setExportingArchive(true)
    try {
      const archive = await exportProjectArchive(project.id)
      const url = URL.createObjectURL(archive)
      const link = document.createElement('a')
      link.href = url
      link.download = `${project.name.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-|-$/g, '') || 'project'}.zip`
      document.body.append(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to export project archive')
    } finally {
      setExportingArchive(false)
    }
  }

  const openFile = useCallback((path: string) => {
    if (!project || path === filePath) return
    requestNavigation(async () => {
      setError('')
      try {
        const file = await getProjectFile(project.id, path)
        setFilePath(file.path)
        setSource(file.content)
        setRevision(file.revision)
        revisionRef.current = file.revision
        setDirty(false)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Unable to open file')
      }
    })
  }, [filePath, project, requestNavigation])

  const finishNavigation = async (choice: 'save' | 'discard' | 'cancel') => {
    if (choice === 'cancel') {
      pendingNavigationRef.current = null
      setUnsavedDialogOpen(false)
      return
    }
    const action = pendingNavigationRef.current
    if (choice === 'save' && project) {
      if (timer.current) clearTimeout(timer.current)
      setSaving(true)
      try {
        const saved = await saveProjectFile(project.id, filePath, sourceRef.current, revisionRef.current)
        revisionRef.current = saved.revision
        setRevision(saved.revision)
        setDirty(false)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Unable to save file')
        setSaving(false)
        return
      }
      setSaving(false)
    } else {
      if (timer.current) clearTimeout(timer.current)
      setDirty(false)
    }
    pendingNavigationRef.current = null
    setUnsavedDialogOpen(false)
    await action?.()
  }

  useEffect(() => {
    let active = true
    listProjects().then((items) => {
      if (active) setProjects(items)
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : 'Unable to load projects')
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  useEffect(() => {
    listProjectTemplates().then(setProjectTemplates).catch(() => setProjectTemplates([]))
  }, [])

  useEffect(() => {
    getManufacturingProfiles().then(({ profiles }) => setManufacturingProfiles(profiles)).catch(() => setManufacturingProfiles([]))
  }, [])

  const refreshReview = useCallback(async (id: string) => {
    try { setReview(await getReviewState(id)) } catch { setReview(null) }
  }, [])

  useEffect(() => {
    if (!project) { setReview(null); return }
    void refreshReview(project.id)
  }, [project?.id, revision, build.status, build.revision, refreshReview])

  useEffect(() => {
    if (!project) { setManufacturingPreflight(null); return }
    let active = true
    setLoadingManufacturing(true)
    getManufacturingPreflight(project.id, manufacturingProfile).then(({ preflight }) => { if (active) setManufacturingPreflight(preflight) }).catch(() => { if (active) setManufacturingPreflight(null) }).finally(() => { if (active) setLoadingManufacturing(false) })
    return () => { active = false }
  }, [project?.id, manufacturingProfile, build.status, build.revision])

  useEffect(() => {
    if (!project || !manufacturingDialogOpen) { setBomCost(null); setAssertionCheck(null); return }
    let active = true
    getBomCost(project.id, boardQuantity).then((cost) => { if (active) setBomCost(cost) }).catch(() => { if (active) setBomCost(null) })
    getAssertionCheck(project.id).then((result) => { if (active) setAssertionCheck(result) }).catch(() => { if (active) setAssertionCheck(null) })
    return () => { active = false }
  }, [project?.id, manufacturingDialogOpen, boardQuantity, build.revision])

  useEffect(() => {
    const lcsc = selectedComponentLcscPart
    if (!componentInspectorOpen || !lcsc) { setComponentSourcing(null); return }
    let active = true
    getComponentSourcing(lcsc).then((result) => { if (active) setComponentSourcing(result) }).catch((cause: unknown) => {
      if (active) setComponentSourcing({ configured: true, error: cause instanceof Error ? cause.message : 'Supplier lookup failed' })
    })
    return () => { active = false }
  }, [componentInspectorOpen, selectedComponentLcscPart])

  useEffect(() => {
    if (!project) return
    return subscribeToProject(project.id, (event: ProjectEvent) => {
      if (event.type === 'build.status') {
        setBuild(event)
      } else if (event.type === 'build.ready') {
        setBuild({ status: 'ready', buildId: event.buildId, revision: event.revision })
        void refreshPreview(project.id, view)
      } else if (event.type === 'build.failed') {
        setBuild({ status: 'failed', buildId: event.buildId, revision: event.revision, diagnostics: event.diagnostics })
      } else if (event.type === 'file' && event.path === filePath && event.revision !== revisionRef.current) {
        if (!restoringHistoryRef.current) setError('This file changed outside the editor. Reload it before editing further.')
      }
    })
  }, [filePath, project, refreshPreview, view])

  useEffect(() => {
    if (!project || !dirty) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(async () => {
      setSaving(true)
      try {
        const saved = await saveProjectFile(project.id, filePath, sourceRef.current, revisionRef.current)
        revisionRef.current = saved.revision
        setRevision(saved.revision)
        setDirty(false)
        setError('')
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Unable to save file')
      } finally {
        setSaving(false)
      }
    }, 600)
    return () => { if (timer.current) clearTimeout(timer.current) }
  }, [dirty, filePath, project, source])

  useEffect(() => {
    if (project && build.status === 'ready') void refreshPreview(project.id, view)
  }, [build.status, project, refreshPreview, view])

  useEffect(() => {
    if (!project || dirty || !revision) return
    let active = true
    setHistoryLoading(true)
    getProjectHistory(project.id).then(({ revisions: items, gitBacked }) => {
      if (!active) return
      setHistoryRevisions(items)
      setHistoryGitBacked(gitBacked)
      setHistoryFrom(items[1]?.revision ?? items[0]?.revision ?? '')
      setHistoryTo(items[0]?.revision ?? '')
      setRevisionToRestore(items[0]?.revision ?? '')
    }).catch(() => { if (active) setHistoryRevisions([]) }).finally(() => { if (active) setHistoryLoading(false) })
    return () => { active = false }
  }, [project?.id, revision, dirty])

  useEffect(() => {
    if (!project || !historyFrom || !historyTo || historyFrom === historyTo) { setRevisionComparison(null); return }
    let active = true
    compareProjectRevisions(project.id, historyFrom, historyTo).then((comparison) => { if (active) setRevisionComparison(comparison) }).catch(() => { if (active) setRevisionComparison(null) })
    return () => { active = false }
  }, [project?.id, historyFrom, historyTo])

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault()
    const name = projectName.trim()
    if (!name) return
    setError('')
    try {
      const remotePdf = referencePdfUrl.trim()
      const result = referencePdf || remotePdf
        ? { project: await importPdfReference(name, referencePdf ?? await fetchPdfUrl(remotePdf)), warnings: [] as string[] }
        : schematicFiles.length
          ? await importSchematics(name, await Promise.all(schematicFiles.map(async (file) => ({ name: file.name, content: await file.text() }))))
          : { project: await createProject(name, projectTemplate), warnings: [] as string[] }
      const created = result.project
      setProjects((current) => [created, ...current.filter((item) => item.id !== created.id)])
      setCreating(false)
      setProjectName('')
      setSchematicFiles([])
      setReferencePdf(null)
      setReferencePdfUrl('')
      await openProject(created)
      if (result.warnings.length) setError(`Imported with review notes: ${result.warnings.join('; ')}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to create project')
    }
  }

  const runBuild = async () => {
    if (!project) return
    setError('')
    try {
      if (dirty) {
        if (timer.current) clearTimeout(timer.current)
        setSaving(true)
        const saved = await saveProjectFile(project.id, filePath, sourceRef.current, revisionRef.current)
        revisionRef.current = saved.revision
        setRevision(saved.revision)
        setDirty(false)
        setSaving(false)
      }
      await startBuild(project.id)
      setBuild({ status: 'compiling' })
    } catch (cause) {
      setSaving(false)
      setError(cause instanceof Error ? cause.message : 'Unable to start build')
    }
  }

  const openBoardOutlineEditor = () => {
    setBoardOutlineError('')
    setBoardOutlinePoints(getBoardOutline(sourceRef.current, preview))
    setBoardOutlineOpen(true)
  }

  const applyEditedBoardOutline = () => {
    const validationError = validateBoardOutline(boardOutlinePoints)
    if (validationError) {
      setBoardOutlineError(validationError)
      return
    }
    try {
      setSource(applyBoardOutline(sourceRef.current, boardOutlinePoints))
      setDirty(true)
      setBoardOutlineOpen(false)
      setError('')
    } catch (cause) {
      setBoardOutlineError(cause instanceof Error ? cause.message : 'Unable to update board outline')
    }
  }

  const importBoardOutlineSvg = async (file: File) => {
    try {
      setBoardOutlinePoints(parseSvgOutline(await readFileText(file)))
      setBoardOutlineError('')
    } catch (cause) {
      setBoardOutlineError(cause instanceof Error ? cause.message : 'Unable to read SVG outline')
    }
  }

  const createPcbDraft = async () => {
    if (!project || dirty || !revision) return
    setError('')
    try {
      const result = await generatePcbDraft(project.id, revision)
      const [updatedProject, updatedFile] = await Promise.all([getProject(project.id), getProjectFile(project.id, filePath)])
      setProject(updatedProject)
      setProjects((items) => items.map((item) => item.id === updatedProject.id ? updatedProject : item))
      setRevision(result.revision)
      revisionRef.current = result.revision
      setSource(updatedFile.content)
      sourceRef.current = updatedFile.content
      setBuild({ status: 'ready', revision: result.revision })
      setView('pcb')
      await refreshPreview(project.id, 'pcb')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to generate PCB draft')
    }
  }

  const restoreRevision = async () => {
    if (!project || !revisionToRestore || !revision) return
    restoringHistoryRef.current = true
    setRestoringHistory(true)
    setError('')
    try {
      const restored = await restoreProjectRevision(project.id, revisionToRestore, revision)
      const file = await getProjectFile(project.id, filePath).catch(() => getProjectFile(project.id, project.entrypoint))
      revisionRef.current = restored.revision
      setRevision(restored.revision)
      setFilePath(file.path)
      setSource(file.content)
      setDirty(false)
      setProject({ ...project, revision: restored.revision })
      setBuild({ status: 'compiling', revision: restored.revision })
      setHistoryDialogOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to restore revision')
    } finally {
      restoringHistoryRef.current = false
      setRestoringHistory(false)
    }
  }

  const downloadManufacturing = async () => {
    if (!project) return
    setError('')
    setExportingManufacturing(true)
    try {
      const blob = await getManufacturingArchive(project.id, manufacturingProfile)
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${project.name.replace(/[^a-zA-Z0-9_-]+/g, '-')}-manufacturing.zip`
      anchor.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to export manufacturing files')
    } finally {
      setExportingManufacturing(false)
    }
  }

  const reloadFile = async () => {
    if (!project) return
    try {
      const file = await getProjectFile(project.id, filePath)
      revisionRef.current = file.revision
      setRevision(file.revision)
      setSource(file.content)
      setDirty(false)
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to reload file')
    }
  }

  const statusText = build.status === 'idle' ? 'Idle' : build.step || build.status[0].toUpperCase() + build.status.slice(1)
  const hasPcbPreview = hasPcbPreviewData(preview)

  const traceNetForPort = (sourcePortId: string) => {
    const net = tracedNets.find((item) => item.pins.some((pin) => pin.sourcePortId === sourcePortId))
    if (!net) return
    setSelectedNetId(net.id)
    setNetInspectorOpen(true)
  }

  const focusNetPin = (sourceComponentId?: string) => {
    if (!sourceComponentId) return
    setSelectedComponentId(sourceComponentId)
    setShowAllViews(false)
    setView('pcb')
  }

  const recordReviewState = async (target: ReviewStateName) => {
    if (!project || !review) return
    setRecordingReview(true)
    setError('')
    try {
      setReview(await setReviewState(project.id, target, review.revision, reviewNote.trim() || undefined))
      setReviewNote('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to record the review state')
    } finally {
      setRecordingReview(false)
    }
  }

  const resizePanel = (index: number, amount: number) => setPanelWidths((widths) => {
    const next = [...widths]
    const min = 15
    const delta = Math.max(-next[index] + min, Math.min(next[index + 1] - min, amount))
    next[index] += delta
    next[index + 1] -= delta
    return next
  })

  const renderPreviewCard = (kind: 'schematic' | 'pcb' | '3d') => <section className="multiview-card" aria-label={`${kind === '3d' ? '3D' : kind === 'pcb' ? 'PCB' : 'Schematic'} preview`} key={kind}>
    <h2>{kind === '3d' ? '3D' : kind === 'pcb' ? 'PCB' : 'Schematic'}</h2>
    <div className="multiview-canvas">
      {preview && (kind !== 'pcb' || hasPcbPreview) ? kind === 'pcb'
        ? <Suspense fallback={<div className="preview-loading">Loading PCB preview…</div>}><PcbPreview circuitJson={preview as PcbCircuitJson} selectedSourceComponentId={selectedComponentId} onViewSchematicComponent={(event) => { setSelectedComponentId(event.source_component_id); setComponentInspectorOpen(true); setView('schematic'); setShowAllViews(false) }} /></Suspense>
        : <Suspense fallback={<div className="preview-loading">Loading tscircuit preview…</div>}><CircuitJsonPreview className="circuit-preview" key={`${kind}-${build.revision || revision}`} circuitJson={preview} defaultActiveTab={kind === '3d' ? 'cad' : 'schematic'} showCodeTab={false} showImportAndFormatButtons={false} /></Suspense>
        : <div className="preview-placeholder"><h2>{preview ? 'No PCB layout in this project' : 'Waiting for first build'}</h2><p>{preview ? 'Generate a PCB draft to inspect placements and the 3D board.' : 'Build the project to generate design previews.'}</p></div>}
    </div>
  </section>

  useEffect(() => {
    if (project && view === 'simulation') getSimulation(project.id).then(setSimulation).catch(() => setSimulation(null))
  }, [project, view, build.status, build.revision])

  return (
    <main className="workbench">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Wattful-Iron workbench home"><img className="brand-logo" src="/Wattful-Iron.png" alt="" /><span>Wattful-Iron</span></a>
        <div className="project-heading">
          <span className="project-crumb">Projects</span>
          <span className="crumb-divider">/</span>
          <strong>{project?.name || 'Select a project'}</strong>
        </div>
        <div className="top-actions">
          <div className={`build-state ${build.status}`} aria-live="polite"><span className="status-dot" />{statusText}</div>
          {review && <button type="button" className={`build-button review-button ${review.state}`} disabled={!project} onClick={() => setReviewDialogOpen(true)}>{reviewStateLabels[review.state]}{review.locked ? ' 🔒' : ''}</button>}
          <button type="button" className="build-button history-button" disabled={!project} onClick={() => setHistoryDialogOpen(true)}>History</button>
          <button type="button" className="build-button" disabled={!project || exportingArchive} onClick={() => void downloadProjectArchive()}>{exportingArchive ? 'Exporting…' : 'Export project ZIP'}</button>
          <button type="button" className="build-button" disabled={!project?.referencePdfs?.length} onClick={() => setReferencePdfOpen(true)}>PDF reference</button>
          <button type="button" className="build-button manufacturing-button" disabled={!project} onClick={() => setManufacturingDialogOpen(true)}>Rule checks · Manufacturing</button>
          {source.includes('ImportedBoard') && projectFiles.some((file) => /^imports\/[^/]+\.json$/i.test(file)) && <button type="button" className="build-button" disabled={!project || dirty} onClick={() => void createPcbDraft()}>Refresh component names</button>}
          <button type="button" className="build-button" disabled={!project || build.status === 'compiling'} onClick={runBuild}><span>▶</span> Build</button>
        </div>
      </header>

      <div className="workspace">
        <aside className="explorer">
          <div className="sidebar-title"><span>PROJECTS</span><button type="button" className="icon-button" aria-label="New project" title="New project" onClick={() => setCreating(true)}>＋</button></div>
          {creating && <form className="create-form" onSubmit={handleCreate}>
            <label htmlFor="project-name">Project name</label>
            <input id="project-name" ref={(node) => node?.focus()} value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="e.g. Sensor board" />
            <label htmlFor="project-template">Start from</label>
            <select id="project-template" value={projectTemplate} disabled={schematicFiles.length > 0 || !!referencePdf || !!referencePdfUrl.trim()} onChange={(event) => setProjectTemplate(event.target.value)}>
              {projectTemplates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
            </select>
            <label htmlFor="schematic-files">Import schematics (KiCad or EasyEDA)</label>
            <input id="schematic-files" type="file" accept=".kicad_sch,.json,application/json" multiple onChange={(event) => { setSchematicFiles(Array.from(event.target.files ?? [])); setReferencePdf(null); setReferencePdfUrl('') }} />
            <small className="template-description">Supports modern KiCad .kicad_sch and EasyEDA Standard schematic .json files. EasyEDA import requires KiCad 10 on the server. Imported designs are converted to editable tscircuit source; review converter notes and verify the resulting build.</small>
            <label htmlFor="schematic-pdf">Import PDF as a visual reference</label>
            <input id="schematic-pdf" type="file" accept="application/pdf,.pdf" onChange={(event) => { setReferencePdf(event.target.files?.[0] ?? null); setReferencePdfUrl(''); setSchematicFiles([]) }} />
            <label htmlFor="schematic-pdf-url">Or import from a public PDF URL</label>
            <input id="schematic-pdf-url" type="url" value={referencePdfUrl} placeholder="https://…/schematic.pdf" onChange={(event) => { setReferencePdfUrl(event.target.value); setReferencePdf(null); setSchematicFiles([]) }} />
            <small className="template-description">PDF pages are retained for viewing. Components, pins, and electrical connectivity are not reconstructed. Maximum file size: 20 MB.</small>
            {!schematicFiles.length && !referencePdf && !referencePdfUrl.trim() && projectTemplates.find((template) => template.id === projectTemplate) && <small className="template-description">{projectTemplates.find((template) => template.id === projectTemplate)?.description}</small>}
            <div className="form-actions"><button type="button" className="quiet-button" onClick={() => setCreating(false)}>Cancel</button><button className="small-primary" type="submit">{referencePdf || referencePdfUrl.trim() ? 'Import PDF reference' : schematicFiles.length ? 'Import schematics' : 'Create project'}</button></div>
          </form>}
          <button type="button" className="new-project-link" onClick={() => setCreating(true)}><span>＋</span> New project</button>
          <form className="archive-form" onSubmit={handleArchiveImport}>
            <label htmlFor="project-archive">Import project archive (.zip)</label>
            <input id="project-archive" type="file" accept=".zip,application/zip" onChange={(event) => setArchiveFile(event.target.files?.[0] ?? null)} />
            <button className="quiet-button" type="submit" disabled={!archiveFile || importingArchive}>{importingArchive ? 'Importing…' : 'Import archive'}</button>
            <small>Imports as a separate project. Your open project stays intact; unsaved edits are protected by the normal save/discard prompt.</small>
          </form>
          <ul className="project-list" aria-label="Project list">
            {loading ? <div className="sidebar-empty">Loading projects…</div> : projects.length === 0 ? <div className="sidebar-empty">Your projects will appear here.</div> : projects.map((item) => (
              <li key={item.id} className="project-row">
                <button type="button" className={`project-item ${project?.id === item.id ? 'selected' : ''}`} aria-label={`${item.name} ${item.updatedAt ? new Date(item.updatedAt).toLocaleDateString() : 'TSX project'}`} onClick={() => void openProject(item)}>
                  <span className="project-icon">▱</span><span className="project-item-copy"><strong>{item.name}</strong><small>{item.updatedAt ? new Date(item.updatedAt).toLocaleDateString() : 'TSX project'}</small></span>
                </button>
                <button type="button" className="project-action" aria-label={`Duplicate ${item.name}`} title="Duplicate project" disabled={duplicatingProjectId === item.id} onClick={() => void duplicateExistingProject(item)}>{duplicatingProjectId === item.id ? '…' : '⧉'}</button>
              </li>
            ))}
          </ul>
          {project && <nav className="file-browser" aria-label="Project files">
            <div className="file-browser-title">FILES</div>
            {projectFiles.map((path) => <button type="button" key={path} className={`file-item ${filePath === path ? 'selected' : ''}`} aria-current={filePath === path ? 'page' : undefined} onClick={() => openFile(path)}>{path}{dirty && filePath === path && <span className="unsaved-dot" title="Unsaved changes" />}</button>)}
          </nav>}
          <div className="sidebar-footer"><span className="connection-dot" /> Local workspace</div>
        </aside>

        <section className="editor-panel" aria-label="Source editor panel">
          {review?.locked && <p className="approved-banner" role="status">This revision is approved for manufacturing and is read-only. Reopen it as a draft to edit.</p>}
          <div className="panel-toolbar editor-toolbar">
            <div className="file-tab"><span className="tsx-icon">TS</span>{filePath || 'No file open'}{dirty && <span className="unsaved-dot" title="Unsaved changes" />}</div>
            <div className="save-indicator">{saving ? 'Saving…' : dirty ? 'Unsaved' : revision ? 'Saved' : ''}</div>
          </div>
          {project ? <Editor
            height="100%"
            language={editorLanguage(filePath)}
            beforeMount={configureMonaco}
            path={filePath}
            theme="vs-dark"
            value={source}
            onChange={(value) => { setSource(value ?? ''); setDirty(true) }}
            options={{ fontSize: 13, minimap: { enabled: false }, scrollBeyondLastLine: false, tabSize: 2, wordWrap: 'on', padding: { top: 14 }, readOnly: review?.locked ?? false }}
          /> : <div className="empty-editor"><span className="empty-glyph">{'</>'}</span><h2>Your circuit starts here</h2><p>Create or open a project to edit its tscircuit source.</p><button type="button" className="small-primary" onClick={() => setCreating(true)}>Create project</button></div>}
        </section>

        <section className="preview-panel" aria-label="Design previews">
          <div className="preview-toolbar">
            <button type="button" className={`outline-button multiview-toggle ${showAllViews ? 'active' : ''}`} aria-pressed={showAllViews} onClick={() => setShowAllViews((show) => !show)}>{showAllViews ? 'Single view' : 'Show all views'}</button>
            <div className="view-tabs" role="tablist" aria-label="Preview type">
              {views.map(({ kind, label }) => <button type="button" key={kind} role="tab" aria-selected={view === kind} className={`view-tab ${view === kind ? 'active' : ''}`} onClick={() => setView(kind)}>{label}</button>)}
            </div>
            <span className="preview-meta">{preview ? `Revision ${build.revision || revision}` : 'Live preview'}</span>
            {view === 'pcb' && project && <button type="button" className="outline-button" onClick={openBoardOutlineEditor}>Board outline</button>}
            {view !== 'simulation' && inspectedComponents.length > 0 && <button type="button" className={`inspector-toggle ${componentInspectorOpen ? 'active' : ''}`} aria-expanded={componentInspectorOpen} aria-controls="component-inspector" onClick={() => setComponentInspectorOpen((open) => !open)}>Components <span>{inspectedComponents.length}</span></button>}
            {tracedNets.length > 0 && <button type="button" className={`inspector-toggle ${netInspectorOpen ? 'active' : ''}`} aria-expanded={netInspectorOpen} aria-controls="net-inspector" onClick={() => setNetInspectorOpen((open) => !open)}>Nets <span>{tracedNets.length}</span></button>}
          </div>
          <div className="preview-content">
            {showAllViews ? <div className="multiview-grid" style={{ gridTemplateColumns: `minmax(0, ${panelWidths[0]}fr) 10px minmax(0, ${panelWidths[1]}fr) 10px minmax(0, ${panelWidths[2]}fr)` }}>
              {renderPreviewCard('schematic')}
              <Divider index={0} widths={panelWidths} drag={panelDrag} resizePanel={resizePanel} />
              {renderPreviewCard('pcb')}
              <Divider index={1} widths={panelWidths} drag={panelDrag} resizePanel={resizePanel} />
              {renderPreviewCard('3d')}
            </div> : <>
            {build.status === 'failed' && view !== 'simulation' && <div className="build-errors" role="alert"><div className="error-title"><span>!</span> Build failed</div>{build.diagnostics?.length ? build.diagnostics.map((diagnostic, index) => { const path = diagnostic.path || diagnostic.file; return <div className="diagnostic" key={`${path}-${diagnostic.line}-${index}`}><strong>{path}{diagnostic.line ? `:${diagnostic.line}` : ''}</strong><span>{diagnostic.message}</span></div> }) : <p>Check the source and build output for details.</p>}</div>}
            {view === 'simulation' ? <SimulationPanel simulation={simulation} power={power} build={build} canRun={Boolean(project)} onRun={() => { setSimulation(null); void runBuild() }} /> : preview && (view === 'schematic' || hasPcbPreview) ? view === 'pcb' ? <Suspense fallback={<div className="preview-loading">Loading PCB preview…</div>}><PcbPreview circuitJson={preview as PcbCircuitJson} selectedSourceComponentId={selectedComponentId} onViewSchematicComponent={(event) => { setSelectedComponentId(event.source_component_id); setComponentInspectorOpen(true); setView('schematic') }} /></Suspense> : <Suspense fallback={<div className="preview-loading">Loading tscircuit preview…</div>}><CircuitJsonPreview className="circuit-preview" key={`${view}-${build.revision || revision}`} circuitJson={preview} defaultActiveTab={view === '3d' ? 'cad' : view} showCodeTab={false} showImportAndFormatButtons={false} /></Suspense> : preview ? <div className="preview-placeholder">
              <div className="placeholder-board"><span className="board-edge edge-a" /><span className="board-edge edge-b" /><span className="board-chip chip-a" /><span className="board-chip chip-b" /><span className="board-pad pad-a" /><span className="board-pad pad-b" /><span className="board-route route-a" /><span className="board-route route-b" /></div>
              <h2>{view === 'pcb' ? 'No PCB layout in this project' : 'No PCB data for 3D preview'}</h2>
              <p>This schematic has no PCB placements. Generate a draft layout, then review footprints, component models, pin mappings, and routing before fabrication.</p>
              {view === 'pcb' && source.includes('ImportedSchematic') && <button type="button" className="outline-button" disabled={!project || dirty || build.status === 'compiling'} onClick={() => void createPcbDraft()}>Generate PCB draft</button>}
            </div> : <div className="preview-placeholder">
              <div className="placeholder-board"><span className="board-edge edge-a" /><span className="board-edge edge-b" /><span className="board-chip chip-a" /><span className="board-chip chip-b" /><span className="board-pad pad-a" /><span className="board-pad pad-b" /><span className="board-route route-a" /><span className="board-route route-b" /></div>
              <h2>{project ? build.status === 'failed' ? 'Last good preview is unavailable' : 'Waiting for first build' : 'Your design workspace'}</h2>
              <p>{project ? build.status === 'failed' ? 'Fix the source and build again to update this view.' : 'Build the project to generate a schematic, PCB layout, and 3D preview.' : 'Create a project to see your design take shape.'}</p>
              {project && <button type="button" className="outline-button" onClick={runBuild}>Build project</button>}
            </div>}
            </>}
            {componentInspectorOpen && view !== 'simulation' && <aside id="component-inspector" className="component-inspector" aria-label="Component inspector">
              <header><div><h2>Components</h2><span>{inspectedComponents.length} from build data</span></div><button type="button" aria-label="Close component inspector" onClick={() => setComponentInspectorOpen(false)}>×</button></header>
              {!selectedComponent ? <p className="inspector-empty">No source components were found in this build.</p> : <>
                <label className="inspector-select">Component<select aria-label="Select component" value={selectedComponent.id} onChange={(event) => setSelectedComponentId(event.target.value)}>{inspectedComponents.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}</select></label>
                <div className="inspector-section"><h3>Identity</h3><dl><dt>Name</dt><dd>{selectedComponent.name}</dd><dt>Source ID</dt><dd><code>{selectedComponent.id}</code></dd></dl></div>
                <div className="inspector-section"><h3>Properties</h3>{selectedComponent.properties.length ? <dl>{selectedComponent.properties.map(([key, value]) => <Fragment key={key}><dt>{key}</dt><dd>{formatInspectorValue(value)}</dd></Fragment>)}</dl> : <p>No additional source properties.</p>}</div>
                <div className="inspector-section"><h3>PCB placement</h3>{selectedComponent.placement ? <dl>{(['center', 'rotation', 'layer', 'width', 'height'] as const).filter((key) => selectedComponent.placement?.[key] !== undefined).map((key) => <Fragment key={key}><dt>{key}</dt><dd>{formatInspectorValue(selectedComponent.placement?.[key])}</dd></Fragment>)}</dl> : <p>No PCB placement in this build.</p>}</div>
                <div className="inspector-section"><h3>Pins and nets</h3>{selectedComponent.pins.length ? selectedComponent.pins.map((pin) => <div className="inspector-pin" key={pin.id || pin.name}><strong>{pin.name}</strong><code>{pin.id || 'No source port ID'}</code><span>{pin.connections.length ? pin.connections.join(', ') : 'No source trace connection found'}</span>{pin.id && tracedNets.some((net) => net.pins.some((item) => item.sourcePortId === pin.id)) && <button type="button" className="quiet-button pin-trace-button" onClick={() => traceNetForPort(pin.id)}>Trace net</button>}</div>) : <p>No source ports were found for this component.</p>}</div>
                <div className="inspector-section"><h3>Supplier</h3>{!selectedComponentLcscPart ? <p>Circuit JSON records no LCSC part number for this component.</p>
                  : !componentSourcing ? <p>Looking up {selectedComponentLcscPart}…</p>
                    : componentSourcing.configured === false ? <p>No component sourcing provider is configured, so stock and price were not looked up.</p>
                      : componentSourcing.error ? <p>{componentSourcing.error}</p>
                        : componentSourcing.part ? <dl>
                          <dt>LCSC</dt><dd>{componentSourcing.part.lcscPartNumber}</dd>
                          {componentSourcing.part.manufacturerPartNumber && <><dt>MPN</dt><dd>{componentSourcing.part.manufacturerPartNumber}</dd></>}
                          {componentSourcing.part.package && <><dt>Package</dt><dd>{componentSourcing.part.package}</dd></>}
                          {componentSourcing.part.stockQuantity !== undefined && <><dt>Stock</dt><dd>{componentSourcing.part.stockQuantity.toLocaleString()}</dd></>}
                          {componentSourcing.part.unitPriceUsd !== undefined && <><dt>Unit price</dt><dd>${componentSourcing.part.unitPriceUsd}</dd></>}
                          {componentSourcing.part.isBasicPart !== undefined && <><dt>Assembly</dt><dd>{componentSourcing.part.isBasicPart ? 'Basic part' : 'Extended part'}</dd></>}
                        </dl> : <p>The supplier index returned no part for {selectedComponentLcscPart}.</p>}</div>
                <p className="inspector-note">Details reflect the latest successful build. Selecting a component focuses its PCB footprint; use that footprint’s context menu to open it here from the PCB. <strong>Trace net</strong> opens the net inspector for that pin. Schematic and 3D canvas highlighting are not available yet.</p>
              </>}
            </aside>}
            {netInspectorOpen && <NetInspector nets={tracedNets} index={netIndex} selected={selectedNet} onSelect={setSelectedNetId} onFocusPin={focusNetPin} onViewSignals={() => { setShowAllViews(false); setView('simulation') }} onClose={() => setNetInspectorOpen(false)} />}
          </div>
          {build.status === 'failed' && !preview && build.diagnostics?.length ? null : build.status !== 'failed' && build.status !== 'ready' && <div className="preview-footer"><span className="pulse-dot" />Previews update when source changes</div>}
        </section>
      </div>
      {unsavedDialogOpen && <div className="history-overlay" role="presentation"><section className="history-dialog unsaved-dialog" role="dialog" aria-modal="true" aria-labelledby="unsaved-title">
        <header><div><h2 id="unsaved-title">Unsaved changes</h2><p>Save your edits before opening another project file?</p></div></header>
        <footer><button type="button" className="quiet-button" onClick={() => void finishNavigation('cancel')}>Cancel</button><button type="button" className="quiet-button" onClick={() => void finishNavigation('discard')}>Discard and open</button><button type="button" className="build-button" onClick={() => void finishNavigation('save')}>Save and open</button></footer>
      </section></div>}
      {historyDialogOpen && <div className="history-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setHistoryDialogOpen(false) }}>
        <section className="history-dialog" role="dialog" aria-modal="true" aria-labelledby="history-title">
          <header><div><h2 id="history-title">Project source history</h2><p>{historyRevisions.length} revision{historyRevisions.length === 1 ? '' : 's'} · {historyGitBacked ? 'kept in this project\u2019s Git repository' : 'local snapshots only, newest 50 retained'}</p></div><button type="button" aria-label="Close project history" onClick={() => setHistoryDialogOpen(false)}>×</button></header>
          {historyLoading ? <p className="history-empty">Loading revisions…</p> : historyRevisions.length === 0 ? <p className="history-empty">No saved revisions yet.</p> : <div className="history-layout">
            <ul className="history-revision-list" aria-label="Saved revisions">{historyRevisions.map((item) => <li key={item.revision}><button type="button" className={`history-revision ${revisionToRestore === item.revision ? 'selected' : ''}`} onClick={() => setRevisionToRestore(item.revision)}>
              <strong>{new Date(item.createdAt).toLocaleString()}</strong><small>{item.changedFiles.join(', ') || 'No changed files'}{item.sizeBytes === undefined ? '' : ` · ${formatBytes(item.sizeBytes)}`}</small><code>{item.commit ? item.commit.slice(0, 8) : item.revision.slice(0, 8)}</code>
            </button></li>)}</ul>
            <div className="history-compare">
              <div className="history-selects"><label>Compare from<select aria-label="Compare from" value={historyFrom} onChange={(event) => setHistoryFrom(event.target.value)}>{historyRevisions.map((item) => <option key={item.revision} value={item.revision}>{new Date(item.createdAt).toLocaleString()}</option>)}</select></label><label>Compare with<select aria-label="Compare with" value={historyTo} onChange={(event) => setHistoryTo(event.target.value)}>{historyRevisions.map((item) => <option key={item.revision} value={item.revision}>{new Date(item.createdAt).toLocaleString()}</option>)}</select></label></div>
              {revisionComparison ? <DesignDiffSummary design={revisionComparison.design} /> : null}
              {revisionComparison?.files.length ? revisionComparison.files.map((file) => <section className="history-file-diff" key={file.path}><h3>{file.path}</h3><div><section aria-label={`${file.path} before`}><pre>{file.before ?? '— file did not exist —'}</pre></section><section aria-label={`${file.path} after`}><pre>{file.after ?? '— file did not exist —'}</pre></section></div></section>) : <p className="history-empty">{historyFrom === historyTo ? 'Choose two different revisions to compare.' : 'These revisions contain no source changes.'}</p>}
            </div>
          </div>}
          <footer><span>Restore replaces the project files and queues a normal build.</span><button type="button" className="build-button" disabled={!revisionToRestore || revisionToRestore === revision || dirty || restoringHistory || historyLoading} onClick={() => void restoreRevision()}>{restoringHistory ? 'Restoring…' : 'Restore selected revision'}</button></footer>
        </section>
      </div>}
      {reviewDialogOpen && review && <div className="history-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setReviewDialogOpen(false) }}>
        <section className="history-dialog review-dialog" role="dialog" aria-modal="true" aria-labelledby="review-title">
          <header><div><h2 id="review-title">Design review</h2><p>{reviewStateLabels[review.state]} · revision {review.revision.slice(0, 8)}{review.locked ? ' · read-only' : ''}</p></div><button type="button" aria-label="Close design review" onClick={() => setReviewDialogOpen(false)}>×</button></header>
          <div className="review-content">
            {review.supersededFrom && <p className="review-superseded">This revision is a draft; revision {review.supersededFrom.revision.slice(0, 8)} had reached {reviewStateLabels[review.supersededFrom.state]} before the source changed.</p>}
            <dl className="review-evidence">
              <dt>Build</dt><dd>{review.evidence.buildStatus ?? 'none'}{review.evidence.buildRevision === review.evidence.projectRevision ? ' (current revision)' : ' (not the current revision)'}</dd>
              <dt>Assertions</dt><dd>{review.evidence.assertionsConfigured ? `${review.evidence.assertions?.passed ?? 0} passed · ${review.evidence.assertions?.failed ?? 0} failed · ${review.evidence.assertions?.notEvaluated ?? 0} not evaluated` : 'no assertions.json document'}</dd>
              <dt>Preflight</dt><dd>{review.evidence.preflightReady === undefined ? 'unavailable' : review.evidence.preflightReady ? 'ready' : 'blocked'}</dd>
            </dl>
            <label className="review-note">Note<textarea aria-label="Review note" maxLength={2000} value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} placeholder="What was checked, and what is still unverified" /></label>
            <div className="review-actions">
              {review.transitions.map((transition) => <button type="button" key={transition.state} className={transition.state === 'draft' ? 'quiet-button' : 'build-button'}
                disabled={!transition.allowed || recordingReview || dirty}
                title={transition.allowed ? (dirty ? 'Save or discard editor changes first' : undefined) : transition.reason}
                onClick={() => void recordReviewState(transition.state)}>
                {transition.state === 'draft' ? 'Reopen as draft' : `Mark ${reviewStateLabels[transition.state].toLowerCase()}`}
              </button>)}
            </div>
            {dirty && <p className="review-blocked">Save or discard the editor changes before recording a review state.</p>}
            {review.transitions.filter(({ allowed, reason }) => !allowed && reason).map(({ state, reason }) => <p className="review-blocked" key={state}>{reason}</p>)}
            <h3>History</h3>
            {review.history.length === 0 ? <p className="review-blocked">No review states have been recorded yet.</p> : <ul className="review-history">
              {review.history.map((entry) => <li key={`${entry.at}-${entry.state}`}>
                <strong>{reviewStateLabels[entry.state]}</strong>
                <span>{new Date(entry.at).toLocaleString()} · revision {entry.revision.slice(0, 8)} · by {entry.source === 'mcp' ? 'an MCP agent' : 'the workbench'}</span>
                {entry.note && <em>{entry.note}</em>}
              </li>)}
            </ul>}
            <p className="inspector-note">A review state applies only to the revision it was recorded against: editing the source returns the project to draft. While a revision is approved for manufacturing, file writes and restores are refused. Approving a revision, and reopening an approved one, are not available to MCP agents. Recording a state does not verify the design.</p>
          </div>
        </section>
      </div>}
      {referencePdfOpen && project?.referencePdfs?.[0] && <div className="history-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setReferencePdfOpen(false) }}>
        <section className="history-dialog pdf-reference-dialog" role="dialog" aria-modal="true" aria-labelledby="pdf-reference-title">
          <header><div><h2 id="pdf-reference-title">{project.referencePdfs[0].name}</h2><p>Visual reference only. Electrical connectivity was not imported from this PDF.</p></div><button type="button" aria-label="Close PDF reference" onClick={() => setReferencePdfOpen(false)}>×</button></header>
          <iframe title={`PDF reference: ${project.referencePdfs[0].name}`} src={getProjectReferencePdfUrl(project.id, project.referencePdfs[0].id)} />
        </section>
      </div>}
      {manufacturingDialogOpen && <div className="manufacturing-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setManufacturingDialogOpen(false) }}>
        <section className="manufacturing-dialog" role="dialog" aria-modal="true" aria-labelledby="manufacturing-title">
          <header><div><h2 id="manufacturing-title">Manufacturing preflight</h2><p>Review electrical and fabricator checks before generating files.</p></div><button type="button" aria-label="Close manufacturing checks" onClick={() => setManufacturingDialogOpen(false)}>×</button></header>
          <label className="profile-select">Fabricator rule profile<select aria-label="Fabricator rule profile" value={manufacturingProfile} onChange={(event) => setManufacturingProfile(event.target.value)}>{manufacturingProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}</select></label>
          {manufacturingProfiles.find(({ id }) => id === manufacturingProfile)?.description && <p className="profile-description">{manufacturingProfiles.find(({ id }) => id === manufacturingProfile)?.description}</p>}
          <div className="manufacturing-checks" aria-live="polite">{loadingManufacturing ? <p className="checks-empty">Checking current build…</p> : manufacturingPreflight ? manufacturingPreflight.checks.map((check) => <ManufacturingCheckRow key={check.id} check={check} />) : <p className="checks-empty">Build the project to load manufacturing checks.</p>}</div>
          <section className="assertion-results" aria-label="Project assertions">
            <h3>Project assertions</h3>
            {!assertionCheck ? <p className="checks-empty">Loading project assertions…</p>
              : !assertionCheck.configured ? <p className="checks-empty">{assertionCheck.message}</p>
                : <>
                  <p className="assertion-summary">{assertionCheck.report?.passed ?? 0} passed · {assertionCheck.report?.failed ?? 0} failed · {assertionCheck.report?.notEvaluated ?? 0} not evaluated{assertionCheck.report?.baselineRevision ? ` · baseline ${assertionCheck.report.baselineRevision.slice(0, 8)}` : ''}</p>
                  {assertionCheck.report?.results.map((result) => <p className={`assertion-result ${result.status}`} key={result.id}>
                    <strong>{result.status === 'pass' ? 'Pass' : result.status === 'fail' ? 'Fail' : 'Not evaluated'}</strong> {result.message}
                  </p>)}
                </>}
          </section>
          <section className="bom-cost" aria-label="Component cost estimate">
            <div className="bom-cost-heading"><h3>Component cost</h3><label>Boards<input type="number" min="1" max="10000" aria-label="Board quantity" value={boardQuantity} onChange={(event) => setBoardQuantity(Math.max(1, Math.min(10000, Math.round(Number(event.target.value) || 1))))} /></label></div>
            {!bomCost ? <p className="checks-empty">Loading component prices…</p>
              : bomCost.configured === false ? <p className="checks-empty">{bomCost.message}</p>
                : <>
                  <p className="bom-total">{bomCost.componentCostUsd === undefined ? 'No part could be priced.' : `$${bomCost.componentCostUsd} for ${bomCost.boards} board${bomCost.boards === 1 ? '' : 's'} · ${bomCost.lines?.length ?? 0} priced line${bomCost.lines?.length === 1 ? '' : 's'}`}</p>
                  {bomCost.lines?.length ? <dl className="bom-lines">{bomCost.lines.map((line) => <Fragment key={line.name}><dt>{line.name} ×{line.quantity}</dt><dd>{line.extendedPriceUsd === undefined ? 'no price' : `$${line.extendedPriceUsd}`}{line.stockQuantity !== undefined ? ` · ${line.stockQuantity.toLocaleString()} in stock` : ''}</dd></Fragment>)}</dl> : null}
                  {bomCost.unpriced?.length ? <div className="bom-unpriced"><h4>Unpriced</h4><dl>{bomCost.unpriced.map((item) => <Fragment key={item.name}><dt>{item.name}</dt><dd>{item.reason}</dd></Fragment>)}</dl></div> : null}
                  {bomCost.limitations?.length ? <p className="inspector-note">{bomCost.limitations.join(' ')}</p> : null}
                </>}
          </section>
          <footer><span>{manufacturingPreflight?.ready ? 'Preflight ready' : manufacturingPreflight ? 'Resolve blocking checks before export' : 'Preflight unavailable'}</span><button type="button" className="build-button" disabled={!project || dirty || build.status !== 'ready' || build.revision !== revision || exportingManufacturing || loadingManufacturing || !manufacturingPreflight?.ready} onClick={downloadManufacturing}>{exportingManufacturing ? 'Exporting…' : 'Download Manufacturing ZIP'}</button></footer>
        </section>
      </div>}
      {boardOutlineOpen && <BoardOutlineDialog points={boardOutlinePoints} error={boardOutlineError} onChange={setBoardOutlinePoints} onImport={(file) => void importBoardOutlineSvg(file)} onError={setBoardOutlineError} onApply={applyEditedBoardOutline} onClose={() => setBoardOutlineOpen(false)} />}
      {error && <div className="toast-error" role="alert"><span>{error}</span>{error.includes('changed on disk') || error.includes('changed outside') ? <button type="button" className="reload-button" onClick={reloadFile}>Reload file</button> : null}<button type="button" aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
    </main>
  )
}

function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Unable to read SVG file text.'))
    reader.onerror = () => reject(new Error('Unable to read SVG file.'))
    reader.readAsText(file)
  })
}

function BoardOutlineDialog({ points, error, onChange, onImport, onError, onApply, onClose }: {
  points: BoardOutlinePoint[]
  error: string
  onChange: (points: BoardOutlinePoint[]) => void
  onImport: (file: File) => void
  onError: (error: string) => void
  onApply: () => void
  onClose: () => void
}) {
  const canvasPoints = points.map(({ x, y }) => `${200 + x * 5},${150 - y * 5}`).join(' ')
  const addPoint = (event: MouseEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    const x = bounds.width ? (event.clientX - bounds.left) * (400 / bounds.width) : event.clientX
    const y = bounds.height ? (event.clientY - bounds.top) * (300 / bounds.height) : event.clientY
    onChange([...points, { x: Math.round((x - 200) / 5 * 10) / 10, y: Math.round((150 - y) / 5 * 10) / 10 }])
    onError('')
  }

  return <div className="history-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="history-dialog board-outline-dialog" role="dialog" aria-modal="true" aria-labelledby="board-outline-title">
      <header><div><h2 id="board-outline-title">Board outline</h2><p>Click to place points on the canvas, edit coordinates, or import an SVG polygon.</p></div><button type="button" aria-label="Close board outline editor" onClick={onClose}>×</button></header>
      <div className="board-outline-content">
        <label className="outline-upload">Import outline SVG<input aria-label="Import outline SVG" type="file" accept=".svg,image/svg+xml" onChange={(event) => { const file = event.target.files?.[0]; if (file) onImport(file); event.currentTarget.value = '' }} /></label>
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: the Add point button below places points without the canvas, so a keyboard path exists */}
        <svg className="outline-canvas" viewBox="0 0 400 300" role="application" aria-label="Draw board outline" onClick={addPoint}>
          <path d="M200 0V300M0 150H400" className="outline-axis" />
          {points.length >= 2 && <polyline points={points.length >= 3 ? `${canvasPoints} ${canvasPoints.split(' ')[0]}` : canvasPoints} className="outline-polygon" />}
          {points.map(({ x, y }, index) => <g key={`${index}-${x}-${y}`}><circle cx={200 + x * 5} cy={150 - y * 5} r="4" className="outline-point" /><text x={204 + x * 5} y={146 - y * 5}>{index + 1}</text></g>)}
        </svg>
        <ul className="outline-point-list" aria-label="Outline points">
          {points.map((point, index) => <li className="outline-point-row" key={`${index}-${point.x}-${point.y}`}>
            <strong>{index + 1}</strong>
            <label>X (mm)<input aria-label={`Outline point ${index + 1} x`} type="number" step="0.1" value={point.x} onChange={(event) => onChange(points.map((item, pointIndex) => pointIndex === index ? { ...item, x: Number(event.target.value) } : item))} /></label>
            <label>Y (mm)<input aria-label={`Outline point ${index + 1} y`} type="number" step="0.1" value={point.y} onChange={(event) => onChange(points.map((item, pointIndex) => pointIndex === index ? { ...item, y: Number(event.target.value) } : item))} /></label>
            <button type="button" className="quiet-button" aria-label={`Remove point ${index + 1}`} onClick={() => { onChange(points.filter((_, pointIndex) => pointIndex !== index)); onError('') }}>Remove</button>
          </li>)}
        </ul>
        <button type="button" className="outline-button" onClick={() => { const last = points.at(-1); onChange([...points, last ? { x: last.x + 5, y: last.y } : { x: 0, y: 0 }]); onError('') }}>Add point</button>
        {error && <p className="outline-error" role="alert">{error}</p>}
      </div>
      <footer><span>{points.length} points · millimeters</span><div><button type="button" className="quiet-button" onClick={onClose}>Cancel</button><button type="button" className="build-button" onClick={onApply}>Apply outline</button></div></footer>
    </section>
  </div>
}

function DesignDiffSummary({ design }: { design: DesignDiff }) {
  if (!design.available) return <section className="design-diff" aria-label="Design changes"><h3>Design changes</h3><p>{design.reason}</p></section>
  const unchanged = design.board.length === 0 && design.counts.length === 0 && design.simulation.length === 0
    && design.components.added.length === 0 && design.components.removed.length === 0 && design.components.changed.length === 0
    && design.nets.added.length === 0 && design.nets.removed.length === 0 && design.nets.changed.length === 0
  return <section className="design-diff" aria-label="Design changes">
    <h3>Design changes</h3>
    {unchanged ? <p>Both builds produced the same board, components, nets, and routing counts.</p> : <>
      {design.board.length > 0 && <dl>{design.board.map((item) => <Fragment key={item.property}><dt>{item.property}</dt><dd>{item.before ?? '—'} → {item.after ?? '—'}</dd></Fragment>)}</dl>}
      {design.components.added.length > 0 && <p className="design-added">Added: {design.components.added.map(({ name, value }) => value ? `${name} (${value})` : name).join(', ')}</p>}
      {design.components.removed.length > 0 && <p className="design-removed">Removed: {design.components.removed.map(({ name }) => name).join(', ')}</p>}
      {design.components.changed.length > 0 && <dl>{design.components.changed.map((item) => <Fragment key={item.name}><dt>{item.name}</dt><dd>{item.changes.map((change) => `${change.property}: ${change.before ?? '—'} → ${change.after ?? '—'}`).join(', ')}</dd></Fragment>)}</dl>}
      {design.nets.added.length > 0 && <p className="design-added">Nets added: {design.nets.added.map(({ name }) => name).join(', ')}</p>}
      {design.nets.removed.length > 0 && <p className="design-removed">Nets removed: {design.nets.removed.map(({ name }) => name).join(', ')}</p>}
      {design.nets.changed.length > 0 && <dl>{design.nets.changed.map((item) => <Fragment key={item.name}><dt>Net {item.name}</dt><dd>{item.changes.map((change) => `${change.property}: ${change.before} → ${change.after}`).join(', ')}</dd></Fragment>)}</dl>}
      {design.counts.length > 0 && <dl>{design.counts.map((item) => <Fragment key={item.metric}><dt>{item.metric}</dt><dd>{item.before} → {item.after}</dd></Fragment>)}</dl>}
      {design.simulation.length > 0 && <dl>{design.simulation.map((item) => <Fragment key={item.property}><dt>simulation {item.property}</dt><dd>{item.before} → {item.after}</dd></Fragment>)}</dl>}
    </>}
    <p className="inspector-note">{design.limitations.join(' ')}</p>
  </section>
}

function ManufacturingCheckRow({ check }: { check: ManufacturingCheck }) {
  const label = check.status === 'pass' ? 'Pass' : check.status === 'fail' ? 'Blocked' : check.status === 'not-evaluated' ? 'Not evaluated' : 'Review'
  const className = check.status === 'not-evaluated' ? 'warning' : check.status
  return <div className={`manufacturing-check ${className}`}><span className="check-status">{label}</span><div><span>{check.message}</span>{check.issues?.map((issue, index) => <p className={`check-issue ${issue.severity}`} key={`${issue.type}-${index}`}><strong>{issue.category}</strong> · {issue.message}{issue.affectedIds.length > 0 ? <small> ({issue.affectedIds.join(', ')})</small> : null}</p>)}</div></div>
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

function formatInspectorValue(value: unknown) {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

const reviewStateLabels: Record<ReviewStateName, string> = {
  draft: 'Draft',
  validated: 'Validated',
  reviewed: 'Reviewed',
  manufacturing_approved: 'Manufacturing approved',
}

const routingLabels: Record<TracedNet['routing'], string> = {
  routed: 'Routed',
  'partially-routed': 'Partially routed',
  unrouted: 'Unrouted',
  'not-applicable': 'No routing required',
}

function NetInspector({ nets, index, selected, onSelect, onFocusPin, onViewSignals, onClose }: {
  nets: TracedNet[]
  index: NetTraceIndex | null
  selected?: TracedNet
  onSelect: (netId: string) => void
  onFocusPin: (sourceComponentId?: string) => void
  onViewSignals: () => void
  onClose: () => void
}) {
  return <aside id="net-inspector" className="component-inspector net-inspector" aria-label="Net inspector">
    <header><div><h2>Nets</h2><span>{nets.length} from build data</span></div><button type="button" aria-label="Close net inspector" onClick={onClose}>×</button></header>
    {!selected ? <p className="inspector-empty">No connected nets were found in this build.</p> : <>
      <label className="inspector-select">Net<select aria-label="Select net" value={selected.id} onChange={(event) => onSelect(event.target.value)}>{nets.map((net) => <option key={net.id} value={net.id}>{net.name}</option>)}</select></label>
      <div className="inspector-section"><h3>Identity</h3><dl>
        <dt>Name</dt><dd>{selected.names.join(', ') || selected.name}</dd>
        <dt>Net ID</dt><dd><code>{selected.id}</code></dd>
        <dt>Routing</dt><dd><span className={`net-routing ${selected.routing}`}>{routingLabels[selected.routing]}</span></dd>
        <dt>Source traces</dt><dd>{selected.sourceTraceIds.length}</dd>
      </dl></div>
      <div className="inspector-section"><h3>Component pins</h3>{selected.pins.length ? selected.pins.map((pin) => <div className="inspector-pin net-pin" key={pin.sourcePortId}>
        <strong>{pin.componentName ?? 'Unnamed component'} · {pin.pinName}</strong>
        <code>{pin.sourcePortId}</code>
        <span>{pin.pcbPortId ? pin.routed ? 'Reached by copper on this net' : 'Placed but not reached by copper' : 'No PCB port in this build'}</span>
        {pin.sourceComponentId && <button type="button" className="quiet-button pin-trace-button" onClick={() => onFocusPin(pin.sourceComponentId)}>Focus footprint</button>}
      </div>) : <p>This net has no source ports.</p>}</div>
      <div className="inspector-section"><h3>Schematic wires</h3>{selected.schematicTraces.length ? <dl>{selected.schematicTraces.map((trace) => <Fragment key={trace.schematicTraceId}><dt><code>{trace.schematicTraceId}</code></dt><dd>{trace.edgeCount} segments</dd></Fragment>)}</dl> : <p>No schematic wires were emitted for this net.</p>}</div>
      <div className="inspector-section"><h3>Copper and vias</h3>{selected.copperTraces.length ? <dl>{selected.copperTraces.map((trace) => <Fragment key={trace.pcbTraceId}><dt><code>{trace.pcbTraceId}</code></dt><dd>{trace.lengthMm} mm · {trace.layers.join(', ') || 'no layer'}{trace.widthMm ? ` · ${trace.widthMm} mm wide` : ''}</dd></Fragment>)}</dl> : <p>No copper traces carry this net in this build.</p>}
        {selected.vias.length ? <p className="net-vias">{selected.vias.length} via{selected.vias.length === 1 ? '' : 's'}: {selected.vias.map((via) => `${via.pcbViaId} (${via.x}, ${via.y}) ${via.fromLayer ?? '?'}→${via.toLayer ?? '?'}`).join('; ')}</p> : null}</div>
      <div className="inspector-section"><h3>Simulation signals</h3>{selected.simulationSignals.length ? <>
        <dl>{selected.simulationSignals.map((signal) => <Fragment key={signal.id}><dt>{signal.name}</dt><dd>{signal.unit}</dd></Fragment>)}</dl>
        <button type="button" className="quiet-button" onClick={onViewSignals}>Open waveforms</button>
      </> : <p>No probe on this net produced a waveform in this build.</p>}
        {index?.uncorrelatedSimulationSignals.length ? <p className="inspector-note">{index.uncorrelatedSimulationSignals.length} simulation signal(s) could not be correlated with a net.</p> : null}</div>
      <p className="inspector-note">Nets come from the build's connectivity map. Pins, wires, copper, and vias are listed by ID; the schematic, PCB, and 3D canvases expose no highlight API, so a selected net is not drawn highlighted. Connectivity tracing is not signal propagation.</p>
    </>}
  </aside>
}

/** Read the first LCSC part number from a component's Circuit JSON supplier part numbers. */
function lcscPartNumberOf(properties?: Array<[string, unknown]>) {
  const suppliers = properties?.find(([key]) => key === 'supplier_part_numbers')?.[1]
  const values = suppliers && typeof suppliers === 'object' ? (suppliers as Record<string, unknown>) : {}
  const candidates = [values.jlcpcb, values.lcsc].flatMap((value) => Array.isArray(value) ? value : [])
  const match = candidates.find((value) => typeof value === 'string' && /^C?\d{2,12}$/i.test(value.trim()))
  return typeof match === 'string' ? match.trim() : undefined
}

/** Present a DC or AC sweep as waveform-viewer signals; AC sweeps split into magnitude and phase. */
function sweepSignals(sweep: SimulationSweep) {
  const xUnit = sweep.kind === 'ac' ? 'Hz' : sweep.xLabel.replace(/^.*\(|\)$/g, '')
  if (sweep.kind !== 'ac') return [{ id: sweep.id, name: sweep.name, unit: sweep.unit, netId: sweep.netId, samples: sweep.samples, xUnit }]
  return [
    { id: `${sweep.id}-magnitude`, name: `${sweep.name} magnitude`, unit: 'dB', netId: sweep.netId, samples: sweep.magnitudeDb ?? sweep.samples, xUnit },
    { id: `${sweep.id}-phase`, name: `${sweep.name} phase`, unit: '°', netId: sweep.netId, samples: sweep.phaseDeg ?? [], xUnit },
  ]
}

function PowerSummary({ power }: { power: PowerAnalysis }) {
  const measured = power.nodeVoltages.length > 0 || power.branchCurrents.length > 0
  return <section className="power-summary" aria-label="Power analysis">
    <div className="simulation-heading"><h2>Power</h2><span>{measured ? 'From the DC operating point in this build' : 'Board geometry only'}</span></div>
    {power.totalSupplyCurrentA !== undefined || power.totalDissipationW !== undefined ? <dl className="power-totals">
      {power.totalSupplyCurrentA !== undefined && <><dt>Supply current</dt><dd>{power.totalSupplyCurrentA} A</dd></>}
      {power.totalDissipationW !== undefined && <><dt>Dissipation</dt><dd>{power.totalDissipationW} W</dd></>}
    </dl> : null}
    {power.nodeVoltages.length > 0 && <div className="power-section"><h3>Node voltages</h3><dl>{power.nodeVoltages.map((node) => <Fragment key={node.name}><dt>{node.name}</dt><dd>{node.voltageV} V{node.netId ? ` · net ${node.netId}` : ''}</dd></Fragment>)}</dl></div>}
    {power.branchCurrents.length > 0 && <div className="power-section"><h3>Branch currents</h3><dl>{power.branchCurrents.map((branch) => <Fragment key={branch.name}><dt>{branch.name}</dt><dd>{branch.currentA} A{branch.componentName ? ` · ${branch.componentName}` : ''}</dd></Fragment>)}</dl></div>}
    {power.componentPower.length > 0 && <div className="power-section"><h3>Component dissipation</h3><dl>{power.componentPower.map((component) => <Fragment key={component.sourceComponentId}><dt>{component.name}</dt><dd>{component.dissipationW} W · {component.method === 'I2R' ? 'I²R' : 'V²/R'}</dd></Fragment>)}</dl></div>}
    {power.traceLoads.length > 0 && <div className="power-section"><h3>Trace loading</h3>{power.traceLoads.map((load) => <p className={`trace-load ${load.status}`} key={`${load.pcbTraceId}-${load.netId}`}>
      <strong>{load.netName ?? load.netId}</strong> {load.currentA} A of {load.maxCurrentA} A ({Math.round(load.utilization * 100)}%){load.status === 'over-capacity' ? ' · over capacity' : ''}
    </p>)}</div>}
    {power.narrowestTrace && <div className="power-section"><h3>Narrowest routed trace</h3><p>{power.narrowestTrace.widthMm} mm on {power.narrowestTrace.layers.join(', ') || 'unknown layer'} carries up to {power.narrowestTrace.maxCurrentA} A.</p></div>}
    <div className="power-section"><h3>Not evaluated</h3><dl>{power.notEvaluated.map((item) => <Fragment key={item.quantity}><dt>{item.quantity}</dt><dd>{item.reason}</dd></Fragment>)}</dl></div>
    <p className="inspector-note">{power.assumptions.join(' ')}</p>
  </section>
}

function SimulationPanel({ simulation, power, build, canRun, onRun }: { simulation: Simulation | null; power: PowerAnalysis | null; build: BuildStatus; canRun: boolean; onRun: () => void }) {
  const building = ['running', 'compiling', 'validating', 'routing', 'rendering'].includes(build.status)
  return <div className="simulation-results">
    <div className="simulation-heading"><div><h2>Simulation</h2><span>Runs tscircuit's configured analog simulation</span></div><button type="button" className="build-button" disabled={!canRun || building} onClick={onRun}>{building ? 'Running simulation…' : 'Run simulation'}</button></div>
    {building ? <p className="simulation-message" aria-live="polite">Building with tscircuit…</p> : build.status === 'failed' ? <div className="simulation-message" role="alert"><strong>Build failed</strong>{build.diagnostics?.length ? build.diagnostics.map((item, index) => <p key={`${item.path ?? item.file}-${item.line}-${index}`}>{item.path || item.file}{item.line ? `:${item.line}` : ''}{item.path || item.file ? ': ' : ''}{item.message}</p>) : <p>Check the project source and build output for details.</p>}</div> : simulation?.status === 'failed' ? <div className="simulation-message" role="alert"><strong>Simulation failed</strong>{simulation.diagnostics.map((item) => <p key={item.message}>{item.message}</p>)}</div> : !simulation ? <p className="simulation-message">Run the current source to inspect its simulation results.</p> : simulation.status === 'not_configured' ? <div className="simulation-message"><strong>No simulation configured</strong><p>Add tscircuit <code>&lt;analogsimulation /&gt;</code> and voltage/current probes to the circuit source.</p></div> : <>
      <div className="simulation-heading"><h2>{simulation.experiments.map((item) => item.name).join(', ') || 'Simulation results'}</h2><span>{simulation.signals.length} waveforms · {simulation.operatingPoints.length} operating-point values · {simulation.sweeps.length} sweeps · build {simulation.revision.slice(0, 8)}</span></div>
      {simulation.operatingPoints.length > 0 && <section className="operating-point" aria-label="DC operating point">
        <h3>DC operating point</h3>
        <dl>{simulation.operatingPoints.map((point) => <Fragment key={point.id}><dt>{point.name}</dt><dd>{point.value} {point.unit}{point.netId ? ` · net ${point.netId}` : ''}</dd></Fragment>)}</dl>
      </section>}
      {simulation.signals.length > 0 && <WaveformViewer key={`${simulation.revision}-transient`} signals={simulation.signals} />}
      {simulation.sweeps.map((sweep) => <section className="sweep" aria-label={`${sweep.name} ${sweep.kind === 'ac' ? 'AC' : 'DC'} sweep`} key={sweep.id}>
        <h3>{sweep.name} · {sweep.kind === 'ac' ? 'AC sweep' : 'DC sweep'} · {sweep.xLabel}</h3>
        <WaveformViewer signals={sweepSignals(sweep)} />
      </section>)}
      {power && <PowerSummary power={power} />}
      {simulation.notEvaluated.length > 0 && <section className="simulation-not-evaluated" aria-label="Analyses not evaluated">
        <h3>Not evaluated</h3>
        <dl>{simulation.notEvaluated.map((item) => <Fragment key={item.analysis}><dt>{item.analysis}</dt><dd>{item.reason}</dd></Fragment>)}</dl>
      </section>}
    </>}
  </div>
}
