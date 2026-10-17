import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  getManufacturingProfiles: vi.fn(),
  getManufacturingPreflight: vi.fn(),
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
vi.mock('@tscircuit/pcb-viewer', () => ({
  PCBViewer: ({ circuitJson }: { circuitJson: Array<{ type: string }> }) => <div data-testid="pcb-viewer" data-circuit-types={circuitJson.map((item) => item.type).join(',')} />,
}))

const existingProject = { id: 'led-1', name: 'LED Board', entrypoint: 'index.tsx', revision: 'rev-1' }

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  api.listProjects.mockResolvedValue([existingProject])
  api.getProject.mockResolvedValue(existingProject)
  api.getProjectFile.mockResolvedValue({ path: 'index.tsx', content: 'export default () => <board />', revision: 'rev-1' })
  api.getPreview.mockResolvedValue({ kind: 'schematic', revision: 'rev-1', circuitJson: [] })
  api.getSimulation.mockResolvedValue({ revision: 'rev-1', status: 'not_configured', experiments: [], signals: [], diagnostics: [] })
  api.getManufacturingProfiles.mockResolvedValue({ profiles: [
    { id: 'board-default', label: 'Board defaults', description: 'Use board rules.', rules: { minTraceWidthMm: 0, minNonPlatedHoleMm: 0, copperToBoardEdgeMm: 0 } },
    { id: 'jlcpcb-2layer-1oz', label: 'JLCPCB rigid PCB, 2-layer, 1 oz', description: 'JLCPCB baseline.', rules: { minTraceWidthMm: 0.1, minNonPlatedHoleMm: 0.5, copperToBoardEdgeMm: 0.2 } },
  ] })
  api.getManufacturingPreflight.mockResolvedValue({ preflight: { ready: true, profile: { id: 'board-default', label: 'Board defaults' }, checks: [{ id: 'circuit-errors', status: 'pass', message: 'No Circuit JSON ERC/DRC errors were reported.' }] } })
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

  it('passes built circuit data into the PCB viewer', async () => {
    api.getPreview.mockResolvedValue({ kind: 'pcb', revision: 'rev-1', circuitJson: [{ type: 'pcb_board' }, { type: 'pcb_component' }] })

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /LED Board/ }))
    fireEvent.click(screen.getByRole('tab', { name: 'PCB' }))

    expect(await screen.findByTestId('pcb-viewer')).toHaveAttribute('data-circuit-types', 'pcb_board,pcb_component')
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

  it('shows selected-profile preflight checks before manufacturing export', async () => {
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /LED Board/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Rule checks/ }))

    expect(await screen.findByRole('dialog', { name: 'Manufacturing preflight' })).toBeInTheDocument()
    expect(await screen.findByText('No Circuit JSON ERC/DRC errors were reported.')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Fabricator rule profile'), { target: { value: 'jlcpcb-2layer-1oz' } })
    await waitFor(() => expect(api.getManufacturingPreflight).toHaveBeenCalledWith('led-1', 'jlcpcb-2layer-1oz'))
  })
})
