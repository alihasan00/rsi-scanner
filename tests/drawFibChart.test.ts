import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { RsiBar } from '../src/types'
import { drawFibChart } from '../src/lib/drawFibChart'
import { analyzeFibonacci } from '../src/lib/fibonacci'
import type { FibScale, FibSetup } from '../src/lib/fibonacci'

interface DrawCall {
  method: string
  args: unknown[]
  fillStyle: unknown
  strokeStyle: unknown
  globalAlpha: unknown
}

function recordingCanvas(width = 800, height = 520) {
  const calls: DrawCall[] = []
  const state: Record<string, unknown> = { globalAlpha: 1 }
  const stack: Record<string, unknown>[] = []
  const record = (method: string, args: unknown[]) => {
    calls.push({ method, args, fillStyle: state.fillStyle, strokeStyle: state.strokeStyle, globalAlpha: state.globalAlpha })
  }
  const context = new Proxy(state, {
    get(target, property) {
      if (property === 'save') return () => { stack.push({ ...state }); record('save', []) }
      if (property === 'restore') return () => {
        const saved = stack.pop()
        if (saved) {
          for (const key of Object.keys(state)) delete state[key]
          Object.assign(state, saved)
        }
        record('restore', [])
      }
      if (property in target) return target[String(property)]
      return (...args: unknown[]) => record(String(property), args)
    },
    set(target, property, value) {
      target[String(property)] = value
      return true
    },
  })
  const surface = { width: 0, height: 0, clientWidth: width, clientHeight: height, getContext: () => context }
  return { calls, surface, canvas: surface as unknown as HTMLCanvasElement }
}

function impulse(multiplier = 1, wide = false): RsiBar[] {
  const closes = [100, 102, 104, 106, 110, 106, 104, 102, wide ? 80 : 90, 100, 106, 112, 120, 118, 116, 114]
  return closes.map((close, index) => ({
    openTime: index * 60_000, closeTime: (index + 1) * 60_000 - 1,
    open: close * multiplier, high: (close + 1) * multiplier, low: (close - 1) * multiplier,
    close: close * multiplier, volume: 10, rsi: 50, isClosed: true,
  }))
}

function setupFor(bars: RsiBar[], scale: FibScale = 'linear'): FibSetup {
  const setup = analyzeFibonacci(bars, { scale }).setup
  if (!setup) throw new Error('Synthetic history must produce a Fib setup')
  return setup
}

function texts(calls: DrawCall[]): string[] {
  return calls.filter((call) => call.method === 'fillText').map((call) => String(call.args[0]))
}

function assertFiniteDrawing(calls: DrawCall[]) {
  expect(calls.flatMap((call) => call.args.flat()).filter((value) => typeof value === 'number').every(Number.isFinite)).toBe(true)
  expect(texts(calls).every((text) => !/NaN|Infinity/.test(text))).toBe(true)
  for (const call of calls.filter((item) => item.method === 'fillRect' || item.method === 'strokeRect')) {
    expect(Number(call.args[2])).toBeGreaterThanOrEqual(0)
    expect(Number(call.args[3])).toBeGreaterThanOrEqual(0)
  }
}

function anchorCoordinates(calls: DrawCall[]) {
  const start = calls.find((call) => call.method === 'moveTo' && call.strokeStyle === '#9C83C9')
  const end = calls.find((call) => call.method === 'lineTo' && call.strokeStyle === '#9C83C9')
  expect(start).toBeDefined()
  expect(end).toBeDefined()
  return { startY: Number(start!.args[1]), endY: Number(end!.args[1]) }
}

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
beforeEach(() => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { devicePixelRatio: 2 } })
})
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
  else Reflect.deleteProperty(globalThis, 'window')
})

describe('Fib chart rendering', () => {
  test('mobile candle previews stay finite without Fib levels while detail charts retain their grid', () => {
    const bars = impulse(1e-12)
    for (const scale of ['linear', 'log'] as const) {
      const setup = setupFor(bars, scale)
      const { canvas, calls, surface } = recordingCanvas()
      for (const [width, height, compact] of [[800, 520, false], [340, 240, true], [340, 420, false]] as const) {
        surface.clientWidth = width
        surface.clientHeight = height
        calls.length = 0
        drawFibChart(canvas, { bars, setup, compact, showReferenceGrid: true })
        expect(surface.width).toBe(width * 2)
        expect(surface.height).toBe(height * 2)
        assertFiniteDrawing(calls)
        const clip = calls.find((call) => call.method === 'rect')!
        expect(Number(clip.args[2])).toBeGreaterThan(100)
        expect(Number(clip.args[3])).toBeGreaterThan(100)
        expect(calls.filter((call) => call.method === 'strokeRect')).toHaveLength(bars.length)
        if (compact) {
          expect(texts(calls).some((text) => /Golden|E[1-3]|Stop|TP[1-4]|Runner|reference|Linear|Log/.test(text))).toBe(false)
          expect(calls.some((call) => call.method === 'fillRect' && call.fillStyle === 'rgba(242, 198, 109, 0.14)')).toBe(false)
          expect(calls.filter((call) => call.method === 'arc')).toHaveLength(2)
          expect(calls.filter((call) => call.method === 'fillText' && Number(call.args[1]) > Number(clip.args[0]) + Number(clip.args[2]))).toHaveLength(3)
          const widened = {
            ...setup, currentStop: setup.currentStop / 1e8,
            entries: setup.entries.map((entry) => ({ ...entry, price: entry.price * 1e8 })),
            targets: setup.targets.map((target) => ({ ...target, price: target.price * 1e8 })),
            levels: setup.levels.map((level) => ({ ...level, price: level.price * 1e8 })),
          }
          const distantLevels = recordingCanvas(width, height)
          drawFibChart(distantLevels.canvas, { bars, setup: widened, compact: true, showReferenceGrid: true })
          // Hidden trade/reference prices must never compress main-card candles.
          expect(distantLevels.calls.filter((call) => call.method === 'strokeRect').map((call) => call.args))
            .toEqual(calls.filter((call) => call.method === 'strokeRect').map((call) => call.args))
          expect(texts(distantLevels.calls)).toEqual(texts(calls))
        } else {
          expect(texts(calls)).toContain(`${scale === 'log' ? 'Log' : 'Linear'} · Golden pocket 0.618–0.666`)
        }
      }
    }
    const history = impulse()
    const setup = setupFor(history)
    const longer = [...history, ...Array.from({ length: 140 }, (_, index) => ({
      ...history.at(-1)!, openTime: (index + history.length) * 60_000,
      closeTime: (index + history.length + 1) * 60_000 - 1,
    }))]
    const { canvas, calls } = recordingCanvas(340, 240)
    drawFibChart(canvas, { bars: longer, setup, compact: true })
    const clip = calls.find((call) => call.method === 'rect')!
    const anchors = calls.filter((call) => call.method === 'arc')
    expect(anchors).toHaveLength(2)
    for (const anchor of anchors) {
      expect(Number(anchor.args[0])).toBeGreaterThan(Number(clip.args[0]))
      expect(Number(anchor.args[0])).toBeLessThan(Number(clip.args[0]) + Number(clip.args[2]))
    }
    // A partial history cannot fabricate an offscreen origin for its trendline.
    calls.length = 0
    drawFibChart(canvas, { bars: longer.slice(10), setup, compact: true })
    expect(calls.some((call) => call.method === 'arc')).toBe(false)
  })

  test('the golden pocket stays at 0.618–0.666 between the same rendered anchors on both price scales', () => {
    const bars = impulse()
    for (const scale of ['linear', 'log'] as const) {
      const setup = setupFor(bars, scale)
      for (const showReferenceGrid of [false, true]) {
        const { canvas, calls } = recordingCanvas()
        drawFibChart(canvas, { bars, setup, showReferenceGrid })
        const { startY, endY } = anchorCoordinates(calls)
        const pocket = calls.find((call) => call.method === 'fillRect' && call.fillStyle === 'rgba(242, 198, 109, 0.14)')!
        // Fib ratios interpolate in the chosen price scale, independent of padding.
        const pocketTop = 0.618 * startY + 0.382 * endY
        const pocketBottom = 0.666 * startY + 0.334 * endY
        expect(Number(pocket.args[1])).toBeCloseTo(pocketTop, 7)
        expect(Number(pocket.args[1]) + Number(pocket.args[3])).toBeCloseTo(pocketBottom, 7)
        const entryLine = calls.find((call) => call.method === 'moveTo' && call.strokeStyle === '#F2C66D')!
        expect(Number(entryLine.args[1])).toBeCloseTo(pocketTop, 7)
      }
    }
  })

  test('candles retain raw wick and body prices while only the provisional body is hollow', () => {
    const bars = impulse()
    bars[0] = { ...bars[0], open: 100, high: 107, low: 97, close: 103 }
    const setup = setupFor(bars)
    const live = {
      ...bars.at(-1)!, openTime: 960_000, closeTime: 1_019_999,
      open: 105, high: 107, low: 96, close: 100, isClosed: false,
    }
    const before = structuredClone(setup)
    const { canvas, calls } = recordingCanvas()
    drawFibChart(canvas, { bars: [...bars, live], setup })
    const { startY, endY } = anchorCoordinates(calls)
    const y = (price: number) => startY + (price - setup.start.price) / (setup.end.price - setup.start.price) * (endY - startY)
    const candleCall = (call: DrawCall) => call.strokeStyle === '#34D399' || call.strokeStyle === '#EF4444'
    const bodies = calls.filter((call) => call.method === 'fillRect' && candleCall(call))
    const wickTops = calls.filter((call) => call.method === 'moveTo' && candleCall(call))
    const wickBottoms = calls.filter((call) => call.method === 'lineTo' && candleCall(call))
    expect(bodies).toHaveLength(bars.length + 1)
    expect(bodies.slice(0, -1).every((call) => call.fillStyle === call.strokeStyle)).toBe(true)
    expect(bodies.at(-1)?.fillStyle).toBe('#1A1A1A')
    expect(bodies.at(-1)?.strokeStyle).toBe('#EF4444')
    expect(Number(wickTops.at(-1)?.args[1])).toBeCloseTo(y(live.high))
    expect(Number(wickBottoms.at(-1)?.args[1])).toBeCloseTo(y(live.low))
    expect(Number(bodies.at(-1)?.args[1])).toBeCloseTo(y(live.open))
    expect(Number(bodies.at(-1)?.args[3])).toBeCloseTo(y(live.close) - y(live.open))
    expect(Number(bodies[0].args[1])).toBeCloseTo(y(bars[0].close))
    expect(setup).toEqual(before)
  })

  test('enabling the reference grid adds distinctly labeled references without adding trade targets', () => {
    const bars = impulse()
    const setup = setupFor(bars)
    const { canvas, calls } = recordingCanvas()
    drawFibChart(canvas, { bars, setup })
    const defaultTargets = calls.filter((call) => call.method === 'fillText' && call.fillStyle === '#6EE7B7').map((call) => String(call.args[0]))
    expect(defaultTargets.map((text) => text.split(' ')[0]).sort()).toEqual(['Runner', 'TP1', 'TP2', 'TP3', 'TP4'])
    expect(calls.some((call) => call.method === 'fillText' && call.fillStyle === '#B6A3D1')).toBe(false)
    calls.length = 0
    drawFibChart(canvas, { bars, setup, showReferenceGrid: true })
    const references = calls.filter((call) => call.method === 'fillText' && call.fillStyle === '#B6A3D1').map((call) => String(call.args[0]))
    expect(references.some((text) => text.startsWith('1.618 ') && text.endsWith('reference'))).toBe(true)
    expect(references.some((text) => text.startsWith('3.618 ') && text.endsWith('reference'))).toBe(true)
    expect(references.every((text) => !/^(TP\d|Runner|Stop|E\d)/.test(text))).toBe(true)
    const enabledTargets = calls.filter((call) => call.method === 'fillText' && call.fillStyle === '#6EE7B7').map((call) => String(call.args[0]))
    expect(enabledTargets).toEqual(defaultTargets)
    expect(setup.targets).toHaveLength(5)
    assertFiniteDrawing(calls)
  })

  test('a nonpositive beyond-origin reference is omitted without poisoning a valid linear trade grid', () => {
    const bars = impulse(1, true)
    const setup = setupFor(bars)
    expect(setup.unavailableReferenceRatios).toContain(3.618)
    expect(setup.levels.some((level) => level.ratio === 3.618)).toBe(false)
    const { canvas, calls } = recordingCanvas()
    drawFibChart(canvas, { bars, setup, showReferenceGrid: true })
    assertFiniteDrawing(calls)
    expect(texts(calls).some((text) => text.startsWith('3.618 '))).toBe(false)
    expect(texts(calls).some((text) => text.startsWith('1.618 ') && text.endsWith('reference'))).toBe(true)
    expect(texts(calls).filter((text) => /^(TP[1-4]|Runner) /.test(text))).toHaveLength(5)
    expect(calls.filter((call) => call.method === 'strokeRect')).toHaveLength(bars.length)
  })

  test('terminal plans fade for chart context while raw candles remain fully visible', () => {
    const bars = impulse()
    const setup = { ...setupFor(bars), status: 'stopped' as const }
    const { canvas, calls } = recordingCanvas(340, 420)
    drawFibChart(canvas, { bars, setup })
    const pocket = calls.find((call) => call.method === 'fillRect' && call.fillStyle === 'rgba(242, 198, 109, 0.14)')!
    expect(pocket.globalAlpha).toBe(0.4)
    expect(calls.filter((call) => call.method === 'strokeRect').every((call) => call.globalAlpha === 1)).toBe(true)
    expect(texts(calls)).toContain('Linear · Golden pocket 0.618–0.666')
    assertFiniteDrawing(calls)
  })
})
