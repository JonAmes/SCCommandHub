import { useState } from 'react'
import { Save, Trash2 } from 'lucide-react'
import { OcrScreenReader } from './OcrScreenReader'
import { saveScannerObservation, type ScannerState } from './scannerOps'

export function ScannerPanel({ state, onChange }: { state: ScannerState; onChange: (state: ScannerState) => void }) {
  const [mode, setMode] = useState<'shipTarget' | 'contacts'>('shipTarget')
  const [location, setLocation] = useState('')
  const [identity, setIdentity] = useState('')
  return <>
    <div className="operations-toolbar"><div role="tablist" aria-label="Scanner view" className="operations-tabs"><button role="tab" aria-selected={mode === 'shipTarget'} onClick={() => setMode('shipTarget')}>Target</button><button role="tab" aria-selected={mode === 'contacts'} onClick={() => setMode('contacts')}>Contacts</button></div><label>Location<input maxLength={100} value={location} onChange={(event) => setLocation(event.target.value)} /></label></div>
    <OcrScreenReader key={mode} target={mode} onVerified={(readings) => onChange(readings.reduce((current, reading) => saveScannerObservation(current, reading, location), state))} />
    <section className="data-section"><div className="section-toolbar"><h2>Scanner history</h2><span className="table-label">{state.observations.length} RECORDS</span></div>
      <form className="operations-toolbar" onSubmit={(event) => { event.preventDefault(); onChange(saveScannerObservation(state, { target: mode, identity, values: {}, live: {}, text: '' }, location, 'manual')); setIdentity('') }}><label>Manual target / contact<input required maxLength={200} value={identity} onChange={(event) => setIdentity(event.target.value)} /></label><button className="icon-button" title="Save manual observation" aria-label="Save manual observation"><Save size={16} /></button></form>
      <div className="table-scroll"><table><thead><tr><th>Identity</th><th>Type</th><th>Location</th><th>Stable Measurements</th><th>Recorded</th><th>Source</th><th /></tr></thead><tbody>{state.observations.map((entry) => <tr key={entry.id}><td>{entry.identity}</td><td>{entry.target === 'shipTarget' ? 'Target' : 'Contact'}</td><td>{entry.location || '-'}</td><td>{Object.entries(entry.values).map(([key, amount]) => `${key}: ${amount}`).join(', ') || '-'}</td><td>{new Date(entry.recordedAt).toLocaleString()}</td><td>{entry.source === 'ocr' ? '3/3 OCR' : 'Manual'}</td><td><button className="icon-button" title="Delete observation" aria-label={`Delete ${entry.identity}`} onClick={() => onChange({ observations: state.observations.filter((item) => item.id !== entry.id) })}><Trash2 size={16} /></button></td></tr>)}</tbody></table></div>{!state.observations.length && <p className="table-note">No scanner observations</p>}
    </section>
  </>
}