import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { drawDetailRsiChart } from '../src/lib/drawRsiChart'
import { analyzeTugOfWar, previewTugOfWar } from '../src/lib/tugOfWar'
import type { RsiBar } from '../src/types'

interface DrawCall {
  method: string
  args: unknown[]
  fillStyle: unknown
}

function recordingCanvas(width = 800, height = 680) {
  const calls: DrawCall[] = []
  const state: Record<string, unknown> = {}
  const context = new Proxy(state, {
    get(target, property) {
      if (property === 'measureText') return (text: string) => ({ width: text.length * 6 })
      if (property in target) return target[String(property)]
      return (...args: unknown[]) => calls.push({ method: String(property), args, fillStyle: target.fillStyle })
    },
    set(target, property, value) {
      target[String(property)] = value
      return true
    },
  })
  const surface = { width: 0, height: 0, clientWidth: width, clientHeight: height, getContext: () => context }
  return { calls, surface, canvas: surface as unknown as HTMLCanvasElement }
}

function candle(index: number, isClosed = true): RsiBar {
  return {
    openTime: index * 60_000,
    closeTime: (index + 1) * 60_000 - 1,
    open: 100 + index,
    high: 106 + index,
    low: 97 + index,
    close: 104 + index,
    volume: 10,
    rsi: 45 + index,
    isClosed,
  }
}

const settings = { rsiColor: '#8B46F2', smaColor: '#D97706', midlineColor: '#888888', lineWidth: 2 }
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')

beforeEach(() => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { devicePixelRatio: 2 } })
})

afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
  else Reflect.deleteProperty(globalThis, 'window')
})

describe('detail chart Heikin-Ashi panel', () => {
  test('aligns HA by raw timestamps across omitted and off-screen candles, including the live preview', () => {
    const bars = [candle(0), candle(1), candle(2), candle(3, false)]
    const closed = analyzeTugOfWar(bars)
    const preview = previewTugOfWar(bars, closed)!
    const { canvas, calls } = recordingCanvas()
    const layout = drawDetailRsiChart(canvas, [46, 47, 48], settings, {
      bars,
      signals: [],
      heikinAshiBars: [closed.heikinAshi[0], closed.heikinAshi[1], preview.heikinAshi],
    })!
    const haTitleY = calls.find((call) => call.method === 'fillText' && call.args[0] === 'Heikin-Ashi')!.args[2] as number
    const rsiTitleY = calls.find((call) => call.method === 'fillText' && call.args[0] === 'RSI (14)')!.args[2] as number
    const haBodies = calls.filter((call) => call.method === 'fillRect'
      && Number(call.args[1]) > haTitleY && Number(call.args[1]) < rsiTitleY)
    const centers = haBodies.map((call) => Number(call.args[0]) + Number(call.args[2]) / 2)

    // Candle 0 is off-screen, candle 2 has no HA value, and the live bar keeps
    // candle 3's rightmost position instead of sliding left across that gap.
    expect(centers).toEqual([layout.chartLeft, layout.chartRight])
    const hollow = calls.filter((call) => call.method === 'strokeRect')
    expect(hollow).toHaveLength(1)
    expect(Number(hollow[0].args[0]) + Number(hollow[0].args[2]) / 2).toBe(layout.chartRight)
    expect(calls.some((call) => call.method === 'fillText' && call.args[0] === 'LIVE')).toBe(true)
    expect(calls.some((call) => call.method === 'fillText' && String(call.args[0]).includes('averaged prices'))).toBe(true)
  })

  test('keeps divergence endpoints on raw price and RSI, never on the synthetic panel', () => {
    const bars = [candle(0), candle(1), candle(2)]
    const { canvas, calls } = recordingCanvas()
    drawDetailRsiChart(canvas, bars.map((bar) => bar.rsi), settings, {
      bars,
      heikinAshiBars: analyzeTugOfWar(bars).heikinAshi,
      signals: [{
        id: 'divergence',
        kind: 'regular_bullish',
        start: { time: bars[0].openTime, price: bars[0].low, rsi: bars[0].rsi },
        end: { time: bars[2].openTime, price: bars[2].low, rsi: bars[2].rsi },
      }],
    })
    const haTitleY = Number(calls.find((call) => call.method === 'fillText' && call.args[0] === 'Heikin-Ashi')!.args[2])
    const rsiTitleY = Number(calls.find((call) => call.method === 'fillText' && call.args[0] === 'RSI (14)')!.args[2])
    const endpoints = calls.filter((call) => call.method === 'arc')
    expect(endpoints).toHaveLength(4)
    expect(endpoints.every((call) => Number(call.args[1]) < haTitleY || Number(call.args[1]) > rsiTitleY)).toBe(true)
  })

  test('renders flat single candles and resizes to mobile with a finite, usable RSI panel', () => {
    const bars = [{ ...candle(0, false), open: 100, high: 100, low: 100, close: 100 }]
    const preview = previewTugOfWar(bars)!
    const { canvas, calls, surface } = recordingCanvas()
    for (const [width, height] of [[800, 680], [340, 420]]) {
      surface.clientWidth = width
      surface.clientHeight = height
      calls.length = 0
      const layout = drawDetailRsiChart(canvas, [50], settings, { bars, signals: [], heikinAshiBars: [preview.heikinAshi] })!
      expect(surface.width).toBe(width * 2)
      expect(surface.height).toBe(height * 2)
      expect(layout.chartBottom).toBeGreaterThan(layout.chartTop)
      expect(layout.chartRight).toBeGreaterThan(layout.chartLeft)
      expect(calls.flatMap((call) => call.args).filter((value) => typeof value === 'number').every(Number.isFinite)).toBe(true)
      expect(calls.filter((call) => call.method === 'strokeRect')).toHaveLength(1)
    }
  })

  test('preserves the two-panel caller and handles empty HA/history without a misleading live cue', () => {
    const bars = [candle(0), candle(1)]
    const { canvas, calls } = recordingCanvas()
    const original = drawDetailRsiChart(canvas, [45, 46], settings, { bars, signals: [] })!
    expect(calls.some((call) => call.args[0] === 'Heikin-Ashi')).toBe(false)
    calls.length = 0
    const withEmptyHa = drawDetailRsiChart(canvas, [45, 46], settings, { bars, signals: [], heikinAshiBars: [] })!
    expect(withEmptyHa.chartTop).toBeGreaterThan(original.chartTop)
    expect(calls.some((call) => call.args[0] === 'No Heikin-Ashi candles')).toBe(true)
    expect(calls.some((call) => call.args[0] === 'LIVE')).toBe(false)
    expect(drawDetailRsiChart(canvas, [], settings, { bars: [], signals: [], heikinAshiBars: [] })).toBeNull()
  })
})
