import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { drawDetailRsiChart, drawMiniRsiChart } from '../src/lib/drawRsiChart'
import { drawScreenerChart } from '../src/lib/drawScreenerChart'
import { analyzeTugOfWar, previewTugOfWar } from '../src/lib/tugOfWar'
import type { RsiBar } from '../src/types'

interface DrawCall {
  method: string
  args: unknown[]
  fillStyle: unknown
  strokeStyle: unknown
  lineDash: unknown
}

function recordingCanvas(width = 800, height = 680) {
  const calls: DrawCall[] = []
  const state: Record<string, unknown> = {}
  const stack: Record<string, unknown>[] = []
  const record = (method: string, args: unknown[]) => {
    calls.push({ method, args, fillStyle: state.fillStyle, strokeStyle: state.strokeStyle, lineDash: state.lineDash })
  }
  const context = new Proxy(state, {
    get(target, property) {
      if (property === 'measureText') return (text: string) => ({ width: text.length * 6 })
      if (property === 'save') return () => { stack.push({ ...state }); record('save', []) }
      if (property === 'restore') return () => {
        const saved = stack.pop()
        if (saved) {
          for (const key of Object.keys(state)) delete state[key]
          Object.assign(state, saved)
        }
        record('restore', [])
      }
      if (property === 'setLineDash') return (segments: number[]) => {
        state.lineDash = [...segments]
        record('setLineDash', [segments])
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

describe('RSI threshold presentation', () => {
  test.each([
    [0, 'Oversold'], [30, 'Oversold'], [30.1, 'Neutral'],
    [69.9, 'Neutral'], [70, 'Overbought'], [100, 'Overbought'],
  ])('keeps both named zones visible for flat RSI %s and labels it %s', (rsi, label) => {
    const bars = [{ ...candle(0, false), rsi }]
    const { canvas, calls } = recordingCanvas(340, 420)
    const layout = drawDetailRsiChart(canvas, [rsi], settings, {
      bars, signals: [], heikinAshiBars: [previewTugOfWar(bars)!.heikinAshi],
    })!
    expect([layout.minRsi, layout.maxRsi]).toEqual([0, 100])
    const texts = calls.filter((call) => call.method === 'fillText').map((call) => call.args[0])
    expect(texts).toContain('Overbought ≥ 70')
    expect(texts).toContain('Oversold ≤ 30')
    expect(texts).toContain(`${rsi.toFixed(1)} · ${label} · Live`)

    const bands = calls.filter((call) => call.method === 'fillRect' && String(call.fillStyle).endsWith(', 0.07)'))
    expect(bands).toHaveLength(2)
    const panelHeight = layout.chartBottom - layout.chartTop
    expect(Number(bands[0].args[1])).toBeCloseTo(layout.chartTop)
    expect(Number(bands[0].args[3])).toBeCloseTo(panelHeight * 0.3)
    expect(Number(bands[1].args[1])).toBeCloseTo(layout.chartTop + panelHeight * 0.7)
    expect(Number(bands[1].args[3])).toBeCloseTo(panelHeight * 0.3)
    expect(bands.every((call) => call.args[0] === layout.chartLeft && call.args[2] === layout.chartRight - layout.chartLeft)).toBe(true)

    // A short three-panel chart must leave room between RSI axis labels.
    const axisTicks = calls.filter((call) => call.method === 'fillText'
      && /^\d+$/.test(String(call.args[0])) && Number(call.args[1]) > layout.chartRight
      && Number(call.args[2]) >= layout.chartTop && Number(call.args[2]) <= layout.chartBottom)
    const positions = axisTicks.map((call) => Number(call.args[2])).sort((a, b) => a - b)
    expect(positions).toHaveLength(5)
    expect(positions.slice(1).every((y, index) => y - positions[index] >= 12)).toBe(true)
  })

  test('compact sparklines keep the same bands without text crowding the cell', () => {
    const { canvas, calls } = recordingCanvas(120, 80)
    drawMiniRsiChart(canvas, [80, 85, 90], settings)
    const bands = calls.filter((call) => call.method === 'fillRect')
    expect(bands.map((call) => call.args)).toEqual([[0, 0, 120, 24], [0, 56, 120, 24]])
    expect(calls.some((call) => call.method === 'fillText')).toBe(false)
    const line = calls.filter((call) => call.method === 'moveTo' && call.strokeStyle === settings.rsiColor)
    expect(line[0].args).toEqual([0, 16])
  })

  test('keeps threshold names clear of divergence annotations in a short RSI panel', () => {
    const bars = [85, 82, 83].map((rsi, index) => ({ ...candle(index), rsi }))
    const { canvas, calls } = recordingCanvas(340, 420)
    const layout = drawDetailRsiChart(canvas, bars.map((bar) => bar.rsi), settings, {
      bars,
      heikinAshiBars: analyzeTugOfWar(bars).heikinAshi,
      signals: [{
        id: 'near-threshold-label', kind: 'regular-bearish',
        start: { time: bars[0].openTime, price: bars[0].high, rsi: 85 },
        end: { time: bars[1].openTime, price: bars[1].high, rsi: 82 },
      }],
    })!
    const threshold = calls.find((call) => call.method === 'fillText' && call.args[0] === 'Overbought ≥ 70')!
    const labelY = Number(threshold.args[2])
    const rsiAnnotations = calls.filter((call) => call.method === 'fillText' && call.args[0] === 'R Bear' && Number(call.args[2]) > layout.chartTop)
    expect(rsiAnnotations.every((call) => Math.abs(Number(call.args[2]) - labelY) >= 15)).toBe(true)
    // Dense labels may be omitted, but the actual divergence keeps both anchors.
    expect(calls.filter((call) => call.method === 'arc' && Number(call.args[1]) > layout.chartTop)).toHaveLength(2)
  })

  test.each([[30, 'Oversold'], [70, 'Overbought']])('card RSI %s shares thresholds and preserves provisional candles and RSI', (rsi, label) => {
    const bars = [candle(0), { ...candle(1, false), rsi }]
    const { canvas, calls } = recordingCanvas(340, 240)
    drawScreenerChart(canvas, { bars, divergences: [], timeframe: '1m', settings })
    const texts = calls.filter((call) => call.method === 'fillText').map((call) => call.args[0])
    expect(texts).toContain('Overbought ≥ 70')
    expect(texts).toContain('Oversold ≤ 30')
    expect(texts).toContain(`${rsi.toFixed(1)} · ${label} · Live`)
    expect(calls.filter((call) => call.method === 'strokeRect')).toHaveLength(1)
    const rsiLines = calls.filter((call) => call.method === 'stroke' && call.strokeStyle === settings.rsiColor)
    expect(rsiLines).toHaveLength(1)
    expect(rsiLines[0].lineDash).toEqual([2, 2])
  })
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
