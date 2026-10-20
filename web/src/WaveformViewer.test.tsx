import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
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
})
