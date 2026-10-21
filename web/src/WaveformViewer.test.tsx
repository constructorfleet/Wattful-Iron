import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WaveformViewer } from './WaveformViewer'

const signals = [{
  id: 'vout', name: 'VOUT', unit: 'V' as const, netId: 'net-vout',
  samples: [{ x: 0, y: 0 }, { x: 5, y: 2.5 }, { x: 10, y: 5 }],
}]

describe('waveform viewer', () => {
  beforeEach(cleanup)
  it('reports a time and interpolated signal value at the measurement cursor', () => {
    render(<WaveformViewer signals={signals} />)
    const plot = screen.getByRole('img', { name: 'VOUT waveform' })
    plot.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 600, bottom: 150, width: 600, height: 150, toJSON: () => ({}) })

    fireEvent.click(plot, { clientX: 310, clientY: 75 })

    expect(screen.getByText('Cursor: 5 ms · 2.5 V')).toBeInTheDocument()
  })

  it('zooms and pans the displayed time range without changing simulation samples', () => {
    render(<WaveformViewer signals={signals} />)
    expect(screen.getByLabelText('Time range for VOUT')).toHaveTextContent('0–10 ms')

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in VOUT' }))
    expect(screen.getByLabelText('Time range for VOUT')).toHaveTextContent('2.5–7.5 ms')
    fireEvent.click(screen.getByRole('button', { name: 'Pan later VOUT' }))
    expect(screen.getByLabelText('Time range for VOUT')).toHaveTextContent('3.75–8.75 ms')
    expect(signals[0].samples).toHaveLength(3)
  })

  it('lets users hide a signal from the waveform view', () => {
    render(<WaveformViewer signals={signals} />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show VOUT' }))
    expect(screen.queryByRole('img', { name: 'VOUT waveform' })).not.toBeInTheDocument()
  })

  it('measures elapsed time, voltage change, and frequency between two cursors', () => {
    render(<WaveformViewer signals={signals} />)
    const plot = screen.getByRole('img', { name: 'VOUT waveform' })
    plot.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 600, bottom: 150, width: 600, height: 150, toJSON: () => ({}) })

    fireEvent.click(plot, { clientX: 310, clientY: 75 })
    fireEvent.click(screen.getByRole('button', { name: 'Place second cursor for VOUT' }))
    fireEvent.click(plot, { clientX: 445, clientY: 75 })

    expect(screen.getByText('Δt: 2.5 ms · ΔV: 1.25 V · 400 Hz')).toBeInTheDocument()
  })

  it('does not report a frequency for a zero-width cursor interval', () => {
    render(<WaveformViewer signals={signals} />)
    const plot = screen.getByRole('img', { name: 'VOUT waveform' })
    plot.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 600, bottom: 150, width: 600, height: 150, toJSON: () => ({}) })

    fireEvent.click(plot, { clientX: 310, clientY: 75 })
    fireEvent.click(screen.getByRole('button', { name: 'Place second cursor for VOUT' }))
    fireEvent.click(plot, { clientX: 310, clientY: 75 })

    expect(screen.getByText('Δt: 0 ms · ΔV: 0 V · Frequency unavailable')).toBeInTheDocument()
  })

  it('exports the waveform as a downloadable CSV', async () => {
    vi.useFakeTimers()
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:waveform')
    const revokeObjectURL = vi.fn()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL })
    render(<WaveformViewer signals={signals} />)

    fireEvent.click(screen.getByRole('button', { name: 'Download VOUT CSV' }))

    expect(createObjectURL).toHaveBeenCalledOnce()
    const blob = createObjectURL.mock.calls[0]?.[0] as Blob
    expect(blob.type).toBe('text/csv;charset=utf-8')
    expect(await blob.text()).toBe('time_ms,value_V\n0,0\n5,2.5\n10,5\n')
    expect(click).toHaveBeenCalledOnce()
    expect(click.mock.instances[0]).toMatchObject({ download: 'VOUT.csv', href: 'blob:waveform' })
    vi.runOnlyPendingTimers()
    expect(revokeObjectURL).toHaveBeenCalledOnce()
    click.mockRestore()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
})
