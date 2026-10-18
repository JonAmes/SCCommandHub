import { useState } from 'react'
import { Check, Save, Trash2 } from 'lucide-react'
import type { HangarShip } from './hangar'
import type { LedgerEntry } from './finance'
import { OcrScreenReader } from './OcrScreenReader'
import { addSalvageMoney, observeSalvage, reconcileSalvage, salvageMaterials, startSalvageSession, updateSalvageSession, type SalvageSession, type SalvagingState } from './salvagingOps'

export function SalvagingPanel({ state, ship, ledger, onChange, onSyncCargo }: { state: SalvagingState; ship?: HangarShip; ledger: LedgerEntry[]; onChange: (state: SalvagingState) => void; onSyncCargo: (shipId: string, cargo: Record<string, number>) => string }) {
  const [selected, setSelected] = useState('')
  const [target, setTarget] = useState('')
  const [location, setLocation] = useState('')
  const [status, setStatus] = useState('')
  const active = state.sessions.find((session) => !session.endedAt)
  const session = state.sessions.find((entry) => entry.id === selected) ?? active ?? state.sessions[0]
  function update(change: (session: SalvageSession) => SalvageSession) {
    if (session) onChange(updateSalvageSession(state, session.id, change))
  }
  return <>
    <form className="operations-toolbar" onSubmit={(event) => { event.preventDefault(); const next = startSalvageSession(state, { shipId: ship?.id ?? null, shipName: ship?.name ?? '', target, location }); onChange(next); setSelected(next.sessions[0]?.id ?? '') }}>
      <label>Salvage target<input required maxLength={100} value={target} onChange={(event) => setTarget(event.target.value)} /></label><label>Location<input maxLength={100} value={location} onChange={(event) => setLocation(event.target.value)} /></label><span>{ship?.name ?? 'No active ship'}</span><button className="primary-button" disabled={Boolean(active)}>Start session</button>
    </form>
    <div className="operations-toolbar"><label>Session<select value={session?.id ?? ''} onChange={(event) => setSelected(event.target.value)}><option value="" disabled>No sessions</option>{state.sessions.map((entry) => <option key={entry.id} value={entry.id}>{entry.target} - {new Date(entry.startedAt).toLocaleString()}{entry.endedAt ? ' (ended)' : ' (active)'}</option>)}</select></label>{session && !session.endedAt && <button className="secondary-button" onClick={() => update((current) => ({ ...current, endedAt: new Date().toISOString() }))}>End session</button>}{session && <button className="icon-button" type="button" title="Remove selected session" aria-label="Remove session" onClick={() => {
      if (!window.confirm(`Remove salvage session "${session.target}" and its history? Ship cargo and ledger entries will not be changed.`)) return
      onChange({ sessions: state.sessions.filter((entry) => entry.id !== session.id) })
      setSelected('')
      setStatus('Session removed')
    }}><Trash2 size={16} /></button>}</div>
    {session && <>
      <section className="data-section"><div className="section-toolbar"><div><h2>{session.target}</h2><span>{session.shipName || 'Unassigned ship'} / {session.location || 'Unspecified location'}</span></div><span className="table-label">{session.endedAt ? 'ENDED' : 'ACTIVE'}</span></div>
        <div className="table-scroll"><table><thead><tr><th>Material</th><th>Buffer / Capacity (SCU)</th><th>Hold / Capacity (SCU)</th><th>Collected (SCU)</th><th>Accounting</th></tr></thead><tbody>{salvageMaterials.map((material) => <tr key={material}><td>{material}</td><td>{session.current[`buffer:${material}`] ?? '-'} / {session.current[`capacity:buffer:${material}`] ?? '-'}</td><td>{session.current[`hold:${material}`] ?? '-'} / {session.current[`capacity:hold:${material}`] ?? '-'}</td><td>{session.collected[material] ?? 0}</td><td>{session.pending.includes(material) ? 'Reconciliation required' : 'Current'}</td></tr>)}</tbody></table></div>
        {!session.endedAt && <><div className="operations-toolbar"><button className="secondary-button" disabled={!session.shipId || session.shipId !== ship?.id} onClick={() => { const cargo = Object.fromEntries(salvageMaterials.flatMap((material) => session.current[`hold:${material}`] === undefined ? [] : [[material, session.current[`hold:${material}`]]])); setStatus(!Object.keys(cargo).length ? 'No hold quantities recorded' : onSyncCargo(session.shipId!, cargo) || 'Ship hold updated') }}>Apply hold to ship</button></div><SalvageCorrection key={session.id} session={session} onUpdate={update} />{session.pending.map((material) => <Reconciliation key={material} material={material} onConfirm={(amount, note) => update((current) => reconcileSalvage(current, material, amount, note))} />)}</>}
      </section>
      {!session.endedAt && session.id === active?.id && <OcrScreenReader key={`${session.id}-${ship?.id ?? ''}`} target="salvage" onVerified={(readings) => {
        if (session.shipId !== (ship?.id ?? null)) { setStatus('Active ship differs from session ship. End this session before changing ships.'); return }
        update((current) => readings.reduce((next, reading) => observeSalvage(next, reading), current))
      }} />}
      <SalvageFinances key={session.id} session={session} ledger={ledger} onUpdate={update} usedLinks={new Set(state.sessions.flatMap((entry) => entry.money.flatMap((money) => money.ledgerId ? [money.ledgerId] : [])))} />
      <section className="data-section"><div className="section-toolbar"><h2>Session history</h2></div><div className="table-scroll"><table><thead><tr><th>Time</th><th>Event</th><th>Values</th><th>Note</th></tr></thead><tbody>{session.events.map((event) => <tr key={event.id}><td>{new Date(event.recordedAt).toLocaleString()}</td><td>{event.kind}</td><td>{Object.entries(event.values).map(([key, amount]) => `${key}: ${amount}`).join(', ')}</td><td>{event.note}</td></tr>)}</tbody></table></div></section>
    </>}
    {status && <p role="status">{status}</p>}
  </>
}

function SalvageCorrection({ onUpdate }: { session: SalvageSession; onUpdate: (update: (session: SalvageSession) => SalvageSession) => void }) {
  const [material, setMaterial] = useState<string>(salvageMaterials[0])
  const [kind, setKind] = useState('buffer')
  const [amount, setAmount] = useState('')
  return <form className="operations-toolbar" onSubmit={(event) => { event.preventDefault(); onUpdate((current) => observeSalvage(current, { target: 'salvage', identity: 'SALVAGE', values: { [`${kind}:${material}`]: Number(amount) }, live: {}, text: '' }, true)); setAmount('') }}><label>Material<select value={material} onChange={(event) => setMaterial(event.target.value)}>{salvageMaterials.map((item) => <option key={item}>{item}</option>)}</select></label><label>Store<select value={kind} onChange={(event) => setKind(event.target.value)}><option value="buffer">Buffer</option><option value="hold">Hold</option></select></label><label>Manual quantity (SCU)<input required type="number" min="0" step="0.0001" value={amount} onChange={(event) => setAmount(event.target.value)} /></label><button className="icon-button" title="Save correction" aria-label="Save correction"><Save size={16} /></button></form>
}

function Reconciliation({ material, onConfirm }: { material: string; onConfirm: (amount: number, note: string) => void }) {
  const [amount, setAmount] = useState('0')
  const [note, setNote] = useState('Boxing / transfer')
  return <form className="operations-toolbar operations-warning" onSubmit={(event) => { event.preventDefault(); onConfirm(Number(amount), note) }}><strong>{material}</strong><label>Additional collected (SCU)<input required type="number" min="0" step="0.0001" value={amount} onChange={(event) => setAmount(event.target.value)} /></label><label>Reconciliation note<input required maxLength={200} value={note} onChange={(event) => setNote(event.target.value)} /></label><button className="icon-button" title="Confirm reconciliation" aria-label="Confirm reconciliation"><Check size={16} /></button></form>
}

function SalvageFinances({ session, ledger, onUpdate, usedLinks }: { session: SalvageSession; ledger: LedgerEntry[]; usedLinks: Set<string>; onUpdate: (update: (session: SalvageSession) => SalvageSession) => void }) {
  const [kind, setKind] = useState<'sale' | 'expense'>('sale')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [ledgerId, setLedgerId] = useState('')
  const linked = ledger.find((entry) => entry.id === ledgerId)
  const eligible = ledger.filter((entry) => !usedLinks.has(entry.id) && (kind === 'sale' ? ['sell', 'game_sale'].includes(entry.side) : ['buy', 'game_purchase', 'withdrawal'].includes(entry.side)))
  const entries = session.money.map((entry) => ({ ...entry, linked: entry.ledgerId ? ledger.find((item) => item.id === entry.ledgerId) : undefined }))
  const total = (side: 'sale' | 'expense') => entries.filter((entry) => entry.kind === side).reduce((sum, entry) => sum + (entry.ledgerId ? entry.linked?.total ?? 0 : entry.amount), 0)
  return <section className="data-section"><div className="section-toolbar"><h2>Sales & expenses</h2><span className="table-label">NET {(total('sale') - total('expense')).toLocaleString()} aUEC</span></div>
    {!session.endedAt && <form className="operations-toolbar" onSubmit={(event) => { event.preventDefault(); if (ledgerId && (!eligible.some((entry) => entry.id === ledgerId) || !linked)) return; onUpdate((current) => addSalvageMoney(current, { kind, amount: linked ? linked.total : Number(amount), note, ...(linked ? { ledgerId: linked.id } : {}) })); setAmount(''); setNote(''); setLedgerId('') }}><label>Type<select value={kind} onChange={(event) => { setKind(event.target.value as 'sale' | 'expense'); setLedgerId('') }}><option value="sale">Sale</option><option value="expense">Expense</option></select></label><label>Ledger link<select value={ledgerId} onChange={(event) => setLedgerId(event.target.value)}><option value="">Session only</option>{eligible.map((entry) => <option key={entry.id} value={entry.id}>{entry.commodity} - {entry.total} aUEC</option>)}</select></label><label>Amount (aUEC)<input type="number" required min="0.01" step="0.01" disabled={Boolean(linked)} value={linked ? linked.total : amount} onChange={(event) => setAmount(event.target.value)} /></label><label>Note<input required maxLength={200} value={note} onChange={(event) => setNote(event.target.value)} /></label><button className="icon-button" aria-label="Save financial record" title="Save financial record"><Save size={16} /></button></form>}
    <div className="table-scroll"><table><thead><tr><th>Type</th><th>Amount (aUEC)</th><th>Note</th><th>Ledger</th><th /></tr></thead><tbody>{entries.map((entry) => <tr key={entry.id}><td>{entry.kind}</td><td>{entry.ledgerId ? entry.linked?.total ?? 'Unresolved' : entry.amount}</td><td>{entry.note}</td><td>{entry.ledgerId ? entry.linked ? 'Linked' : 'Missing entry' : 'Session only'}</td><td>{!session.endedAt && <button className="text-button" onClick={() => onUpdate((current) => ({ ...current, money: current.money.filter((item) => item.id !== entry.id) }))}>Remove</button>}</td></tr>)}</tbody></table></div>
  </section>
}