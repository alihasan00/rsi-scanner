import { memo, useCallback, useEffect, useMemo, useRef } from 'react'
import type { Ref } from 'react'
import { Layer, Line, Stage } from 'react-konva'
import type Konva from 'konva'
import type { DrawingObject, DrawingTool, Point } from '../types'

interface DrawingCanvasProps {
  width: number
  height: number
  tool: DrawingTool
  objects: DrawingObject[]
  onBegin: (point: Point) => void
  onExtend: (point: Point) => void
  onEnd: () => void
  onErase: (id: string) => void
  stageRef: Ref<Konva.Stage>
}

type KonvaPointerEvent = Konva.KonvaEventObject<PointerEvent>

interface DrawingLineProps {
  object: DrawingObject
  listening: boolean
}

const DrawingLine = memo(function DrawingLine({ object, listening }: DrawingLineProps) {
  const points = useMemo(
    () => object.points.flatMap((point) => [point.x, point.y]),
    [object.points],
  )

  return (
    <Line
      id={object.id}
      points={points}
      stroke={object.color}
      strokeWidth={object.size}
      lineCap="round"
      lineJoin="round"
      dash={object.type === 'trendline' ? [6, 4] : undefined}
      tension={object.type === 'brush' ? 0.2 : 0}
      hitStrokeWidth={Math.max(20, object.size * 4)}
      listening={listening}
    />
  )
})

function DrawingCanvasImpl({
  width,
  height,
  tool,
  objects,
  onBegin,
  onExtend,
  onEnd,
  onErase,
  stageRef,
}: DrawingCanvasProps) {
  const layerRef = useRef<Konva.Layer>(null)
  const pointerActiveRef = useRef(false)
  const activeToolRef = useRef<DrawingTool>(null)
  const pendingPointRef = useRef<Point | null>(null)
  const moveFrameRef = useRef<number | null>(null)
  const onExtendRef = useRef(onExtend)
  const onEndRef = useRef(onEnd)

  useEffect(() => {
    onExtendRef.current = onExtend
  }, [onExtend])

  useEffect(() => {
    onEndRef.current = onEnd
  }, [onEnd])

  const flushPendingMove = useCallback(() => {
    if (moveFrameRef.current !== null) {
      cancelAnimationFrame(moveFrameRef.current)
      moveFrameRef.current = null
    }

    const point = pendingPointRef.current
    pendingPointRef.current = null
    if (point) onExtendRef.current(point)
  }, [])

  const scheduleMove = useCallback((point: Point) => {
    pendingPointRef.current = point
    if (moveFrameRef.current !== null) return

    moveFrameRef.current = requestAnimationFrame(() => {
      moveFrameRef.current = null
      const pendingPoint = pendingPointRef.current
      pendingPointRef.current = null
      if (pendingPoint && pointerActiveRef.current) {
        onExtendRef.current(pendingPoint)
      }
    })
  }, [])

  const tryErase = useCallback((stage: Konva.Stage) => {
    const layer = layerRef.current
    const pos = stage.getPointerPosition()
    if (!layer || !pos) return
    const shape = layer.getIntersection(pos)
    const id = shape?.id()
    if (id) onErase(id)
  }, [onErase])

  const handleDown = useCallback((e: KonvaPointerEvent) => {
    const stage = e.target.getStage()
    if (!stage || !tool) return
    pointerActiveRef.current = true
    activeToolRef.current = tool
    if (tool === 'eraser') {
      tryErase(stage)
      return
    }
    const pos = stage.getPointerPosition()
    if (pos) onBegin({ x: pos.x, y: pos.y })
  }, [tool, onBegin, tryErase])

  const handleMove = useCallback((e: KonvaPointerEvent) => {
    const activeTool = activeToolRef.current
    if (!pointerActiveRef.current || !activeTool) return
    const stage = e.target.getStage()
    if (!stage) return
    if (activeTool === 'eraser') {
      tryErase(stage)
      return
    }
    const pos = stage.getPointerPosition()
    if (pos) scheduleMove({ x: pos.x, y: pos.y })
  }, [scheduleMove, tryErase])

  const handleUp = useCallback(() => {
    if (!pointerActiveRef.current) return
    pointerActiveRef.current = false
    const activeTool = activeToolRef.current
    activeToolRef.current = null
    if (activeTool !== 'eraser') {
      flushPendingMove()
      onEndRef.current()
    }
  }, [flushPendingMove])

  useEffect(() => () => {
    const shouldEndStroke = pointerActiveRef.current && activeToolRef.current !== 'eraser'
    pointerActiveRef.current = false
    activeToolRef.current = null
    flushPendingMove()
    if (shouldEndStroke) onEndRef.current()
  }, [flushPendingMove])

  return (
    <Stage
      ref={stageRef}
      width={width}
      height={height}
      className="drawing-canvas"
      onPointerDown={handleDown}
      onPointerMove={handleMove}
      onPointerUp={handleUp}
      onPointerLeave={handleUp}
      onPointerCancel={handleUp}
    >
      <Layer ref={layerRef}>
        {objects.map((obj) => (
          <DrawingLine
            key={obj.id}
            object={obj}
            listening={tool === 'eraser'}
          />
        ))}
      </Layer>
    </Stage>
  )
}

export const DrawingCanvas = memo(DrawingCanvasImpl)
