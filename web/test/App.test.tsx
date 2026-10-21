import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import App from '../src/App'

const api = vi.hoisted(() => ({
  listProjects: vi.fn(),
  listProjectTemplates: vi.fn(),
  createProject: vi.fn(),
  duplicateProject: vi.fn(),
  importPdfReference: vi.fn(),
  importProjectArchive: vi.fn(),
  exportProjectArchive: vi.fn(),
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
  getNets: vi.fn(),
  getPower: vi.fn(),
  getAssertionCheck: vi.fn(),
  getBomCost: vi.fn(),
  getComponentSourcing: vi.fn(),
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
  PCBViewer: ({ circuitJson, onViewSchematicComponent }: { circuitJson: Array<{ type: string }>; onViewSchematicComponent?: (event: { source_component_id: string; pcb_component_id: string; refdes: string }) => void }) => <><div data-testid="pcb-viewer" data-circuit-types={circuitJson.map((item) => item.type).join(',')} />{onViewSchematicComponent && <button type="button" onClick={() => onViewSchematicComponent({ source_component_id: 'sc-r1', pcb_component_id: 'pcb-r1', refdes: 'R1' })}>View R1 on Schematic</button>}</>,
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
  api.getProjectHistory.mockResolvedValue({ gitBacked: true, snapshotRetention: 50, revisions: [
    { revision: 'rev-1', createdAt: '2026-01-02T00:00:00.000Z', changedFiles: ['index.tsx'], sizeBytes: 120, commit: 'abcdef1234567890', retainedSnapshot: true, hasDesignSummary: true },
    { revision: 'rev-2', createdAt: '2026-01-01T00:00:00.000Z', changedFiles: ['index.tsx'], sizeBytes: 110, commit: 'fedcba0987654321', retainedSnapshot: true, hasDesignSummary: true },
  ] })
  api.compareProjectRevisions.mockResolvedValue({
    from: 'rev-2', to: 'rev-1',
    files: [{ path: 'index.tsx', before: 'old source', after: 'new source' }],
    design: { available: false, reason: 'No retained build summary for revision rev-2. Build those revisions to compare their designs; summaries are written when a build succeeds.' },
  })
  api.restoreProjectRevision.mockResolvedValue({ revision: 'rev-3', restoredFrom: 'rev-2', changedFiles: ['index.tsx'] })
  api.getPreview.mockResolvedValue({ kind: 'schematic', revision: 'rev-1', circuitJson: [] })
  api.getManufacturingProfiles.mockResolvedValue({ profiles: [
    { id: 'board-default', label: 'Board defaults', description: 'Use board rules.', rules: { minTraceWidthMm: 0, minNonPlatedHoleMm: 0, copperToBoardEdgeMm: 0 } },
    { id: 'jlcpcb-2layer-1oz', label: 'JLCPCB rigid PCB, 2-layer, 1 oz', description: 'JLCPCB baseline.', rules: { minTraceWidthMm: 0.1, minNonPlatedHoleMm: 0.5, copperToBoardEdgeMm: 0.2 } },
  ] })
  api.getManufacturingPreflight.mockResolvedValue({ preflight: { ready: true, profile: { id: 'board-default', label: 'Board defaults' }, checks: [{ id: 'circuit-errors', status: 'not-evaluated', message: 'Circuit JSON contains no ERC/DRC error records; no validator result confirms this check passed.' }] } })
  api.getSimulation.mockResolvedValue({ revision: 'rev-1', status: 'not_configured', experiments: [], signals: [], operatingPoints: [], sweeps: [], analyses: [], diagnostics: [], notEvaluated: [] })
  api.getAssertionCheck.mockResolvedValue({ configured: false, revision: 'rev-1', message: 'This project has no assertions.json document, so no regression assertions were evaluated.' })
  api.getBomCost.mockResolvedValue({ configured: false, revision: 'rev-1', parts: [], message: 'No component sourcing provider is configured, so no prices or stock were looked up. Set COMPONENT_SOURCING_URL to enable it.' })
  api.getComponentSourcing.mockResolvedValue({ configured: false })
  api.getPower.mockResolvedValue({ revision: 'rev-1', status: 'not-evaluated', assumptions: ['IPC-2221 current capacity at a 10 degree Celsius temperature rise.'], traceCapacity: [], nodeVoltages: [], branchCurrents: [], componentPower: [], supplyLoads: [], traceLoads: [], notEvaluated: [{ quantity: 'Thermal rise of components and planes', reason: 'Not implemented. No thermal model or copper area analysis is performed.' }] })
  api.getNets.mockResolvedValue({ revision: 'rev-1', nets: [], uncorrelatedSimulationSignals: [], limitations: ['Nets are grouped by the Circuit JSON connectivity map emitted by the build.'] })
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

  it('imports a project archive and asks before replacing unsaved editor state', async () => {
    api.importProjectArchive.mockResolvedValue({ ...existingProject, id: 'archive-1', name: 'Archived Board' })
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /LED Board TSX project/ }))
    fireEvent.change(await screen.findByLabelText('TSX source editor'), { target: { value: 'unsaved local edit' } })
    fireEvent.change(screen.getByLabelText('Import project archive (.zip)'), { target: { files: [new File(['zip'], 'board.zip', { type: 'application/zip' })] } })
    fireEvent.click(screen.getByRole('button', { name: 'Import archive' }))
    await waitFor(() => expect(api.importProjectArchive).toHaveBeenCalledWith(expect.any(File)))
    expect(await screen.findByRole('dialog', { name: 'Unsaved changes' })).toBeInTheDocument()
    expect(screen.getByLabelText('TSX source editor')).toHaveValue('unsaved local edit')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByLabelText('TSX source editor')).toHaveValue('unsaved local edit')
  })

  it('shows archive import errors without replacing the open project', async () => {
    api.importProjectArchive.mockRejectedValue(new Error('Project archive is missing index.tsx'))
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /LED Board TSX project/ }))
    fireEvent.change(screen.getByLabelText('Import project archive (.zip)'), { target: { files: [new File(['bad'], 'bad.zip', { type: 'application/zip' })] } })
    fireEvent.click(screen.getByRole('button', { name: 'Import archive' }))
    expect(await screen.findByText('Project archive is missing index.tsx')).toBeInTheDocument()
    expect(screen.getByLabelText('TSX source editor')).toHaveValue('export default () => <board />')
  })

  it('downloads the open project as a ZIP archive', async () => {
    api.exportProjectArchive.mockResolvedValue(new Blob(['archive'], { type: 'application/zip' }))
    const createObjectURL = vi.fn(() => 'blob:project-archive')
    const originalCreateObjectURL = URL.createObjectURL
    URL.createObjectURL = createObjectURL
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    try {
      render(<App />)
      fireEvent.click(await screen.findByRole('button', { name: /LED Board TSX project/ }))
      await screen.findByLabelText('TSX source editor')
      fireEvent.click(screen.getByRole('button', { name: 'Export project ZIP' }))
      await waitFor(() => expect(api.exportProjectArchive).toHaveBeenCalledWith('led-1'))
      expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob))
      expect(click).toHaveBeenCalled()
    } finally {
      URL.createObjectURL = originalCreateObjectURL
      click.mockRestore()
    }
  })

  it('downloads a public PDF URL in the browser and imports it as a reference', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52]), { status: 200 }))
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

  it('traces a net from a component pin to its wires, copper, vias, and waveforms', async () => {
    api.getPreview.mockResolvedValue({ kind: 'pcb', revision: 'rev-1', circuitJson: [
      { type: 'source_component', source_component_id: 'sc-r1', name: 'R1', ftype: 'simple_resistor' },
      { type: 'source_port', source_port_id: 'sp-r1-2', source_component_id: 'sc-r1', name: 'pin2' },
      { type: 'source_trace', source_trace_id: 'st-sense', name: 'SENSE', connected_source_port_ids: ['sp-r1-2'] },
      { type: 'pcb_component', pcb_component_id: 'pcb-r1', source_component_id: 'sc-r1' },
    ] })
    api.getNets.mockResolvedValue({
      revision: 'rev-1',
      nets: [{
        id: 'net1', name: 'SENSE', names: ['SENSE'], sourceTraceIds: ['st-sense'],
        pins: [
          { sourcePortId: 'sp-r1-2', pinName: 'pin2', sourceComponentId: 'sc-r1', componentName: 'R1', pcbPortId: 'pp-1', routed: true },
          { sourcePortId: 'sp-r2-1', pinName: 'pin1', sourceComponentId: 'sc-r2', componentName: 'R2', pcbPortId: 'pp-2', routed: false },
        ],
        schematicTraces: [{ schematicTraceId: 'scht-1', edgeCount: 3 }],
        copperTraces: [{ pcbTraceId: 'pt-1', layers: ['top'], widthMm: 0.2, lengthMm: 4.25, connectedPcbPortIds: ['pp-1'] }],
        vias: [{ pcbViaId: 'pv-1', x: 1, y: -0.8, fromLayer: 'top', toLayer: 'bottom' }],
        simulationSignals: [{ id: 'g1', name: 'SENSE probe', unit: 'V' }],
        routing: 'partially-routed',
      }],
      uncorrelatedSimulationSignals: [{ id: 'g2', name: 'FLOATING', unit: 'V' }],
      limitations: ['Nets are grouped by the Circuit JSON connectivity map emitted by the build.'],
    })

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /LED Board TSX project/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Components 1/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Trace net' }))

    const inspector = screen.getByRole('complementary', { name: 'Net inspector' })
    expect(inspector).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Select net' })).toHaveValue('net1')
    expect(screen.getByText('Partially routed')).toBeInTheDocument()
    expect(screen.getByText('R1 · pin2')).toBeInTheDocument()
    expect(screen.getByText('Reached by copper on this net')).toBeInTheDocument()
    expect(screen.getByText('Placed but not reached by copper')).toBeInTheDocument()
    expect(screen.getByText('3 segments')).toBeInTheDocument()
    expect(screen.getByText('4.25 mm · top · 0.2 mm wide')).toBeInTheDocument()
    expect(screen.getByText(/1 via: pv-1 \(1, -0.8\) top→bottom/)).toBeInTheDocument()
    expect(screen.getByText('1 simulation signal(s) could not be correlated with a net.')).toBeInTheDocument()
    expect(screen.getByText(/expose no highlight API/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Open waveforms' }))
    expect(screen.getByRole('tab', { name: 'Simulation' })).toHaveAttribute('aria-selected', 'true')
  })

  it('focuses a net pin footprint on the PCB from the net inspector', async () => {
    api.getPreview.mockResolvedValue({ kind: 'pcb', revision: 'rev-1', circuitJson: [
      { type: 'source_component', source_component_id: 'sc-r1', name: 'R1' },
      { type: 'pcb_component', pcb_component_id: 'pcb-r1', source_component_id: 'sc-r1' },
    ] })
    api.getNets.mockResolvedValue({
      revision: 'rev-1',
      nets: [{
        id: 'net1', name: 'SENSE', names: ['SENSE'], sourceTraceIds: ['st-sense'],
        pins: [{ sourcePortId: 'sp-r1-2', pinName: 'pin2', sourceComponentId: 'sc-r1', componentName: 'R1', pcbPortId: 'pp-1', routed: true }],
        schematicTraces: [], copperTraces: [], vias: [], simulationSignals: [], routing: 'not-applicable',
      }],
      uncorrelatedSimulationSignals: [],
      limitations: [],
    })

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /LED Board TSX project/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Nets 1/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Focus footprint' }))

    expect(screen.getByRole('tab', { name: 'PCB' })).toHaveAttribute('aria-selected', 'true')
    await screen.findByTestId('pcb-viewer')
    await waitFor(() => expect(pcbViewer.focusPcbComponent).toHaveBeenCalledWith('pcb-r1'))
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
      .mockResolvedValueOnce({ revision: 'rev-1', status: 'not_configured', experiments: [], signals: [], operatingPoints: [], sweeps: [], analyses: [], diagnostics: [], notEvaluated: [] })
      .mockResolvedValue({
        revision: 'rev-2', status: 'complete', experiments: [{ id: 'exp-1', name: 'Transient', type: 'transient' }],
        signals: [{ id: 'trace-1', name: 'OUT', unit: 'V', netId: 'net-1', samples: [{ x: 0, y: 0 }, { x: 1, y: 5 }] }],
        operatingPoints: [], sweeps: [], analyses: [], diagnostics: [], notEvaluated: [],
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
    expect(screen.getByRole('img', { name: 'OUT waveform' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Zoom in OUT' })).toBeEnabled()
  })

  it('shows supplier stock and price for a component that carries an LCSC part number', async () => {
    api.getPreview.mockResolvedValue({ kind: 'schematic', revision: 'rev-1', circuitJson: [
      { type: 'source_component', source_component_id: 'sc-r1', name: 'R1', ftype: 'simple_resistor', supplier_part_numbers: { jlcpcb: ['C25804'] } },
    ] })
    api.getComponentSourcing.mockResolvedValue({
      configured: true, provider: 'jlcsearch',
      part: { lcscPartNumber: 'C25804', manufacturerPartNumber: '0603WAF1002', package: '0603', stockQuantity: 912345, unitPriceUsd: 0.002, isBasicPart: true },
    })

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /LED Board TSX project/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Components 1/ }))

    await waitFor(() => expect(api.getComponentSourcing).toHaveBeenCalledWith('C25804'))
    const inspector = screen.getByRole('complementary', { name: 'Component inspector' })
    expect(within(inspector).getByText('0603WAF1002')).toBeInTheDocument()
    expect(within(inspector).getByText('912,345')).toBeInTheDocument()
    expect(within(inspector).getByText('$0.002')).toBeInTheDocument()
    expect(within(inspector).getByText('Basic part')).toBeInTheDocument()
  })

  it('shows each project assertion result in the manufacturing dialog', async () => {
    api.getAssertionCheck.mockResolvedValue({
      configured: true, revision: 'rev-1', previewRevision: 'rev-1',
      report: {
        results: [
          { id: 'net-connected-GND', status: 'pass', message: "Net 'GND' connects 4 component pins; copper routing is routed." },
          { id: 'max-dissipation', status: 'fail', message: 'Calculated dissipation is 1.4 W, above the limit of 1 W.' },
          { id: 'max-component-cost', status: 'not-evaluated', message: 'Component cost budget of $12 could not be checked: no component sourcing provider is configured.' },
        ],
        passed: 1, failed: 1, notEvaluated: 1, baselineRevision: 'rev-0abcdef0',
      },
    })

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /LED Board TSX project/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Rule checks · Manufacturing/ }))

    const assertions = await screen.findByRole('region', { name: 'Project assertions' })
    expect(within(assertions).getByText('1 passed · 1 failed · 1 not evaluated · baseline rev-0abc')).toBeInTheDocument()
    expect(within(assertions).getByText(/copper routing is routed/)).toBeInTheDocument()
    expect(within(assertions).getByText(/above the limit of 1 W/)).toBeInTheDocument()
    expect(within(assertions).getByText(/no component sourcing provider is configured/)).toBeInTheDocument()
  })

  it('estimates component cost for a board quantity in the manufacturing dialog', async () => {
    api.getBomCost.mockResolvedValue({
      configured: true, provider: 'jlcsearch', revision: 'rev-1', boards: 1,
      lines: [{ name: 'R1, R2', quantity: 2, lcscPartNumber: 'C25804', unitPriceUsd: 0.002, extendedPriceUsd: 0.004, stockQuantity: 912345, isBasicPart: true }],
      unpriced: [{ name: 'J1', reason: 'Circuit JSON records no LCSC part number for this component.' }],
      componentCostUsd: 0.004,
      limitations: ['Component cost only. Board fabrication, assembly, tooling, shipping, and taxes are not included.'],
    })

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /LED Board TSX project/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Rule checks · Manufacturing/ }))

    expect(await screen.findByText('$0.004 for 1 board · 1 priced line')).toBeInTheDocument()
    expect(screen.getByText('R1, R2 ×2')).toBeInTheDocument()
    expect(screen.getByText('Circuit JSON records no LCSC part number for this component.')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Board quantity'), { target: { value: '25' } })
    await waitFor(() => expect(api.getBomCost).toHaveBeenCalledWith('led-1', 25))
  })

  it('shows the DC operating point, sweeps, and power from the build', async () => {
    api.getSimulation.mockResolvedValue({
      revision: 'rev-1', status: 'complete',
      experiments: [{ id: 'exp-1', name: 'Operating point', type: 'spice_dc_operating_point' }, { id: 'exp-2', name: 'AC', type: 'spice_ac_analysis' }],
      signals: [],
      operatingPoints: [
        { id: 'opv1', name: 'VOUT', unit: 'V', value: 3.3, netId: 'net-1' },
        { id: 'opc1', name: 'Supply', unit: 'A', value: 0.25 },
      ],
      sweeps: [{
        id: 'ac1', name: 'VOUT', kind: 'ac', unit: 'V', xLabel: 'Frequency (Hz)', netId: 'net-1',
        samples: [{ x: 100, y: 1 }, { x: 1000, y: 0.5 }],
        magnitudeDb: [{ x: 100, y: 0 }, { x: 1000, y: -6.021 }],
        phaseDeg: [{ x: 100, y: 0 }, { x: 1000, y: -90 }],
      }],
      analyses: [{ type: 'spice_ac_analysis', experiments: 1, resultCount: 1 }],
      diagnostics: [],
      notEvaluated: [{ analysis: 'Monte Carlo tolerance analysis', reason: 'tscircuit emits no Monte Carlo elements in Circuit JSON. Component tolerance spread is not evaluated.' }],
    })
    api.getPower.mockResolvedValue({
      revision: 'rev-1', status: 'partial',
      assumptions: ['IPC-2221 current capacity at a 10 degree Celsius temperature rise.'],
      traceCapacity: [{ pcbTraceId: 'pt-1', widthMm: 0.15, layers: ['top'], maxCurrentA: 0.64 }],
      narrowestTrace: { pcbTraceId: 'pt-1', widthMm: 0.15, layers: ['top'], maxCurrentA: 0.64 },
      nodeVoltages: [{ name: 'VOUT', voltageV: 3.3, netId: 'net-1' }],
      branchCurrents: [{ name: 'Supply', currentA: 0.25, componentName: 'V1' }],
      componentPower: [{ sourceComponentId: 'sc-r2', name: 'R2', ftype: 'simple_resistor', dissipationW: 0.0495, method: 'I2R' }],
      supplyLoads: [{ sourceComponentId: 'sc-v1', name: 'V1', currentA: 0.25, voltageV: 5, powerW: 1.25 }],
      traceLoads: [{ pcbTraceId: 'pt-1', netId: 'net-1', netName: 'VCC', currentA: 0.8, maxCurrentA: 0.64, utilization: 1.25, status: 'over-capacity' }],
      totalSupplyCurrentA: 0.25,
      totalDissipationW: 0.0495,
      notEvaluated: [{ quantity: 'Regulator loading', reason: 'Requires a regulator model and its declared limits, neither of which is present in Circuit JSON.' }],
    })

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /LED Board TSX project/ }))
    fireEvent.click(screen.getByRole('tab', { name: 'Simulation' }))

    const operatingPoint = await screen.findByRole('region', { name: 'DC operating point' })
    expect(within(operatingPoint).getByText('3.3 V · net net-1')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Power analysis' })).getByText('0.25 A')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'VOUT AC sweep' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'VOUT magnitude waveform' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'VOUT phase waveform' })).toBeInTheDocument()
    expect(screen.getByText('0.0495 W · I²R')).toBeInTheDocument()
    expect(screen.getByText(/0.8 A of 0.64 A \(125%\)/)).toBeInTheDocument()
    expect(screen.getByText(/over capacity/)).toBeInTheDocument()
    expect(screen.getByText('Monte Carlo tolerance analysis')).toBeInTheDocument()
    expect(screen.getByText('Regulator loading')).toBeInTheDocument()
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
    expect(screen.getByText(/kept in this project’s Git repository/)).toBeInTheDocument()
    expect(screen.getByText(/No retained build summary for revision rev-2/)).toBeInTheDocument()
    fireEvent.click(screen.getByText('fedcba09').closest('button')!)
    fireEvent.click(screen.getByRole('button', { name: 'Restore selected revision' }))

    await waitFor(() => expect(api.restoreProjectRevision).toHaveBeenCalledWith('led-1', 'rev-2', 'rev-1'))
    expect(await screen.findByLabelText('TSX source editor')).toHaveValue('export default () => <board />')
  })

  it('shows what changed in the design between two builds', async () => {
    api.compareProjectRevisions.mockResolvedValue({
      from: 'rev-2', to: 'rev-1',
      files: [],
      design: {
        available: true,
        board: [{ property: 'widthMm', before: 26, after: 30 }],
        components: {
          added: [{ name: 'C1', value: '100nF', pinCount: 2 }],
          removed: [{ name: 'R3', pinCount: 2 }],
          changed: [{ name: 'R1', changes: [{ property: 'value', before: '10kΩ', after: '22kΩ' }] }],
        },
        nets: { added: [], removed: [], changed: [{ name: 'SENSE', changes: [{ property: 'routing', before: 'unrouted', after: 'routed' }] }] },
        counts: [{ metric: 'pcbTraces', before: 0, after: 3 }],
        simulation: [{ property: 'operatingPoints', before: 0, after: 2 }],
        limitations: ['Rendered schematic, PCB, and 3D images are not compared; this is a structural comparison of Circuit JSON.'],
      },
    })

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /LED Board TSX project/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'History' }))

    const design = await screen.findByRole('region', { name: 'Design changes' })
    expect(within(design).getByText('26 → 30')).toBeInTheDocument()
    expect(within(design).getByText('Added: C1 (100nF)')).toBeInTheDocument()
    expect(within(design).getByText('Removed: R3')).toBeInTheDocument()
    expect(within(design).getByText('value: 10kΩ → 22kΩ')).toBeInTheDocument()
    expect(within(design).getByText('routing: unrouted → routed')).toBeInTheDocument()
    expect(within(design).getByText('0 → 3')).toBeInTheDocument()
    expect(within(design).getByText('0 → 2')).toBeInTheDocument()
    expect(within(design).getByText(/Rendered schematic, PCB, and 3D images are not compared/)).toBeInTheDocument()
  })

  it('shows selected-profile preflight checks before manufacturing export', async () => {
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /LED Board\s*TSX project/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Rule checks/ }))

    expect(await screen.findByRole('dialog', { name: 'Manufacturing preflight' })).toBeInTheDocument()
    expect(await screen.findByText('Not evaluated')).toBeInTheDocument()
    expect(await screen.findByText(/no validator result confirms this check passed/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Fabricator rule profile'), { target: { value: 'jlcpcb-2layer-1oz' } })
    await waitFor(() => expect(api.getManufacturingPreflight).toHaveBeenCalledWith('led-1', 'jlcpcb-2layer-1oz'))
  })
})
