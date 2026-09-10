import { useState } from 'react'
import { Button, InputNumber, Select } from 'antd'
import { DEFAULT_FIB_SETTINGS } from '../lib/fibPreferences'
import type { FibSettings } from '../lib/fibPreferences'
import { useScannerStore } from '../store/scannerStore'
import './Fibonacci.css'

function FibSettingsForm({ settings, save }: { settings: FibSettings; save: (settings: FibSettings) => void }) {
  const [draft, setDraft] = useState(settings)
  const update = (patch: Partial<FibSettings>) => setDraft((current) => ({ ...current, ...patch }))
  const valid = Number.isFinite(draft.tp4Ratio) && Number.isFinite(draft.runnerRatio)
    && draft.tp4Ratio < draft.tp3Ratio && draft.runnerRatio < draft.tp4Ratio
  return <div className="fib-settings__body">
    <div className="fib-settings__fields">
      <label>Price scale<Select aria-label="Fib price scale" value={draft.scale} onChange={(scale) => update({ scale })} options={[{ value: 'linear', label: 'Linear' }, { value: 'log', label: 'Logarithmic' }]} /></label>
      <label>Initial stop<Select aria-label="Fib initial stop ratio" value={draft.stopRatio} onChange={(stopRatio) => update({ stopRatio })} options={[0.92, 1.04, 1.14, 1.272].map((value) => ({ value, label: `${value}${value === 0.92 ? ' · standard' : ' · wider'}` }))} /></label>
      <label>TP3 ratio<Select aria-label="Fib third target ratio" value={draft.tp3Ratio} onChange={(tp3Ratio) => update({ tp3Ratio })} options={[{ value: -0.236, label: '−0.236 · extension' }, { value: 0, label: '0 · prior extreme' }]} /></label>
      <label>TP4 ratio<InputNumber aria-label="Fib fourth target ratio" value={draft.tp4Ratio} step={0.001} onChange={(value) => { if (value !== null) update({ tp4Ratio: value }) }} /></label>
      <label>Runner trigger<InputNumber aria-label="Fib runner trigger ratio" value={draft.runnerRatio} step={0.001} onChange={(value) => { if (value !== null) update({ runnerRatio: value }) }} /></label>
    </div>
    <p className="fib-help">Screenshot template: TP3 −0.236, TP4 −0.382, runner −0.618. The lecture also allows TP3 at 0. Wider stops increase the distance at risk. Changes recalculate the modeled setup history.</p>
    {!valid && <p role="alert" className="fib-error">TP4 must be below TP3, and the runner ratio below TP4.</p>}
    <div className="fib-settings__actions"><Button onClick={() => setDraft({ ...DEFAULT_FIB_SETTINGS })}>Restore template</Button><Button type="primary" disabled={!valid} onClick={() => save(draft)}>Apply Fib settings</Button></div>
  </div>
}

export function FibSettingsPanel() {
  const settings = useScannerStore((state) => state.fibSettings)
  const save = useScannerStore((state) => state.updateFibSettings)
  return <details className="fib-settings">
    <summary>Fib settings <span>{settings.scale === 'log' ? 'Logarithmic' : 'Linear'} · stop {settings.stopRatio}</span></summary>
    <FibSettingsForm key={JSON.stringify(settings)} settings={settings} save={save} />
  </details>
}
