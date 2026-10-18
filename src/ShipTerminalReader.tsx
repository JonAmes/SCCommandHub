import { useState } from 'react'
import { OcrScreenReader } from './OcrScreenReader'
import { matchTerminalShip } from './ocrReadings'
import type { HangarState } from './hangar'

export function ShipTerminalReader({ hangar, onConfirm }: { hangar: HangarState; onConfirm: (shipId: string) => void }) {
  const [open, setOpen] = useState(false)
  const [candidate, setCandidate] = useState<{ id: string; identity: string } | null>(null)
  const [status, setStatus] = useState('')
  const ship = hangar.ships.find((entry) => entry.id === candidate?.id)
  return <section className="data-section"><div className="section-toolbar"><h2>Spawned ship</h2><button className="secondary-button" onClick={() => { setOpen(!open); setCandidate(null); setStatus('') }}>{open ? 'Close terminal reader' : 'Read ship terminal'}</button></div>
    {open && <OcrScreenReader target="shipTerminal" onUnavailable={() => setCandidate(null)} onVerified={(readings) => {
      if (readings.length !== 1) return
      const reading = readings[0]
      const id = matchTerminalShip(reading.identity, hangar.ships)
      if (!id) { setCandidate(null); setStatus(`No unique Hangar match for ${reading.identity}`); return }
      if (id === hangar.activeShipId) { setCandidate(null); setStatus(`${reading.identity} is already active`); return }
      setCandidate({ id, identity: reading.identity })
      setStatus('')
    }} />}
    {candidate && ship && <div className="operations-toolbar" role="group" aria-label="Confirm active ship"><strong>{candidate.identity} / Store / 3 matching captures</strong><button className="primary-button" onClick={() => { onConfirm(ship.id); setCandidate(null); setOpen(false); setStatus(`${ship.name} is active`) }}>Set {ship.name} active</button><button className="secondary-button" onClick={() => { setCandidate(null); setStatus('Ship change cancelled') }}>Cancel</button></div>}
    {status && <p className="table-note" role="status">{status}</p>}
  </section>
}