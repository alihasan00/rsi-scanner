export const FIB_STOP_RATIOS = [0.92, 1.04, 1.14, 1.272] as const
export const FIB_TP3_RATIOS = [0, -0.236] as const

export interface FibSettings {
  scale: 'linear' | 'log'
  stopRatio: typeof FIB_STOP_RATIOS[number]
  tp3Ratio: typeof FIB_TP3_RATIOS[number]
  tp4Ratio: number
  runnerRatio: number
}

/** Extension defaults match the supplied Fib template. */
export const DEFAULT_FIB_SETTINGS: Readonly<FibSettings> = Object.freeze({
  scale: 'linear',
  stopRatio: 0.92,
  tp3Ratio: -0.236,
  tp4Ratio: -0.382,
  runnerRatio: -0.618,
})

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Validate stored or shared templates and retain strictly ordered extension targets. */
export function restoreFibSettings(input: unknown): FibSettings {
  const saved = input !== null && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown> : {}
  const defaults = DEFAULT_FIB_SETTINGS
  const tp3Ratio = FIB_TP3_RATIOS.find((ratio) => ratio === saved.tp3Ratio) ?? defaults.tp3Ratio
  let tp4Ratio = isFiniteNumber(saved.tp4Ratio) && saved.tp4Ratio < tp3Ratio
    ? saved.tp4Ratio : defaults.tp4Ratio
  // Moving TP4 farther out also moves a malformed/overlapping runner beyond it.
  let runnerRatio = isFiniteNumber(saved.runnerRatio) && saved.runnerRatio < tp4Ratio
    ? saved.runnerRatio : Math.min(defaults.runnerRatio, tp4Ratio - 0.236)
  // Extreme finite numbers can lose the subtraction to floating-point precision.
  if (!Number.isFinite(runnerRatio) || runnerRatio >= tp4Ratio) {
    tp4Ratio = defaults.tp4Ratio
    runnerRatio = defaults.runnerRatio
  }
  return {
    scale: saved.scale === 'linear' || saved.scale === 'log' ? saved.scale : defaults.scale,
    stopRatio: FIB_STOP_RATIOS.find((ratio) => ratio === saved.stopRatio) ?? defaults.stopRatio,
    tp3Ratio,
    tp4Ratio,
    runnerRatio,
  }
}
