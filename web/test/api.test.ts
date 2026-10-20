import { describe, expect, it, vi } from 'vitest'
import { compareProjectRevisions, createProject, duplicateProject, exportProjectArchive, getManufacturingArchive, getManufacturingPreflight, getManufacturingProfiles, getProjectFile, getProjectHistory, getProjectReferencePdfUrl, importPdfReference, importProjectArchive, importSchematics, listProjectTemplates, restoreProjectRevision, saveProjectFile, type Project } from '../src/api'

describe('project API', () => {
  it('imports a ZIP archive as a new project without decoding its bytes', async () => {
    const project: Project = { id: 'p-imported', name: 'Imported board', entrypoint: 'index.tsx', revision: 'r1' }
    const file = new File(['zip bytes'], 'board.zip', { type: 'application/zip' })
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(project), { status: 201 }))
    await expect(importProjectArchive(file, fetcher)).resolves.toEqual(project)
    expect(fetcher).toHaveBeenCalledWith('/api/projects/import-archive', expect.objectContaining({
      method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: file,
    }))
  })

  it('shows the archive validation message instead of raw JSON', async () => {
    const file = new File(['invalid'], 'bad.zip', { type: 'application/zip' })
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Project archive is missing its manifest' }), { status: 400 }))
    await expect(importProjectArchive(file, fetcher)).rejects.toThrow(/^Project archive is missing its manifest$/)
  })

  it('downloads a project ZIP and reports server export errors', async () => {
    const archive = new Blob(['zip bytes'], { type: 'application/zip' })
    const fetcher = vi.fn().mockResolvedValue(new Response(archive, { status: 200 }))
    await expect(exportProjectArchive('p/1', fetcher)).resolves.toEqual(archive)
    expect(fetcher).toHaveBeenCalledWith('/api/projects/p%2F1/export')
    await expect(exportProjectArchive('missing', vi.fn().mockResolvedValue(new Response('Project not found', { status: 404 }))))
      .rejects.toThrow('Project not found')
  })

  it('creates a named project and returns the server project record', async () => {
    const project: Project = { id: 'p-1', name: 'LED board', entrypoint: 'index.tsx', revision: 'r1' }
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(project), { status: 201 }))

    await expect(createProject('LED board', 'led-indicator', fetcher)).resolves.toEqual(project)
    expect(fetcher).toHaveBeenCalledWith('/api/projects', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ name: 'LED board', templateId: 'led-indicator' }),
    }))
  })

  it('duplicates a project using its current revision', async () => {
    const project: Project = { id: 'copy-1', name: 'LED copy', entrypoint: 'index.tsx', revision: 'r2' }
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(project), { status: 201 }))
    await expect(duplicateProject('p-1', 'LED copy', 'r1', fetcher)).resolves.toEqual(project)
    expect(fetcher).toHaveBeenCalledWith('/api/projects/p-1/duplicate', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'If-Match': 'r1' },
      body: JSON.stringify({ name: 'LED copy' }),
    }))
  })

  it('reports a stale source revision instead of silently duplicating newer contents', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Project changed since this project was read' }), { status: 409 }))
    await expect(duplicateProject('p-1', 'LED copy', 'stale-revision', fetcher)).rejects.toThrow('Project changed since this project was read')
  })

  it('lists built-in project templates', async () => {
    const examples = [{ id: 'led-indicator', name: 'Connected LED indicator', description: 'A powered LED circuit.' }]
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(examples), { status: 200 }))
    await expect(listProjectTemplates(fetcher)).resolves.toEqual(examples)
    expect(fetcher).toHaveBeenCalledWith('/api/examples', {})
  })

  it('uploads one or more schematic files as text for project import', async () => {
    const result = { project: { id: 'p-2', name: 'Imported', entrypoint: 'index.circuit.tsx', revision: 'r1' }, sourceComponents: 2, warnings: [] }
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(result), { status: 201 }))
    await expect(importSchematics('Imported', [{ name: 'board.kicad_sch', content: '(kicad_sch)' }], fetcher)).resolves.toEqual(result)
    expect(fetcher).toHaveBeenCalledWith('/api/projects/import', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ name: 'Imported', files: [{ name: 'board.kicad_sch', content: '(kicad_sch)' }] }),
    }))
  })

  it('uploads a PDF as a visual reference and builds its project URL', async () => {
    const project: Project = { id: 'p-pdf', name: 'Shim', entrypoint: 'index.circuit.tsx', revision: 'r1', referencePdfs: [{ id: 'ref-1', name: 'shim schematic.pdf' }] }
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(project), { status: 201 }))
    const file = new File(['%PDF-1.4'], 'shim schematic.pdf', { type: 'application/pdf' })
    await expect(importPdfReference('Shim', file, fetcher)).resolves.toEqual(project)
    expect(fetcher).toHaveBeenCalledWith('/api/projects/import-pdf?name=Shim&filename=shim+schematic.pdf', expect.objectContaining({ method: 'POST', body: file }))
    expect(getProjectReferencePdfUrl('p/pdf', 'ref 1')).toBe('/api/projects/p%2Fpdf/references/ref%201')
  })

  it('loads source together with the revision needed for optimistic writes', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ path: 'index.tsx', content: 'export default () => null', revision: 'r2' })))
    await expect(getProjectFile('p-1', 'index.tsx', fetcher)).resolves.toMatchObject({ revision: 'r2' })
    expect(fetcher).toHaveBeenCalledWith('/api/projects/p-1/files?path=index.tsx', expect.anything())
  })

  it('uses If-Match and reports a stale revision as a conflict', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'This file changed on disk. Reload it before saving again.' }), { status: 409 }))
    await expect(saveProjectFile('p-1', 'index.tsx', 'new source', 'r2', fetcher)).rejects.toThrow('changed on disk')
    expect(fetcher).toHaveBeenCalledWith('/api/projects/p-1/files?path=index.tsx', expect.objectContaining({
      method: 'PUT',
      headers: expect.objectContaining({ 'If-Match': 'r2' }),
    }))
  })

  it('lists revisions, compares source snapshots, and restores with the current revision token', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ revisions: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ from: 'r1', to: 'r2', files: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ revision: 'r3', restoredFrom: 'r1', changedFiles: ['index.tsx'] }), { status: 200 }))
    await getProjectHistory('p-1', fetcher)
    await compareProjectRevisions('p-1', 'r1', 'r2', fetcher)
    await restoreProjectRevision('p-1', 'r1', 'r2', fetcher)
    expect(fetcher).toHaveBeenNthCalledWith(1, '/api/projects/p-1/history', {})
    expect(fetcher).toHaveBeenNthCalledWith(2, '/api/projects/p-1/history/compare?from=r1&to=r2', {})
    expect(fetcher).toHaveBeenNthCalledWith(3, '/api/projects/p-1/history/r1/restore', { method: 'POST', headers: { 'If-Match': 'r2' } })
  })

  it('downloads manufacturing ZIP data from the project endpoint', async () => {
    const blob = new Blob(['zip-bytes'], { type: 'application/zip' })
    const fetcher = vi.fn().mockResolvedValue({ ok: true, blob: async () => blob } as Response)
    const downloaded = await getManufacturingArchive('p-1', 'jlcpcb-2layer-1oz', fetcher)
    expect(downloaded).toBe(blob)
    expect(fetcher).toHaveBeenCalledWith('/api/projects/p-1/manufacturing.zip?profile=jlcpcb-2layer-1oz')
  })

  it('loads manufacturing profiles and preflight for the selected profile', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ profiles: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ preflight: { ready: true, profile: { id: 'jlcpcb-2layer-1oz', label: 'JLCPCB' }, checks: [] } }), { status: 200 }))
    await getManufacturingProfiles(fetcher)
    const result = await getManufacturingPreflight('p-1', 'jlcpcb-2layer-1oz', fetcher)
    expect(result.preflight.profile.id).toBe('jlcpcb-2layer-1oz')
    expect(fetcher).toHaveBeenNthCalledWith(1, '/api/manufacturing/profiles', {})
    expect(fetcher).toHaveBeenNthCalledWith(2, '/api/projects/p-1/manufacturing?profile=jlcpcb-2layer-1oz', {})
  })

  it('surfaces manufacturing preflight failures to the UI', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Manufacturing preflight failed', preflight: { checks: [{ status: 'fail', message: 'Missing footprint' }] } }), { status: 422 }))
    await expect(getManufacturingArchive('p-1', 'board-default', fetcher)).rejects.toThrow('Missing footprint')
  })
})
