import { useCallback, useEffect, useRef, useState } from 'react'
import type { DrawingObject, DrawingTool, Point } from '../types'

interface HistoryFlags {
  canUndo: boolean
  canRedo: boolean
}

function flagsFor(index: number, historyLength: number): HistoryFlags {
  return { canUndo: index > 0, canRedo: index < historyLength - 1 }
}

interface UseDrawingToolsOptions {
  active: boolean
}

export function useDrawingTools({ active }: UseDrawingToolsOptions) {
  const [tool, setTool] = useState<DrawingTool>(null)
  const [color, setColor] = useState('#29ffb8')
  const [size, setSize] = useState(3)
  const [objects, setObjects] = useState<DrawingObject[]>([])
  const [historyFlags, setHistoryFlags] = useState<HistoryFlags>({ canUndo: false, canRedo: false })

  const objectsRef = useRef<DrawingObject[]>([])
  const historyRef = useRef<DrawingObject[][]>([[]])
  const historyIndexRef = useRef(0)
  const drawingRef = useRef<DrawingObject | null>(null)

  // Applies a new object list, optionally recording it as an undo point.
  // Called directly (never from inside a setState updater) so it can safely
  // mutate the history refs without risking double-invocation under
  // React's dev-mode double-render checks.
  const applyObjects = useCallback((next: DrawingObject[], recordHistory: boolean) => {
    objectsRef.current = next
    setObjects(next)
    if (recordHistory) {
      const history = historyRef.current.slice(0, historyIndexRef.current + 1)
      history.push(next)
      historyRef.current = history
      historyIndexRef.current = history.length - 1
      setHistoryFlags(flagsFor(historyIndexRef.current, history.length))
    }
  }, [])

  const beginStroke = useCallback((point: Point) => {
    if (tool === 'brush') {
      drawingRef.current = { id: crypto.randomUUID(), type: 'brush', points: [point], color, size }
    } else if (tool === 'trendline') {
      drawingRef.current = { id: crypto.randomUUID(), type: 'trendline', points: [point, point], color, size }
    }
  }, [tool, color, size])

  const extendStroke = useCallback((point: Point) => {
    const current = drawingRef.current
    if (!current) return
    const updated: DrawingObject = current.type === 'brush'
      ? { ...current, points: [...current.points, point] }
      : { ...current, points: [current.points[0], point] }
    drawingRef.current = updated
    applyObjects([...objectsRef.current.filter((o) => o.id !== updated.id), updated], false)
  }, [applyObjects])

  const endStroke = useCallback(() => {
    const current = drawingRef.current
    drawingRef.current = null
    if (!current) return
    applyObjects([...objectsRef.current.filter((o) => o.id !== current.id), current], true)
  }, [applyObjects])

  const eraseObject = useCallback((id: string) => {
    const next = objectsRef.current.filter((o) => o.id !== id)
    if (next.length === objectsRef.current.length) return
    applyObjects(next, true)
  }, [applyObjects])

  const undo = useCallback(() => {
    if (historyIndexRef.current <= 0) return
    historyIndexRef.current -= 1
    const snapshot = historyRef.current[historyIndexRef.current]
    objectsRef.current = snapshot
    setObjects(snapshot)
    setHistoryFlags(flagsFor(historyIndexRef.current, historyRef.current.length))
  }, [])

  const redo = useCallback(() => {
    if (historyIndexRef.current >= historyRef.current.length - 1) return
    historyIndexRef.current += 1
    const snapshot = historyRef.current[historyIndexRef.current]
    objectsRef.current = snapshot
    setObjects(snapshot)
    setHistoryFlags(flagsFor(historyIndexRef.current, historyRef.current.length))
  }, [])

  const clear = useCallback(() => {
    applyObjects([], true)
  }, [applyObjects])

  const reset = useCallback(() => {
    objectsRef.current = []
    historyRef.current = [[]]
    historyIndexRef.current = 0
    drawingRef.current = null
    setTool(null)
    setObjects([])
    setHistoryFlags({ canUndo: false, canRedo: false })
  }, [])

  useEffect(() => {
    if (!active) return

    function handleKeydown(event: KeyboardEvent): void {
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return

      if (event.ctrlKey || event.metaKey) {
        if (event.key === 'z') {
          event.preventDefault()
          undo()
        } else if (event.key === 'y') {
          event.preventDefault()
          redo()
        }
        return
      }

      switch (event.key.toLowerCase()) {
        case 'b': setTool('brush'); break
        case 't': setTool('trendline'); break
        case 'e': setTool('eraser'); break
      }
    }

    window.addEventListener('keydown', handleKeydown)
    return () => window.removeEventListener('keydown', handleKeydown)
  }, [active, undo, redo])

  return {
    tool,
    setTool,
    color,
    setColor,
    size,
    setSize,
    objects,
    canUndo: historyFlags.canUndo,
    canRedo: historyFlags.canRedo,
    beginStroke,
    extendStroke,
    endStroke,
    eraseObject,
    undo,
    redo,
    clear,
    reset,
  }
}
