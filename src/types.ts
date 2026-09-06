export type Timeframe =
  | '1m' | '3m' | '5m' | '15m' | '30m'
  | '1h' | '2h' | '4h' | '8h'
  | '1d' | '3d' | '1w'

export type DrawingTool = 'brush' | 'trendline' | 'eraser' | null

export interface Point {
  x: number
  y: number
}

export interface BrushObject {
  id: string
  type: 'brush'
  points: Point[]
  color: string
  size: number
}

export interface TrendlineObject {
  id: string
  type: 'trendline'
  points: [Point, Point]
  color: string
  size: number
}

export type DrawingObject = BrushObject | TrendlineObject

export interface ChartSettings {
  rsiColor: string
  smaColor: string
  midlineColor: string
  lineWidth: number
  showPrice: boolean
  showVolume: boolean
}

export interface SymbolSnapshot {
  price: number
  volume: number
  series: number[]
}
