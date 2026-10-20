import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { PCBViewer, usePcbViewerController, type ViewSchematicComponentEvent } from '@tscircuit/pcb-viewer'
import { getPcbComponentId } from './componentInspector'

export type PcbCircuitJson = NonNullable<Parameters<typeof PCBViewer>[0]['circuitJson']>

export default function PcbPreview({ circuitJson, selectedSourceComponentId, onViewSchematicComponent }: {
  circuitJson: PcbCircuitJson
  selectedSourceComponentId: string
  onViewSchematicComponent: (event: ViewSchematicComponentEvent) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(620)
  const { controller, focusPcbComponent } = usePcbViewerController()

  useEffect(() => {
    if (!selectedSourceComponentId) return
    const pcbComponentId = getPcbComponentId(circuitJson, selectedSourceComponentId)
    if (pcbComponentId) focusPcbComponent(pcbComponentId)
  }, [circuitJson, focusPcbComponent, selectedSourceComponentId])

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    const updateHeight = () => setHeight(Math.min(Math.max(container.clientHeight, 620), window.innerHeight))
    updateHeight()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateHeight)
    observer?.observe(container)
    window.addEventListener('resize', updateHeight)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', updateHeight)
    }
  }, [])

  return <div ref={containerRef} className="pcb-preview"><PCBViewer circuitJson={circuitJson} height={height} controller={controller} onViewSchematicComponent={onViewSchematicComponent} /></div>
}
