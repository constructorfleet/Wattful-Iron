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
  const [firstCursor, setFirstCursor] = useState<number | null>(null)
  const [secondCursor, setSecondCursor] = useState<number | null>(null)
  const [placingSecondCursor, setPlacingSecondCursor] = useState(false)
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
  const handlePlotClick = (event: MouseEvent<SVGSVGElement>) => {
    const time = timeAt(event.clientX, event.currentTarget.getBoundingClientRect())
    if (placingSecondCursor && firstCursor !== null) {
      setSecondCursor(time)
      setPlacingSecondCursor(false)
    } else {
      setFirstCursor(time)
      setSecondCursor(null)
    }
  }
  const firstValue = firstCursor === null ? null : sampleValue(firstCursor)
  const secondValue = secondCursor === null ? null : sampleValue(secondCursor)
  const deltaTime = firstCursor === null || secondCursor === null ? null : Math.abs(secondCursor - firstCursor)
  const deltaValue = firstValue === null || secondValue === null ? null : Math.abs(secondValue - firstValue)
  const frequency = deltaTime && deltaTime > 0 ? 1000 / deltaTime : null
  const measurement = firstValue === null
    ? 'Click the plot to place a measurement cursor'
    : secondValue === null
      ? `${placingSecondCursor ? 'Cursor A' : 'Cursor'}: ${formatTime(firstCursor!)} ms · ${formatValue(firstValue)} ${signal.unit}${placingSecondCursor ? ' · Click the plot to place cursor B' : ''}`
      : `Δt: ${formatTime(deltaTime!)} ms · Δ${signal.unit}: ${formatValue(deltaValue!)} ${signal.unit} · ${frequency === null ? 'Frequency unavailable' : formatFrequency(frequency)}`
  const downloadCsv = () => {
    const rows = [`time_ms,value_${signal.unit}`, ...signal.samples.map(({ x, y }) => `${csvValue(x)},${csvValue(y)}`)]
    const blob = new Blob([`${rows.join('\n')}\n`], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${safeFilename(signal.name)}.csv`
    link.hidden = true
    document.body.append(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return <section className="waveform" aria-label={`${signal.name} signal`}>
    <div className="waveform-label"><strong>{signal.name}</strong><span>{signal.netId ? `Net ${signal.netId}` : 'Unmapped net'} · {signal.unit}</span></div>
    <div className="waveform-controls">
      <label><input type="checkbox" aria-label={`Show ${signal.name}`} checked={visible} onChange={(event) => onVisibilityChange(event.target.checked)} /> Show</label>
      <button type="button" aria-label={`Pan earlier ${signal.name}`} onClick={() => pan(-1)} disabled={range[0] <= fullStart}>←</button>
      <button type="button" aria-label={`Zoom out ${signal.name}`} onClick={() => zoom(2)} disabled={span >= fullEnd - fullStart}>−</button>
      <button type="button" aria-label={`Zoom in ${signal.name}`} onClick={() => zoom(0.5)}>+</button>
      <button type="button" aria-label={`Pan later ${signal.name}`} onClick={() => pan(1)} disabled={range[1] >= fullEnd}>→</button>
      <button type="button" title="Place cursor B" aria-label={`Place second cursor for ${signal.name}`} aria-pressed={placingSecondCursor} disabled={firstCursor === null} onClick={() => setPlacingSecondCursor(true)}>B</button>
      <button type="button" aria-label={`Download ${signal.name} CSV`} onClick={downloadCsv}>CSV</button>
      <button type="button" onClick={() => { setRange([fullStart, fullEnd]); setFirstCursor(null); setSecondCursor(null); setPlacingSecondCursor(false) }}>Reset</button>
      <output className="waveform-range" aria-label={`Time range for ${signal.name}`}>{formatTime(range[0])}–{formatTime(range[1])} ms</output>
    </div>
    {visible && <>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: placing the first cursor has no keyboard equivalent yet; tracked in docs/linting.md */}
      <svg viewBox="0 0 600 150" role="img" aria-label={`${signal.name} waveform`} preserveAspectRatio="none" onClick={handlePlotClick}>
        <path className="waveform-grid" d={`M${plot.left} 30H${plot.right}M${plot.left} 67H${plot.right}M${plot.left} 104H${plot.right}M175 ${plot.top}V${plot.bottom}M310 ${plot.top}V${plot.bottom}M445 ${plot.top}V${plot.bottom}`} />
        {points && <polyline className="waveform-line" points={points} />}
        {firstCursor !== null && firstCursor >= range[0] && firstCursor <= range[1] && <path className="waveform-cursor" d={`M${plot.left + ((firstCursor - range[0]) / span) * (plot.right - plot.left)} ${plot.top}V${plot.bottom}`} />}
        {secondCursor !== null && secondCursor >= range[0] && secondCursor <= range[1] && <path className="waveform-cursor waveform-cursor-secondary" d={`M${plot.left + ((secondCursor - range[0]) / span) * (plot.right - plot.left)} ${plot.top}V${plot.bottom}`} />}
      </svg>
      <div className="waveform-axis"><span>{formatTime(range[0])} ms</span><span>{formatTime(range[1])} ms</span><span>{signal.unit}</span></div>
      <output className="waveform-measurement" aria-live="polite">{measurement}</output>
    </>}
  </section>
}

function formatTime(value: number) { return Number(value.toPrecision(4)).toString() }
function formatValue(value: number) { return Number(value.toPrecision(4)).toString() }
function formatFrequency(value: number) {
  if (value >= 1_000_000) return `${formatValue(value / 1_000_000)} MHz`
  if (value >= 1_000) return `${formatValue(value / 1_000)} kHz`
  return `${formatValue(value)} Hz`
}
function csvValue(value: number) { return Number.isFinite(value) ? String(value) : '' }
function safeFilename(value: string) { return value.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-|-$/g, '') || 'signal' }
