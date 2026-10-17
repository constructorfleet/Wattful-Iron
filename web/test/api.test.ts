import { describe, expect, it, vi } from 'vitest'
import { createProject, getManufacturingArchive, getManufacturingPreflight, getManufacturingProfiles, getProjectFile, saveProjectFile, type Project } from '../src/api'

describe('project API', () => {
  it('creates a named project and returns the server project record', async () => {
    const project: Project = { id: 'p-1', name: 'LED board', entrypoint: 'index.tsx', revision: 'r1' }
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(project), { status: 201 }))

    await expect(createProject('LED board', fetcher)).resolves.toEqual(project)
    expect(fetcher).toHaveBeenCalledWith('/api/projects', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ name: 'LED board' }),
    }))
  })

  it('loads source together with the revision needed for optimistic writes', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ path: 'index.tsx', content: 'export default () => null', revision: 'r2' })))
    await expect(getProjectFile('p-1', 'index.tsx', fetcher)).resolves.toMatchObject({ revision: 'r2' })
    expect(fetcher).toHaveBeenCalledWith('/api/projects/p-1/files?path=index.tsx', expect.anything())
  })

  it('uses If-Match and reports a stale revision as a conflict', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('revision changed', { status: 409 }))
    await expect(saveProjectFile('p-1', 'index.tsx', 'new source', 'r2', fetcher)).rejects.toThrow('changed on disk')
    expect(fetcher).toHaveBeenCalledWith('/api/projects/p-1/files?path=index.tsx', expect.objectContaining({
      method: 'PUT',
      headers: expect.objectContaining({ 'If-Match': 'r2' }),
    }))
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
