import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import App from '../src/App'

const api = vi.hoisted(() => ({
  listProjects: vi.fn(),
  createProject: vi.fn(),
  getProject: vi.fn(),
  getProjectFile: vi.fn(),
  saveProjectFile: vi.fn(),
  startBuild: vi.fn(),
  getPreview: vi.fn(),
  getSimulation: vi.fn(),
  subscribeToProject: vi.fn(() => () => {}),
}))

vi.mock('../src/api', () => api)
vi.mock('@monaco-editor/react', () => ({
  default: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea aria-label="TSX source editor" value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}))
vi.mock('@tscircuit/runframe', () => ({
  CircuitJsonPreview: ({ className }: { className?: string }) => <div className={className} data-testid="circuit-preview">Circuit JSON preview</div>,
}))

const existingProject = { id: 'led-1', name: 'LED Board', entrypoint: 'index.tsx', revision: 'rev-1' }

beforeEach(() => {
  vi.clearAllMocks()
  api.listProjects.mockResolvedValue([existingProject])
  api.getProject.mockResolvedValue(existingProject)
  api.getProjectFile.mockResolvedValue({ path: 'index.tsx', content: 'export default () => <board />', revision: 'rev-1' })
  api.getPreview.mockResolvedValue({ kind: 'schematic', revision: 'rev-1', circuitJson: [] })
  api.getSimulation.mockResolvedValue({ revision: 'rev-1', status: 'not_configured', experiments: [], signals: [], diagnostics: [] })
  api.createProject.mockResolvedValue({ ...existingProject, id: 'new-1', name: 'Sensor Board' })
})

describe('workbench', () => {
  it('opens a project in the TSX editor and preview workspace', async () => {
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: /LED Board/ }))

    expect(await screen.findByLabelText('TSX source editor')).toHaveValue('export default () => <board />')
    expect(await screen.findByTestId('circuit-preview')).toBeInTheDocument()
    expect(screen.getByTestId('circuit-preview')).toHaveClass('circuit-preview')
    expect(screen.getByRole('tab', { name: 'Schematic' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'PCB' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '3D' })).toBeInTheDocument()
  })

  it('creates a project from the explorer and opens its entry file', async () => {
    api.listProjects.mockResolvedValueOnce([])
    api.getProject.mockResolvedValue({ ...existingProject, id: 'new-1', name: 'Sensor Board' })

    render(<App />)
    fireEvent.click(screen.getAllByRole('button', { name: /New project/ })[1])
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Sensor Board' } })
    fireEvent.click(screen.getByLabelText('Project name').closest('form')!.querySelector('button[type="submit"]')!)

    await waitFor(() => expect(api.createProject).toHaveBeenCalledWith('Sensor Board'))
    expect(await screen.findByLabelText('TSX source editor')).toHaveValue('export default () => <board />')
  })
})
