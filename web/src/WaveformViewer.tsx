import { useState, type MouseEvent } from 'react'

type Signal = {
  id: string
  name: string
  unit: 'V' | 'A'
  netId?: string
  samples: Array<{ x: number; y: number }>
}

const plot = { left: 40, right: 580, top: 12, bottom: 122 }

export function WaveformViewer({ signals }: { signals: Signal[] }) {
  const [visible, setVisible] = useState<Record<string, boolean>>({})
  return <div className="waveform-list">
    {signals.map((signal) => <Waveform signal={signal} key={signal.id} visible={visible[signal.id] !== false} onVisibilityChange={(shown) => setVisible((current) => ({ ...current, [signal.id]: shown }))} />)}
  </div>
}

function Waveform({ signal, visible, onVisibilityChange }: { signal: Signal; visible: boolean; onVisibilityChange: (visible: boolean) => void }) {
  const xs = signal.samples.map(({ x }) => x)
  const ys = signal.samples.map(({ y }) => y)
  const fullStart = xs.length ? xs.reduce((minimum, x) => Math.min(minimum, x), Infinity) : 0
  const lastSampleTime = xs.length ? xs.reduce((maximum, x) => Math.max(maximum, x), -Infinity) : 1
  const fullEnd = Math.max(fullStart + 1, lastSampleTime)
  const [range, setRange] = useState<[number, number]>([fullStart, fullEnd])
  const [cursor, setCursor] = useState<number | null>(null)
  const span = range[1] - range[0] || 1
  const yMin = ys.reduce((minimum, y) => Math.min(minimum, y), 0)
  const yMax = ys.reduce((maximum, y) => Math.max(maximum, y), 0)
  const yPadding = (yMax - yMin || 1) * 0.08
  const valueToY = (value: number) => plot.bottom - ((value - (yMin - yPadding)) / (yMax - yMin + 2 * yPadding)) * (plot.bottom - plot.top)
  const sampleValue = (time: number) => {
    let before = signal.samples[0]
    let after = signal.samples.at(-1)
    for (const sample of signal.samples) {
      if (sample.x <= time) before = sample
      if (sample.x >= time) { after = sample; break }
    }
    if (!before || !after) return null
    if (after.x === before.x) return before.y
    return before.y + (after.y - before.y) * ((time - before.x) / (after.x - before.x))
  }
  const visibleSamples = signal.samples.filter((sample) => sample.x >= range[0] && sample.x <= range[1])
  const stride = Math.max(1, Math.ceil(visibleSamples.length / 1500))
  const points = visibleSamples.filter((_, index) => index % stride === 0 || index === visibleSamples.length - 1).map(({ x, y }) => `${plot.left + ((x - range[0]) / span) * (plot.right - plot.left)},${valueToY(y)}`).join(' ')
  const timeAt = (clientX: number, bounds: DOMRect) => range[0] + Math.max(0, Math.min(1, ((clientX - bounds.left) * (600 / (bounds.width || 600)) - plot.left) / (plot.right - plot.left))) * span
  const zoom = (factor: number) => {
    const nextSpan = Math.max((fullEnd - fullStart) / 100, Math.min(fullEnd - fullStart, span * factor))
    const center = (range[0] + range[1]) / 2
    const start = Math.max(fullStart, Math.min(fullEnd - nextSpan, center - nextSpan / 2))
    setRange([start, start + nextSpan])
  }
  const pan = (direction: -1 | 1) => {
    const start = Math.max(fullStart, Math.min(fullEnd - span, range[0] + direction * span * 0.25))
    setRange([start, start + span])
  }
  const handlePlotClick = (event: MouseEvent<SVGSVGElement>) => setCursor(timeAt(event.clientX, event.currentTarget.getBoundingClientRect()))
  const cursorValue = cursor === null ? null : sampleValue(cursor)

  return <section className="waveform" aria-label={`${signal.name} signal`}>
    <div className="waveform-label"><strong>{signal.name}</strong><span>{signal.netId ? `Net ${signal.netId}` : 'Unmapped net'} · {signal.unit}</span></div>
    <div className="waveform-controls">
      <label><input type="checkbox" aria-label={`Show ${signal.name}`} checked={visible} onChange={(event) => onVisibilityChange(event.target.checked)} /> Show</label>
      <button type="button" aria-label={`Pan earlier ${signal.name}`} onClick={() => pan(-1)} disabled={range[0] <= fullStart}>←</button>
      <button type="button" aria-label={`Zoom out ${signal.name}`} onClick={() => zoom(2)} disabled={span >= fullEnd - fullStart}>−</button>
      <button type="button" aria-label={`Zoom in ${signal.name}`} onClick={() => zoom(0.5)}>+</button>
      <button type="button" aria-label={`Pan later ${signal.name}`} onClick={() => pan(1)} disabled={range[1] >= fullEnd}>→</button>
      <button type="button" onClick={() => { setRange([fullStart, fullEnd]); setCursor(null) }}>Reset</button>
      <span className="waveform-range" aria-label={`Time range for ${signal.name}`}>{formatTime(range[0])}–{formatTime(range[1])} ms</span>
    </div>
    {visible && <>
      <svg viewBox="0 0 600 150" role="img" aria-label={`${signal.name} waveform`} preserveAspectRatio="none" onClick={handlePlotClick}>
        <path className="waveform-grid" d={`M${plot.left} 30H${plot.right}M${plot.left} 67H${plot.right}M${plot.left} 104H${plot.right}M175 ${plot.top}V${plot.bottom}M310 ${plot.top}V${plot.bottom}M445 ${plot.top}V${plot.bottom}`} />
        {points && <polyline className="waveform-line" points={points} />}
        {cursor !== null && cursor >= range[0] && cursor <= range[1] && <path className="waveform-cursor" d={`M${plot.left + ((cursor - range[0]) / span) * (plot.right - plot.left)} ${plot.top}V${plot.bottom}`} />}
      </svg>
      <div className="waveform-axis"><span>{formatTime(range[0])} ms</span><span>{formatTime(range[1])} ms</span><span>{signal.unit}</span></div>
      <output className="waveform-measurement" aria-live="polite">{cursorValue === null ? 'Click the plot to place a measurement cursor' : `Cursor: ${formatTime(cursor!)} ms · ${formatValue(cursorValue)} ${signal.unit}`}</output>
    </>}
  </section>
}

function formatTime(value: number) { return Number(value.toPrecision(4)).toString() }
function formatValue(value: number) { return Number(value.toPrecision(4)).toString() }
