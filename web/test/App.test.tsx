import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import App from '../src/App'

const api = vi.hoisted(() => ({
  listProjects: vi.fn(),
  listProjectTemplates: vi.fn(),
  createProject: vi.fn(),
  duplicateProject: vi.fn(),
  importPdfReference: vi.fn(),
  getProject: vi.fn(),
  getProjectReferencePdfUrl: vi.fn((projectId: string, referenceId: string) => `/api/projects/${projectId}/references/${referenceId}`),
  getProjectFile: vi.fn(),
  getProjectFiles: vi.fn(),
  getProjectHistory: vi.fn(),
  compareProjectRevisions: vi.fn(),
  restoreProjectRevision: vi.fn(),
  saveProjectFile: vi.fn(),
  startBuild: vi.fn(),
  generatePcbDraft: vi.fn(),
  getPreview: vi.fn(),
  getSimulation: vi.fn(),
  getManufacturingProfiles: vi.fn(),
  getManufacturingPreflight: vi.fn(),
  subscribeToProject: vi.fn((_id: string, _onEvent: (event: unknown) => void) => () => {}),
}))
const pcbViewer = vi.hoisted(() => ({ focusPcbComponent: vi.fn() }))

let projectEvent: ((event: unknown) => void) | undefined

vi.mock('../src/api', () => api)
vi.mock('@monaco-editor/react', () => ({
  default: ({ value, onChange, language }: { value: string; onChange: (value: string) => void; language?: string }) => (
    <textarea aria-label="TSX source editor" data-language={language} value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}))
vi.mock('@tscircuit/runframe', () => ({
  CircuitJsonPreview: ({ className }: { className?: string }) => <div className={className} data-testid="circuit-preview">Circuit JSON preview</div>,
}))
vi.mock('@tscircuit/pcb-viewer', () => ({
  usePcbViewerController: () => ({ controller: { focusRequest: null, onFocusRequestHandled: vi.fn() }, focusPcbComponent: pcbViewer.focusPcbComponent }),
  PCBViewer: ({ circuitJson, onViewSchematicComponent }: { circuitJson: Array<{ type: string }>; onViewSchematicComponent?: (event: { source_component_id: string; pcb_component_id: string; refdes: string }) => void }) => <><div data-testid="pcb-viewer" data-circuit-types={circuitJson.map((item) => item.type).join(',')} />{onViewSchematicComponent && <button onClick={() => onViewSchematicComponent({ source_component_id: 'sc-r1', pcb_component_id: 'pcb-r1', refdes: 'R1' })}>View R1 on Schematic</button>}</>,
}))

const existingProject = { id: 'led-1', name: 'LED Board', entrypoint: 'index.tsx', revision: 'rev-1' }

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  projectEvent = undefined
  api.subscribeToProject.mockImplementation((_id, onEvent) => { projectEvent = onEvent; return () => {} })
  api.listProjects.mockResolvedValue([existingProject])
  api.listProjectTemplates.mockResolvedValue([
    { id: 'blank-board', name: 'Blank starter', description: 'An empty board ready for your circuit.' },
    { id: 'led-indicator', name: 'Connected LED indicator', description: 'A powered LED circuit with named nets.' },
  ])
  api.getProject.mockResolvedValue(existingProject)
  api.getProjectFile.mockResolvedValue({ path: 'index.tsx', content: 'export default () => <board />', revision: 'rev-1' })
  api.getProjectFiles.mockResolvedValue(['index.tsx', 'package.json', 'src/helpers.js'])
  api.getProjectHistory.mockResolvedValue({ revisions: [
    { revision: 'rev-1', createdAt: '2026-01-02T00:00:00.000Z', changedFiles: ['index.tsx'], sizeBytes: 120 },
    { revision: 'rev-2', createdAt: '2026-01-01T00:00:00.000Z', changedFiles: ['index.tsx'], sizeBytes: 110 },
  ] })
  api.compareProjectRevisions.mockResolvedValue({ from: 'rev-2', to: 'rev-1', files: [{ path: 'index.tsx', before: 'old source', after: 'new source' }] })
  api.restoreProjectRevision.mockResolvedValue({ revision: 'rev-3', restoredFrom: 'rev-2', changedFiles: ['index.tsx'] })
  api.getPreview.mockResolvedValue({ kind: 'schematic', revision: 'rev-1', circuitJson: [] })
  api.getManufacturingProfiles.mockResolvedValue({ profiles: [
    { id: 'board-default', label: 'Board defaults', description: 'Use board rules.', rules: { minTraceWidthMm: 0, minNonPlatedHoleMm: 0, copperToBoardEdgeMm: 0 } },
    { id: 'jlcpcb-2layer-1oz', label: 'JLCPCB rigid PCB, 2-layer, 1 oz', description: 'JLCPCB baseline.', rules: { minTraceWidthMm: 0.1, minNonPlatedHoleMm: 0.5, copperToBoardEdgeMm: 0.2 } },
  ] })
  api.getManufacturingPreflight.mockResolvedValue({ preflight: { ready: true, profile: { id: 'board-default', label: 'Board defaults' }, checks: [{ id: 'circuit-errors', status: 'not-evaluated', message: 'Circuit JSON contains no ERC/DRC error records; no validator result confirms this check passed.' }] } })
  api.getSimulation.mockResolvedValue({ revision: 'rev-1', status: 'not_configured', experiments: [], signals: [], diagnostics: [] })
  api.createProject.mockResolvedValue({ ...existingProject, id: 'new-1', name: 'Sensor Board' })
  api.duplicateProject.mockResolvedValue({ ...existingProject, id: 'copy-1', name: 'LED Board copy', revision: 'copy-rev-1' })
  api.importPdfReference.mockResolvedValue({ ...existingProject, id: 'pdf-1', name: 'Shim reference', referencePdfs: [{ id: 'ref-1', name: 'shim.pdf' }] })
  api.getProject.mockImplementation((id: string) => Promise.resolve(id === 'pdf-1'
    ? { ...existingProject, id: 'pdf-1', name: 'Shim reference', referencePdfs: [{ id: 'ref-1', name: 'shim.pdf' }] }
    : existingProject))
})

describe('workbench', () => {
  it('creates a project from a PDF and opens its visual reference', async () => {
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'New project' }))
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Shim reference' } })
    const file = new File(['%PDF-1.4'], 'shim.pdf', { type: 'application/pdf' })
    fireEvent.change(screen.getByLabelText('Import PDF as a visual reference'), { target: { files: [file] } })
    fireEvent.click(screen.getByRole('button', { name: 'Import PDF reference' }))
    await waitFor(() => expect(api.importPdfReference).toHaveBeenCalledWith('Shim reference', file))
    fireEvent.click(await screen.findByRole('button', { name: 'PDF reference' }))
    expect(await screen.findByRole('dialog', { name: 'shim.pdf' })).toBeInTheDocument()
    expect(screen.getByTitle('PDF reference: shim.pdf')).toHaveAttribute('src', '/api/projects/pdf-1/references/ref-1')
  })

  it('downloads a public PDF URL in the browser and imports it as a reference', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(new Blob(['%PDF-1.4']), { status: 200 }))
    try {
      render(<App />)
      fireEvent.click(await screen.findByRole('button', { name: 'New project' }))
      fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Shim reference' } })
      fireEvent.change(screen.getByLabelText('Or import from a public PDF URL'), { target: { value: 'https://example.com/shim.pdf' } })
      fireEvent.click(screen.getByRole('button', { name: 'Import PDF reference' }))
      await waitFor(() => expect(api.importPdfReference).toHaveBeenCalledWith('Shim reference', expect.objectContaining({ name: 'shim.pdf', type: 'application/pdf' })))
      expect(globalThis.fetch).toHaveBeenCalledWith(new URL('https://example.com/shim.pdf'), { mode: 'cors', credentials: 'omit' })
    } finally { globalThis.fetch = originalFetch }
  })

  it('opens a project in the TSX editor and preview workspace', async () => {
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: /LED Board TSX project/ }))

    expect(await screen.findByLabelText('TSX source editor')).toHaveValue('export default () => <board />')
    expect(await screen.findByTestId('circuit-preview')).toBeInTheDocument()
    expect(screen.getByTestId('circuit-preview')).toHaveClass('circuit-preview')
    expect(screen.getByRole('tab', { name: 'Schematic' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'PCB' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '3D' })).toBeInTheDocument()
  })

  it('shows schematic, PCB, and 3D previews together with keyboard-resizable panels', async () => {
    api.getPreview.mockResolvedValue({ kind: 'schematic', revision: 'rev-1', circuitJson: [
      { type: 'pcb_board' }, { type: 'pcb_component' }, { type: 'schematic_component' },
    ] })
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /LED Board TSX project/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Show all views' }))

    expect(screen.getByRole('region', { name: 'Schematic preview' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'PCB preview' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '3D preview' })).toBeInTheDocument()
    const divider = screen.getByRole('separator', { name: 'Resize schematic and PCB previews' })
    const before = Number(divider.getAttribute('aria-valuenow'))
    divider.focus()
    fireEvent.keyDown(divider, { key: 'ArrowRight' })
    expect(Number(divider.getAttribute('aria-valuenow'))).toBeGreaterThan(before)
  })

  it('explains when the selected project has schematic data but no PCB layout', async () => {
    api.getProjectFile.mockResolvedValueOnce({ path: 'index.tsx', content: 'const ImportedSchematic = () => null', revision: 'rev-1' })
    api.getPreview.mockResolvedValue({ kind: 'pcb', revision: 'rev-1', circuitJson: [{ type: 'schematic_component' }] })
    api.generatePcbDraft.mockResolvedValue({ revision: 'rev-2', placements: 3 })
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /LED Board TSX project/ }))
    fireEvent.click(await screen.findByRole('tab', { name: 'PCB' }))
    expect(await screen.findByText(/This schematic has no PCB placements/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Generate PCB draft' }))
    await waitFor(() => expect(api.generatePcbDraft).toHaveBeenCalledWith('led-1', 'rev-1'))
  })

  it('lets existing EasyEDA PCB drafts refresh component names from the retained source', async () => {
    api.getProjectFiles.mockResolvedValue(['index.circuit.tsx', 'imports/SCH_Hunter.json', 'package.json'])
    api.getProjectFile.mockResolvedValueOnce({ path: 'index.circuit.tsx', content: 'export const ImportedBoard = () => <board />', revision: 'rev-1' })
    api.generatePcbDraft.mockResolvedValue({ revision: 'rev-2', placements: 27 })
    api.getProjectFile.mockResolvedValue({ path: 'index.circuit.tsx', content: 'export const ImportedBoard = () => <board />', revision: 'rev-2' })
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /LED Board TSX project/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh component names' }))
    await waitFor(() => expect(api.generatePcbDraft).toHaveBeenCalledWith('led-1', 'rev-1'))
  })

  it('duplicates a project into a separate editable project', async () => {
    const duplicate = { ...existingProject, id: 'copy-1', name: 'LED Board copy', revision: 'copy-rev-1' }
    api.duplicateProject.mockResolvedValue(duplicate)
    api.getProject.mockImplementation((id: string) => Promise.resolve(id === 'copy-1' ? duplicate : existingProject))
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Duplicate LED Board' }))
    await waitFor(() => expect(api.duplicateProject).toHaveBeenCalledWith('led-1', 'LED Board copy', 'rev-1'))
    expect(await screen.findByLabelText('TSX source editor')).toHaveValue('export default () => <board />')
    expect(await screen.findByRole('button', { name: /LED Board copy TSX project/ })).toBeInTheDocument()
  })

  it('browses project files, opens them with matching editor language, and protects unsaved edits', async () => {
    api.getProjectFile.mockImplementation((_id: string, path: string) => Promise.resolve({
      path, content: path === 'src/helpers.js' ? 'export const pin = 1' : 'export default () => <board />', revision: 'rev-1',
    }))
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /LED Board TSX project/ }))
    expect(await screen.findByRole('button', { name: 'src/helpers.js' })).toBeInTheDocument()
    fireEvent.change(await screen.findByLabelText('TSX source editor'), { target: { value: 'unsaved circuit' } })
    fireEvent.click(screen.getByRole('button', { name: 'src/helpers.js' }))
    expect(await screen.findByRole('dialog', { name: 'Unsaved changes' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Discard and open' }))
    expect(await screen.findByLabelText('TSX source editor')).toHaveValue('export const pin = 1')
    expect(screen.getByLabelText('TSX source editor')).toHaveAttribute('data-language', 'javascript')
    expect(api.getProjectFile).toHaveBeenLastCalledWith('led-1', 'src/helpers.js')
  })

  it('cancels or saves before changing the active file', async () => {
    api.saveProjectFile.mockResolvedValue({ path: 'index.tsx', content: 'edited', revision: 'rev-2' })
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /LED Board TSX project/ }))
    fireEvent.change(await screen.findByLabelText('TSX source editor'), { target: { value: 'edited source' } })
    fireEvent.click(screen.getByRole('button', { name: 'package.json' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(await screen.findByLabelText('TSX source editor')).toHaveValue('edited source')
    expect(api.getProjectFile).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'package.json' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Save and open' }))
    await waitFor(() => expect(api.saveProjectFile).toHaveBeenCalledWith('led-1', 'index.tsx', 'edited source', 'rev-1'))
    await waitFor(() => expect(api.getProjectFile).toHaveBeenLastCalledWith('led-1', 'package.json'))
  })

  it('passes built circuit data into the PCB viewer', async () => {
    api.getPreview.mockResolvedValue({ kind: 'pcb', revision: 'rev-1', circuitJson: [{ type: 'pcb_board' }, { type: 'pcb_component' }] })

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /LED Board TSX project/ }))
    fireEvent.click(screen.getByRole('tab', { name: 'PCB' }))

    expect(await screen.findByTestId('pcb-viewer')).toHaveAttribute('data-circuit-types', 'pcb_board,pcb_component')
  })

  it('imports an SVG board edge and saves it into the editable circuit source', async () => {
    api.saveProjectFile.mockResolvedValue({ path: 'index.tsx', content: 'updated source', revision: 'rev-2' })
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /LED Board TSX project/ }))
    fireEvent.click(await screen.findByRole('tab', { name: 'PCB' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Board outline' }))
    const file = new File(['<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="20mm" viewBox="0 0 400 200"><polygon points="0,0 400,0 300,200 0,200"/></svg>'], 'case.svg', { type: 'image/svg+xml' })
    fireEvent.change(screen.getByLabelText('Import outline SVG'), { target: { files: [file] } })
    await waitFor(() => expect(screen.getByLabelText('Outline point 1 x')).toHaveValue(-20))
    fireEvent.click(screen.getByRole('button', { name: 'Apply outline' }))
    await waitFor(() => expect((screen.getByLabelText('TSX source editor') as HTMLTextAreaElement).value).toContain('outline={[{"x":-20,"y":10}'))
    await waitFor(() => expect(api.saveProjectFile).toHaveBeenCalledWith('led-1', 'index.tsx', expect.stringContaining('outline={'), 'rev-1'))
  })

  it('adds board boundary points by clicking the canvas', async () => {
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /LED Board TSX project/ }))
    fireEvent.click(await screen.findByRole('tab', { name: 'PCB' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Board outline' }))
    const canvas = screen.getByRole('application', { name: 'Draw board outline' })
    fireEvent.click(canvas, { clientX: 0, clientY: 0 })
    expect(screen.getByLabelText('Outline point 5 x')).toHaveValue(-40)
    expect(screen.getByText('5 points · millimeters')).toBeInTheDocument()
  })

  it('inspects component properties, stable ID, PCB placement, and connected nets from the build', async () => {
    api.getPreview.mockResolvedValue({ kind: 'schematic', revision: 'rev-1', circuitJson: [
      { type: 'source_component', source_component_id: 'sc-r1', name: 'R1', ftype: 'simple_resistor', resistance: 1000 },
      { type: 'source_port', source_port_id: 'sp-r1-1', source_component_id: 'sc-r1', name: 'pin1', pin_number: 1 },
      { type: 'source_trace', source_trace_id: 'st-vcc', name: 'VCC', connected_source_port_ids: ['sp-r1-1'] },
      { type: 'pcb_component', pcb_component_id: 'pcb-r1', source_component_id: 'sc-r1', center: { x: 2, y: 3 }, rotation: 90, layer: 'top' },
    ] })

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /LED Board TSX project/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Components 1/ }))

    expect(screen.getByRole('complementary', { name: 'Component inspector' })).toBeInTheDocument()
    expect(screen.getByText('sc-r1')).toBeInTheDocument()
    expect(screen.getByText('simple_resistor')).toBeInTheDocument()
    expect(screen.getByText('VCC')).toBeInTheDocument()
    expect(screen.getByText('{"x":2,"y":3}')).toBeInTheDocument()
    expect(screen.getByText(/Selecting a component focuses its PCB footprint/)).toBeInTheDocument()
  })

  it('focuses the selected PCB footprint and opens component details from the PCB cross-probe action', async () => {
    api.getPreview.mockResolvedValue({ kind: 'pcb', revision: 'rev-1', circuitJson: [
      { type: 'source_component', source_component_id: 'sc-r1', name: 'R1' },
      { type: 'pcb_component', pcb_component_id: 'pcb-r1', source_component_id: 'sc-r1' },
    ] })

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /LED Board TSX project/ }))
    fireEvent.click(screen.getByRole('tab', { name: 'PCB' }))
    await screen.findByTestId('pcb-viewer')
    fireEvent.click(screen.getByRole('button', { name: /Components 1/ }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Select component' }), { target: { value: 'sc-r1' } })
    await waitFor(() => expect(pcbViewer.focusPcbComponent).toHaveBeenCalledWith('pcb-r1'))

    fireEvent.click(screen.getByRole('button', { name: 'View R1 on Schematic' }))
    expect(screen.getByRole('tab', { name: 'Schematic' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('complementary', { name: 'Component inspector' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Select component' })).toHaveValue('sc-r1')
  })

  it('runs simulation by rebuilding current source and shows emitted waveform results', async () => {
    api.saveProjectFile.mockResolvedValue({ path: 'index.tsx', content: 'export default () => <board name="updated" />', revision: 'rev-2' })
    api.getPreview.mockResolvedValue({ kind: 'schematic', revision: 'rev-2', circuitJson: [] })
    api.getSimulation
      .mockResolvedValueOnce({ revision: 'rev-1', status: 'not_configured', experiments: [], signals: [], diagnostics: [] })
      .mockResolvedValue({
        revision: 'rev-2', status: 'complete', experiments: [{ id: 'exp-1', name: 'Transient', type: 'transient' }],
        signals: [{ id: 'trace-1', name: 'OUT', unit: 'V', netId: 'net-1', samples: [{ x: 0, y: 0 }, { x: 1, y: 5 }] }], diagnostics: [],
      })
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /LED Board TSX project/ }))
    fireEvent.change(await screen.findByLabelText('TSX source editor'), { target: { value: 'export default () => <board name="updated" />' } })
    fireEvent.click(screen.getByRole('tab', { name: 'Simulation' }))

    fireEvent.click(await screen.findByRole('button', { name: 'Run simulation' }))
    await waitFor(() => expect(api.saveProjectFile).toHaveBeenCalledWith('led-1', 'index.tsx', 'export default () => <board name="updated" />', 'rev-1'))
    await waitFor(() => expect(api.startBuild).toHaveBeenCalledWith('led-1'))
    expect(await screen.findByText('Building with tscircuit…')).toBeInTheDocument()

    projectEvent?.({ type: 'build.ready', buildId: 'build-2', revision: 'rev-2' })
    expect(await screen.findByText('Transient')).toBeInTheDocument()
    expect(await screen.findByText('Net net-1 · V')).toBeInTheDocument()
  })

  it('shows tscircuit build diagnostics when a simulation rebuild fails', async () => {
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /LED Board TSX project/ }))
    fireEvent.click(screen.getByRole('tab', { name: 'Simulation' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Run simulation' }))
    await waitFor(() => expect(api.startBuild).toHaveBeenCalledWith('led-1'))

    projectEvent?.({ type: 'build.failed', buildId: 'build-2', revision: 'rev-1', diagnostics: [{ path: 'index.tsx', line: 4, message: 'Invalid analog source' }] })
    const alerts = await screen.findAllByRole('alert')
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toHaveTextContent('Build failed')
    expect(alerts[0]).toHaveTextContent('index.tsx:4: Invalid analog source')
  })

  it('creates a project from the explorer and opens its entry file', async () => {
    api.listProjects.mockResolvedValueOnce([])
    api.getProject.mockResolvedValue({ ...existingProject, id: 'new-1', name: 'Sensor Board' })

    render(<App />)
    fireEvent.click(screen.getAllByRole('button', { name: /New project/ })[1])
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Sensor Board' } })
    fireEvent.click(screen.getByLabelText('Project name').closest('form')!.querySelector('button[type="submit"]')!)

    await waitFor(() => expect(api.createProject).toHaveBeenCalledWith('Sensor Board', 'blank-board'))
    expect(await screen.findByLabelText('TSX source editor')).toHaveValue('export default () => <board />')
  })

  it('creates a project from a selected built-in example', async () => {
    render(<App />)
    fireEvent.click(screen.getAllByRole('button', { name: /New project/ })[1])
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'LED example' } })
    await screen.findByRole('option', { name: 'Connected LED indicator' })
    fireEvent.change(screen.getByLabelText('Start from'), { target: { value: 'led-indicator' } })
    fireEvent.click(screen.getByLabelText('Project name').closest('form')!.querySelector('button[type="submit"]')!)

    await waitFor(() => expect(api.createProject).toHaveBeenCalledWith('LED example', 'led-indicator'))
  })

  it('browses, compares, and restores a saved source revision', async () => {
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /LED Board TSX project/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'History' }))

    expect(await screen.findByRole('dialog', { name: 'Project source history' })).toBeInTheDocument()
    expect(await screen.findByText('old source')).toBeInTheDocument()
    expect(screen.getByText('new source')).toBeInTheDocument()
    fireEvent.click(screen.getByText('rev-2').closest('button')!)
    fireEvent.click(screen.getByRole('button', { name: 'Restore selected revision' }))

    await waitFor(() => expect(api.restoreProjectRevision).toHaveBeenCalledWith('led-1', 'rev-2', 'rev-1'))
    expect(await screen.findByLabelText('TSX source editor')).toHaveValue('export default () => <board />')
  })

  it('shows selected-profile preflight checks before manufacturing export', async () => {
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /LED Board TSX project/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Rule checks/ }))

    expect(await screen.findByRole('dialog', { name: 'Manufacturing preflight' })).toBeInTheDocument()
    expect(await screen.findByText('Not evaluated')).toBeInTheDocument()
    expect(await screen.findByText(/no validator result confirms this check passed/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Fabricator rule profile'), { target: { value: 'jlcpcb-2layer-1oz' } })
    await waitFor(() => expect(api.getManufacturingPreflight).toHaveBeenCalledWith('led-1', 'jlcpcb-2layer-1oz'))
  })
})
