import { useEffect, useState } from 'react'
import { readNumber, readText, type UexRow } from './uex'
import { formatRemaining, getRefiningProgress, getRefiningStatus, type NewRefiningOrder, type RefiningJob, type RefiningOre } from './refining'
import { refinedMaterialName, refineryLocation } from './locationCargo'

const statusLabels = { processing: 'PROCESSING', ready: 'READY', collected: 'COLLECTED' } as const

function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(timer)
  }, [intervalMs])
  return now
}

function formatScu(value: number) {
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })} SCU`
}

function rating(value: number, labels: string[]) {
  return labels[value] ?? '—'
}

function JobTimer({ job, now }: { job: RefiningJob; now: number }) {
  const status = getRefiningStatus(job, now)
  const progress = getRefiningProgress(job, now)
  return <div className="refining-timer">
    <div className="refining-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}><i style={{ width: `${progress * 100}%` }} /></div>
    <span>{status === 'processing' ? `${formatRemaining(Date.parse(job.completesAt) - now)} remaining` : status === 'ready' ? `Ready since ${new Date(job.completesAt).toLocaleString()}` : `Collected ${new Date(job.collectedAt ?? job.completesAt).toLocaleString()}`}</span>
  </div>
}

export function RefiningOrders({ activeShipName, shipOre, refineries, methods, yields, jobs, onCreate, onCollect, onRemove }: {
  activeShipName?: string
  shipOre: RefiningOre[]
  refineries: string[]
  methods: UexRow[]
  yields: UexRow[]
  jobs: RefiningJob[]
  onCreate: (order: NewRefiningOrder) => string
  onCollect: (jobId: string, refined: RefiningOre[]) => string
  onRemove: (jobId: string) => void
}) {
  const now = useNow()
  const [collecting, setCollecting] = useState<{ jobId: string; rows: { commodity: string; scu: string }[]; error: string } | null>(null)
  const [refinery, setRefinery] = useState('')
  const [method, setMethod] = useState('')
  const [hours, setHours] = useState('')
  const [minutes, setMinutes] = useState('')
  const [error, setError] = useState('')
  const totalScu = shipOre.reduce((sum, ore) => sum + ore.scu, 0)
  const sortedJobs = [...jobs].sort((left, right) => {
    const order = { ready: 0, processing: 1, collected: 2 }
    return order[getRefiningStatus(left, now)] - order[getRefiningStatus(right, now)] || left.completesAt.localeCompare(right.completesAt)
  })

  function yieldModifier(commodity: string) {
    const row = yields.find((item) => readText(item, 'terminal_name') === refinery && readText(item, 'commodity_name') === commodity)
    if (!row) return null
    const value = readNumber(row, 'value')
    return `${value > 0 ? '+' : ''}${value}%`
  }

  function startCollect(job: RefiningJob) {
    setCollecting({ jobId: job.id, rows: job.ores.map((ore) => ({ commodity: refinedMaterialName(ore.commodity), scu: String(ore.scu) })), error: '' })
  }

  function confirmCollect(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!collecting) return
    const refined = collecting.rows.map((row) => ({ commodity: row.commodity.trim(), scu: Number(row.scu) })).filter((row) => row.commodity && row.scu > 0)
    const message = onCollect(collecting.jobId, refined)
    if (message) setCollecting({ ...collecting, error: message })
    else setCollecting(null)
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const message = onCreate({ refinery, method, durationMinutes: (Number(hours) || 0) * 60 + (Number(minutes) || 0) })
    if (message) {
      setError(message)
      return
    }
    setHours('')
    setMinutes('')
    setError('')
  }

  return <>
    <section className="data-section refining-order-section">
      <div className="section-toolbar"><div><h2>New refining order</h2><span>{activeShipName ? `Takes all raw ore from ${activeShipName}` : 'Select an active ship in Personal hangar'}</span></div><span className="table-label">{formatScu(totalScu)} ORE</span></div>
      <div className="refining-ship-ore">
        {shipOre.map((ore) => {
          const modifier = refinery ? yieldModifier(ore.commodity) : null
          return <div className="refining-ore-row" key={ore.commodity}><strong>{ore.commodity}</strong><span>{formatScu(ore.scu)}</span>{modifier && <small className={modifier.startsWith('-') ? 'ledger-debit' : 'ledger-credit'}>{modifier} yield here</small>}</div>
        })}
        {!shipOre.length && <div className="dashboard-empty"><strong>No ore detected</strong><span>{activeShipName ? `${activeShipName} has no raw ore in its hold. Read your CARGO panel in the Rock scan log to load it.` : 'Choose an active ship, then read its cargo with the scan screen reader.'}</span></div>}
      </div>
      <form className="mining-scan-form refining-order-form" onSubmit={submit}>
        <label><span>REFINERY</span><select value={refinery} onChange={(event) => { setRefinery(event.target.value); setError('') }} required><option value="">Choose refinery</option>{refineries.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
        <label><span>METHOD</span><select value={method} onChange={(event) => { setMethod(event.target.value); setError('') }} required><option value="">Choose method</option>{methods.map((row) => <option key={readText(row, 'name')} value={readText(row, 'name')}>{readText(row, 'name')} · yield {rating(readNumber(row, 'rating_yield'), ['', 'low', 'medium', 'high'])} · {rating(readNumber(row, 'rating_speed'), ['', 'slow', 'medium', 'fast'])}</option>)}</select></label>
        <div className="refining-duration"><span>PROCESSING TIME (FROM REFINERY TERMINAL)</span><div><div className="number-input"><input aria-label="Hours" type="number" min="0" max="336" step="1" value={hours} onChange={(event) => setHours(event.target.value)} placeholder="0" /><span>H</span></div><div className="number-input"><input aria-label="Minutes" type="number" min="0" max="59" step="1" value={minutes} onChange={(event) => setMinutes(event.target.value)} placeholder="0" /><span>M</span></div></div></div>
        {error && <div className="form-error mining-scan-error" role="alert">{error}</div>}
        <div className="mining-scan-submit"><span>UEX has no refinery timings, so enter the duration the game shows when you confirm the job.</span><button className="primary-button" type="submit" disabled={!shipOre.length}>Start refining order</button></div>
      </form>
    </section>
    <section className="data-section refining-jobs-section">
      <div className="section-toolbar"><div><h2>Refining jobs</h2><span>{jobs.filter((job) => getRefiningStatus(job, now) !== 'collected').length} active · {jobs.length} total</span></div><span className="table-label">LIVE TIMERS</span></div>
      <div className="refining-job-list">
        {sortedJobs.map((job) => {
          const status = getRefiningStatus(job, now)
          return <article className={`refining-job ${status}`} key={job.id}>
            <div className="refining-job-head">
              <div><strong>{job.refinery}</strong><small>{job.method} · {job.shipName} · started {new Date(job.startedAt).toLocaleString()}</small></div>
              <span className={`refining-status ${status}`}>{statusLabels[status]}</span>
            </div>
            <div className="mining-scan-composition-summary"><span>{formatScu(job.totalScu)}</span>{job.ores.map((ore) => <span className="mining-scan-mineral" key={ore.commodity}>{ore.commodity} · {formatScu(ore.scu)}</span>)}</div>
            {job.refined && <div className="mining-scan-composition-summary"><span>REFINED → {refineryLocation(job.refinery)}</span>{job.refined.map((item) => <span className="mining-scan-mineral" key={item.commodity}>{item.commodity} · {formatScu(item.scu)}</span>)}</div>}
            <JobTimer job={job} now={now} />
            {collecting?.jobId === job.id ? <form className="mining-scan-form refining-collect-form" onSubmit={confirmCollect}>
              <div className="mining-scan-composition">
                <div className="mining-scan-composition-head"><div><span>REFINED OUTPUT</span><small>Enter the amounts shown at the refinery terminal. They will be stored at {refineryLocation(job.refinery)}.</small></div></div>
                {collecting.rows.map((row, index) => <div className="mining-scan-composition-row" key={index}>
                  <input aria-label="Refined material" value={row.commodity} onChange={(event) => setCollecting({ ...collecting, rows: collecting.rows.map((item, itemIndex) => itemIndex === index ? { ...item, commodity: event.target.value } : item) })} />
                  <div className="number-input"><input aria-label="Refined amount" type="number" min="0" step="0.01" value={row.scu} onChange={(event) => setCollecting({ ...collecting, rows: collecting.rows.map((item, itemIndex) => itemIndex === index ? { ...item, scu: event.target.value } : item) })} /><span>SCU</span></div>
                  <span />
                </div>)}
              </div>
              {collecting.error && <div className="form-error mining-scan-error" role="alert">{collecting.error}</div>}
              <div className="refining-job-actions"><button className="primary-button" type="submit">Collect to {refineryLocation(job.refinery)}</button><button className="text-button" type="button" onClick={() => setCollecting(null)}>Cancel</button></div>
            </form> : <div className="refining-job-actions">
              {status === 'ready' && <button className="primary-button" type="button" onClick={() => startCollect(job)}>Collect</button>}
              <button className="text-button" type="button" onClick={() => onRemove(job.id)}>{status === 'processing' ? 'Cancel job' : 'Remove'}</button>
            </div>}
          </article>
        })}
        {!jobs.length && <div className="dashboard-empty"><strong>No refining jobs</strong><span>Start an order above to track its timer here and on the dashboard.</span></div>}
      </div>
    </section>
  </>
}

export function RefiningDashboardPanel({ jobs, onOpen }: { jobs: RefiningJob[]; onOpen: () => void }) {
  const now = useNow()
  const active = jobs.filter((job) => getRefiningStatus(job, now) !== 'collected').sort((left, right) => left.completesAt.localeCompare(right.completesAt))
  const ready = active.filter((job) => getRefiningStatus(job, now) === 'ready').length
  return <section className="data-section dashboard-panel dashboard-refining-panel">
    <div className="section-toolbar"><div><h2>Refining jobs</h2><span>{active.length ? `${active.length} active${ready ? ` · ${ready} ready to collect` : ''}` : 'No active refining jobs'}</span></div><button className="text-button" type="button" onClick={onOpen}>Open refining ↗</button></div>
    {active.length ? <div className="refining-job-list">{active.map((job) => {
      const status = getRefiningStatus(job, now)
      return <div className="refining-dashboard-row" key={job.id}>
        <div className="refining-job-head"><div><strong>{job.refinery}</strong><small>{job.ores.map((ore) => ore.commodity).join(', ')} · {formatScu(job.totalScu)}</small></div><span className={`refining-status ${status}`}>{statusLabels[status]}</span></div>
        <JobTimer job={job} now={now} />
      </div>
    })}</div> : <div className="dashboard-empty"><strong>Nothing refining</strong><span>Start a refining order from your ship's ore to track it here.</span></div>}
  </section>
}
