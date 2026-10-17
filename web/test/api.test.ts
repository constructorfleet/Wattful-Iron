import { describe, expect, it, vi } from 'vitest'
import { createProject, getProjectFile, saveProjectFile, type Project } from '../src/api'

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
})
