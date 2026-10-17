import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import Editor from '@monaco-editor/react'
import {
  createProject,
  getPreview,
  getProject,
  getProjectFile,
  listProjects,
  saveProjectFile,
  startBuild,
  subscribeToProject,
  type BuildStatus,
  type PreviewKind,
  type Project,
  type ProjectEvent,
} from './api'

const views: Array<{ kind: PreviewKind; label: string; tab: 'schematic' | 'pcb' | 'cad' }> = [
  { kind: 'schematic', label: 'Schematic', tab: 'schematic' },
  { kind: 'pcb', label: 'PCB', tab: 'pcb' },
  { kind: '3d', label: '3D', tab: 'cad' },
]

const initialBuild: BuildStatus = { status: 'idle' }
const CircuitJsonPreview = lazy(() => import('@tscircuit/runframe').then((module) => ({ default: module.CircuitJsonPreview })))

export default function App() {
  const [projects, setProjects] = useState<Project[]>([])
  const [project, setProject] = useState<Project | null>(null)
  const [filePath, setFilePath] = useState('')
  const [source, setSource] = useState('')
  const [revision, setRevision] = useState('')
  const [dirty, setDirty] = useState(false)
  const [view, setView] = useState<PreviewKind>('schematic')
  const [preview, setPreview] = useState<unknown>(null)
  const [build, setBuild] = useState<BuildStatus>(initialBuild)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [projectName, setProjectName] = useState('')
  const [saving, setSaving] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sourceRef = useRef(source)
  const revisionRef = useRef(revision)

  useEffect(() => { sourceRef.current = source }, [source])
  useEffect(() => { revisionRef.current = revision }, [revision])

  const refreshPreview = useCallback(async (id: string, kind: PreviewKind) => {
    try {
      const result = await getPreview(id, kind)
      if (kind === view) setPreview(result.circuitJson)
    } catch {
      if (kind === view) setPreview(null)
    }
  }, [view])

  const openProject = useCallback(async (listedProject: Project) => {
    setError('')
    setPreview(null)
    setBuild(initialBuild)
    try {
      const opened = await getProject(listedProject.id)
      const path = opened.entrypoint || listedProject.entrypoint || 'index.tsx'
      const file = await getProjectFile(opened.id, path)
      setProject(opened)
      setProjects((current) => current.some((item) => item.id === opened.id) ? current : [opened, ...current])
      setFilePath(file.path)
      setSource(file.content)
      setRevision(file.revision)
      setDirty(false)
      setBuild(initialBuild)
      void refreshPreview(opened.id, view)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to open project')
    }
  }, [refreshPreview, view])

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
        setError('This file changed outside the editor. Reload it before editing further.')
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

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault()
    const name = projectName.trim()
    if (!name) return
    setError('')
    try {
      const created = await createProject(name)
      setProjects((current) => [created, ...current.filter((item) => item.id !== created.id)])
      setCreating(false)
      setProjectName('')
      await openProject(created)
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

  return (
    <main className="workbench">
      <header className="topbar">
        <a className="brand" href="#" aria-label="Circuits Workbench home"><span className="brand-mark">C</span><span>circuits</span></a>
        <div className="project-heading">
          <span className="project-crumb">Projects</span>
          <span className="crumb-divider">/</span>
          <strong>{project?.name || 'Select a project'}</strong>
        </div>
        <div className="top-actions">
          <div className={`build-state ${build.status}`} aria-live="polite"><span className="status-dot" />{statusText}</div>
          <button className="build-button" disabled={!project || build.status === 'compiling'} onClick={runBuild}><span>▶</span> Build</button>
        </div>
      </header>

      <div className="workspace">
        <aside className="explorer">
          <div className="sidebar-title"><span>PROJECTS</span><button className="icon-button" aria-label="New project" title="New project" onClick={() => setCreating(true)}>＋</button></div>
          {creating && <form className="create-form" onSubmit={handleCreate}>
            <label htmlFor="project-name">Project name</label>
            <input id="project-name" autoFocus value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="e.g. Sensor board" />
            <div className="form-actions"><button type="button" className="quiet-button" onClick={() => setCreating(false)}>Cancel</button><button className="small-primary" type="submit">Create project</button></div>
          </form>}
          <button className="new-project-link" onClick={() => setCreating(true)}><span>＋</span> New project</button>
          <div className="project-list" aria-label="Project list">
            {loading ? <div className="sidebar-empty">Loading projects…</div> : projects.length === 0 ? <div className="sidebar-empty">Your projects will appear here.</div> : projects.map((item) => (
              <button key={item.id} className={`project-item ${project?.id === item.id ? 'selected' : ''}`} onClick={() => void openProject(item)}>
                <span className="project-icon">▱</span><span className="project-item-copy"><strong>{item.name}</strong><small>{item.updatedAt ? new Date(item.updatedAt).toLocaleDateString() : 'TSX project'}</small></span>
              </button>
            ))}
          </div>
          <div className="sidebar-footer"><span className="connection-dot" /> Local workspace</div>
        </aside>

        <section className="editor-panel" aria-label="Source editor panel">
          <div className="panel-toolbar editor-toolbar">
            <div className="file-tab"><span className="tsx-icon">TS</span>{filePath || 'No file open'}{dirty && <span className="unsaved-dot" title="Unsaved changes" />}</div>
            <div className="save-indicator">{saving ? 'Saving…' : dirty ? 'Unsaved' : revision ? 'Saved' : ''}</div>
          </div>
          {project ? <Editor
            height="100%"
            language="typescript"
            path={filePath}
            theme="vs-dark"
            value={source}
            onChange={(value) => { setSource(value ?? ''); setDirty(true) }}
            options={{ fontSize: 13, minimap: { enabled: false }, scrollBeyondLastLine: false, tabSize: 2, wordWrap: 'on', padding: { top: 14 } }}
          /> : <div className="empty-editor"><span className="empty-glyph">{'</>'}</span><h2>Your circuit starts here</h2><p>Create or open a project to edit its tscircuit source.</p><button className="small-primary" onClick={() => setCreating(true)}>Create project</button></div>}
        </section>

        <section className="preview-panel" aria-label="Design previews">
          <div className="preview-toolbar">
            <div className="view-tabs" role="tablist" aria-label="Preview type">
              {views.map(({ kind, label }) => <button key={kind} role="tab" aria-selected={view === kind} className={`view-tab ${view === kind ? 'active' : ''}`} onClick={() => setView(kind)}>{label}</button>)}
            </div>
            <span className="preview-meta">{preview ? `Revision ${build.revision || revision}` : 'Live preview'}</span>
          </div>
          <div className="preview-content">
            {build.status === 'failed' && <div className="build-errors" role="alert"><div className="error-title"><span>!</span> Build failed</div>{build.diagnostics?.length ? build.diagnostics.map((diagnostic, index) => { const path = diagnostic.path || diagnostic.file; return <div className="diagnostic" key={`${path}-${diagnostic.line}-${index}`}><strong>{path}{diagnostic.line ? `:${diagnostic.line}` : ''}</strong><span>{diagnostic.message}</span></div> }) : <p>Check the source and build output for details.</p>}</div>}
            {preview ? <Suspense fallback={<div className="preview-loading">Loading tscircuit preview…</div>}><CircuitJsonPreview key={`${view}-${build.revision || revision}`} circuitJson={preview} defaultActiveTab={views.find((item) => item.kind === view)?.tab} showCodeTab={false} showImportAndFormatButtons={false} /></Suspense> : <div className="preview-placeholder">
              <div className="placeholder-board"><span className="board-edge edge-a" /><span className="board-edge edge-b" /><span className="board-chip chip-a" /><span className="board-chip chip-b" /><span className="board-pad pad-a" /><span className="board-pad pad-b" /><span className="board-route route-a" /><span className="board-route route-b" /></div>
              <h2>{project ? build.status === 'failed' ? 'Last good preview is unavailable' : 'Waiting for first build' : 'Your design workspace'}</h2>
              <p>{project ? build.status === 'failed' ? 'Fix the source and build again to update this view.' : 'Build the project to generate a schematic, PCB layout, and 3D preview.' : 'Create a project to see your design take shape.'}</p>
              {project && <button className="outline-button" onClick={runBuild}>Build project</button>}
            </div>}
          </div>
          {build.status === 'failed' && !preview && build.diagnostics?.length ? null : build.status !== 'failed' && build.status !== 'ready' && <div className="preview-footer"><span className="pulse-dot" />Previews update when source changes</div>}
        </section>
      </div>
      {error && <div className="toast-error" role="alert"><span>{error}</span>{error.includes('changed on disk') || error.includes('changed outside') ? <button className="reload-button" onClick={reloadFile}>Reload file</button> : null}<button aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
    </main>
  )
}
