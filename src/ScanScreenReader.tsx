import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type { NewRockScan, RockScan } from './miningOps'
import { parseCargoText, parseScanText, primaryMineral, scanSignature, type CargoReading, type ParsedRockScan, type ScanRegion } from './scanOcr'

const locationKey = 'sc-command-hub.scan-reader-location-v1'
const autoReadIntervalMs = 2500

type OcrWorker = Awaited<ReturnType<typeof import('tesseract.js')['createWorker']>>
type ScreenSource = { id: string; name: string }
type RegionTarget = 'scan' | 'cargo'

const regionKeys: Record<RegionTarget, string> = {
  scan: 'sc-command-hub.scan-reader-region-v1',
  cargo: 'sc-command-hub.scan-reader-cargo-region-v1',
}
const regionLabels: Record<RegionTarget, string> = { scan: 'Scan results', cargo: 'Cargo' }

function loadRegion(target: RegionTarget): ScanRegion | null {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(regionKeys[target]) ?? 'null')
    if (!value || typeof value !== 'object') return null
    const region = value as ScanRegion
    return [region.x, region.y, region.width, region.height].every((part) => Number.isFinite(part) && part >= 0 && part <= 1) && region.width > 0 && region.height > 0 ? region : null
  } catch {
    return null
  }
}

function readStoredLocation() {
  try {
    return window.localStorage.getItem(locationKey) ?? ''
  } catch {
    return ''
  }
}

function normalizeRegion(start: { x: number; y: number }, end: { x: number; y: number }): ScanRegion {
  return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) }
}

function cargoSignature(reading: CargoReading) {
  return reading.items.map((item) => `${item.commodity}:${item.scu}`).sort().join('|')
}

type CompositionRow = { id: string; commodity: string; percent: string }
type ScanForm = { massKg: string; resistancePercent: string; instabilityPercent: string; composition: CompositionRow[] }
type CargoRow = { id: string; commodity: string; scu: string }

let rowCounter = 0
const rowId = () => `ocr-row-${++rowCounter}`
const fieldText = (value?: number) => value === undefined ? '' : String(value)

function toScanForm(parsed: ParsedRockScan): ScanForm {
  const parts = parsed.composition.length ? parsed.composition.map((part) => ({ commodity: part.commodity, percent: String(part.percent) })) : [{ commodity: '', percent: '' }]
  return {
    massKg: fieldText(parsed.massKg),
    resistancePercent: fieldText(parsed.resistancePercent),
    instabilityPercent: fieldText(parsed.instabilityPercent),
    composition: parts.map((part) => ({ id: rowId(), ...part })),
  }
}

export function ScanScreenReader({ scans, minerals, activeShipName, onAdd, onSyncCargo }: {
  scans: RockScan[]
  minerals: string[]
  activeShipName?: string
  onAdd: (scan: NewRockScan) => string
  onSyncCargo: (ore: Record<string, number>) => string
}) {
  const [sourceKind, setSourceKind] = useState<'none' | 'screen' | 'image'>('none')
  const [imageUrl, setImageUrl] = useState('')
  const [regions, setRegions] = useState<Record<RegionTarget, ScanRegion | null>>(() => ({ scan: loadRegion('scan'), cargo: loadRegion('cargo') }))
  const [target, setTarget] = useState<RegionTarget>('scan')
  const [draft, setDraft] = useState<ScanRegion | null>(null)
  const [location, setLocation] = useState(readStoredLocation)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [auto, setAuto] = useState(false)
  const [scanForm, setScanForm] = useState<ScanForm | null>(null)
  const [scanDirty, setScanDirty] = useState(false)
  const [cargoRows, setCargoRows] = useState<CargoRow[] | null>(null)
  const [cargoUnmatched, setCargoUnmatched] = useState<string[]>([])
  const [cargoDirty, setCargoDirty] = useState(false)
  const [rawText, setRawText] = useState('')
  const [sources, setSources] = useState<ScreenSource[]>([])
  const [sourceId, setSourceId] = useState('')
  const videoRef = useRef<HTMLVideoElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const workerRef = useRef<Promise<OcrWorker> | null>(null)
  const dragStartRef = useRef<{ x: number; y: number } | null>(null)
  const busyRef = useRef(false)
  const pendingScanRef = useRef('')
  const filledScanRef = useRef('')
  const pendingCargoRef = useRef('')
  const filledCargoRef = useRef('')
  const screenCaptureSupported = typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getDisplayMedia)

  useEffect(() => {
    const bridge = window.starCitizenBridge
    if (!bridge?.listScreenSources) return
    bridge.listScreenSources().then(setSources).catch(() => setSources([]))
  }, [])

  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    void workerRef.current?.then((worker) => worker.terminate())
  }, [])

  useEffect(() => () => { if (imageUrl) URL.revokeObjectURL(imageUrl) }, [imageUrl])

  function stopScreen() {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    setAuto(false)
  }

  async function startScreen() {
    try {
      await window.starCitizenBridge?.selectScreenSource?.(sourceId || null)
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false })
      stopScreen()
      streamRef.current = stream
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        stopScreen()
        setSourceKind('none')
      })
      setImageUrl('')
      setSourceKind('screen')
      setStatus('Screen capture active. Drag over the SCAN RESULTS panel to set the read area.')
    } catch {
      setStatus('Screen capture was cancelled or is unavailable.')
    }
  }

  useEffect(() => {
    if (sourceKind !== 'screen' || !videoRef.current || !streamRef.current) return
    videoRef.current.srcObject = streamRef.current
    void videoRef.current.play().catch(() => undefined)
  }, [sourceKind])

  function loadImage(file: File | undefined) {
    if (!file || !file.type.startsWith('image/')) return
    stopScreen()
    setImageUrl(URL.createObjectURL(file))
    setSourceKind('image')
    setStatus('Image loaded. Drag over the SCAN RESULTS panel to set the read area.')
  }

  function getWorker() {
    workerRef.current ??= import('tesseract.js').then(async ({ createWorker, PSM }) => {
      const worker = await createWorker('eng')
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK, preserve_interword_spaces: '1', tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,:%()/- ' })
      return worker
    })
    workerRef.current.catch(() => { workerRef.current = null })
    return workerRef.current
  }

  function captureRegion(region: ScanRegion) {
    const video = videoRef.current
    const image = imageRef.current
    const source = sourceKind === 'screen' ? video : image
    const width = sourceKind === 'screen' ? video?.videoWidth ?? 0 : image?.naturalWidth ?? 0
    const height = sourceKind === 'screen' ? video?.videoHeight ?? 0 : image?.naturalHeight ?? 0
    if (!source || !width || !height) return null

    const sx = Math.round(region.x * width)
    const sy = Math.round(region.y * height)
    const sw = Math.max(1, Math.round(region.width * width))
    const sh = Math.max(1, Math.round(region.height * height))
    const scale = Math.min(4, Math.max(1, 1200 / sw))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(sw * scale)
    canvas.height = Math.round(sh * scale)
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return null
    context.imageSmoothingQuality = 'high'
    context.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)

    // HUD text is bright and colored on a dark background; OCR prefers crisp dark text on white.
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
    const data = pixels.data
    let darkest = 255
    let brightest = 0
    for (let index = 0; index < data.length; index += 4) {
      const brightness = Math.max(data[index], data[index + 1], data[index + 2])
      data[index] = brightness
      darkest = Math.min(darkest, brightness)
      brightest = Math.max(brightest, brightness)
    }
    const range = Math.max(1, brightest - darkest)
    for (let index = 0; index < data.length; index += 4) {
      const value = 255 - Math.round(((data[index] - darkest) / range) * 255)
      data[index] = value
      data[index + 1] = value
      data[index + 2] = value
    }
    context.putImageData(pixels, 0, 0)
    return canvas
  }

  async function readRegion() {
    if (busyRef.current) return null
    const scanCanvas = regions.scan ? captureRegion(regions.scan) : null
    const cargoCanvas = regions.cargo ? captureRegion(regions.cargo) : null
    if (!scanCanvas && !cargoCanvas) {
      setStatus(regions.scan || regions.cargo ? 'Capture source is not ready yet.' : 'Select a read area first.')
      return null
    }
    busyRef.current = true
    setBusy(true)
    try {
      const worker = await getWorker()
      const texts: string[] = []
      let parsed: ParsedRockScan | undefined
      let cargo: CargoReading | undefined
      if (scanCanvas) {
        const { data } = await worker.recognize(scanCanvas)
        parsed = parseScanText(data.text, minerals)
        texts.push(`--- SCAN RESULTS ---\n${data.text}`)
      }
      if (cargoCanvas) {
        const { data } = await worker.recognize(cargoCanvas)
        cargo = parseCargoText(data.text, minerals)
        texts.push(`--- CARGO ---\n${data.text}`)
      }
      setRawText(texts.join('\n'))
      return { parsed, cargo }
    } catch {
      setStatus('Text recognition failed. Check your connection the first time OCR loads, then try again.')
      return null
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  function fillScan(parsed: ParsedRockScan) {
    setScanForm(toScanForm(parsed))
    setScanDirty(false)
    filledScanRef.current = scanSignature(parsed)
  }

  function fillCargo(reading: CargoReading) {
    setCargoRows(reading.items.map((item) => ({ id: rowId(), commodity: item.commodity, scu: String(item.scu) })))
    setCargoUnmatched(reading.unmatched)
    setCargoDirty(false)
    filledCargoRef.current = cargoSignature(reading)
  }

  async function readNow() {
    const read = await readRegion()
    if (read?.parsed) fillScan(read.parsed)
    if (read?.cargo) fillCargo(read.cargo)
    if (read) setStatus('Review the values below, correct any misreads, then save.')
  }

  function updateScanForm(update: (form: ScanForm) => ScanForm) {
    setScanForm((current) => current && update(current))
    setScanDirty(true)
  }

  function updateCompositionRow(id: string, field: 'commodity' | 'percent', value: string) {
    updateScanForm((form) => ({ ...form, composition: form.composition.map((row) => row.id === id ? { ...row, [field]: value } : row) }))
  }

  function discardScan() {
    setScanForm(null)
    setScanDirty(false)
  }

  function saveScan() {
    if (!scanForm) return
    const composition = scanForm.composition
      .filter((row) => row.commodity.trim() || row.percent.trim())
      .map((row) => ({ commodity: row.commodity.trim(), percent: Number(row.percent) }))
    const scan = { massKg: Number(scanForm.massKg), resistancePercent: Number(scanForm.resistancePercent), instabilityPercent: Number(scanForm.instabilityPercent), composition }
    if (scans.slice(0, 50).some((saved) => scanSignature(saved) === scanSignature(scan))) {
      setStatus('This scan is already saved.')
      return
    }
    const mineral = primaryMineral(scan)
    const message = onAdd({ label: `${mineral} rock`, location: location.trim() || 'Unspecified location', ...scan })
    if (message && !message.startsWith('Scan saved')) {
      setStatus(message)
      return
    }
    discardScan()
    setStatus(`Saved ${mineral} scan at ${new Date().toLocaleTimeString()}.`)
  }

  function updateCargoRow(id: string, field: 'commodity' | 'scu', value: string) {
    setCargoRows((rows) => rows && rows.map((row) => row.id === id ? { ...row, [field]: value } : row))
    setCargoDirty(true)
  }

  function discardCargo() {
    setCargoRows(null)
    setCargoUnmatched([])
    setCargoDirty(false)
  }

  function applyCargo() {
    if (!cargoRows) return
    const ore = Object.fromEntries(cargoRows
      .filter((row) => row.commodity.trim() && Number(row.scu) > 0)
      .map((row) => [row.commodity.trim(), Number(row.scu)]))
    if (!Object.keys(ore).length) {
      setStatus('Enter at least one ore amount.')
      return
    }
    const message = onSyncCargo(ore)
    if (message) {
      setStatus(message)
      return
    }
    discardCargo()
    setStatus(`Updated ${activeShipName ?? 'active ship'} cargo at ${new Date().toLocaleTimeString()}.`)
  }

  // Auto capture only fills the review forms; nothing is saved without a click.
  const autoTick = useEffectEvent(async () => {
    const read = await readRegion()
    if (read?.parsed) {
      const signature = scanSignature(read.parsed)
      // Two matching reads in a row avoid filling from a half-rendered panel.
      if (signature === pendingScanRef.current && signature !== filledScanRef.current) {
        if (scanDirty) setStatus('A new scan was read. Save or discard your edits to load it.')
        else fillScan(read.parsed)
      }
      pendingScanRef.current = signature
    }
    if (read?.cargo?.items.length) {
      const signature = cargoSignature(read.cargo)
      if (signature === pendingCargoRef.current && signature !== filledCargoRef.current) {
        if (cargoDirty) setStatus('A new cargo reading is ready. Update or discard your edits to load it.')
        else fillCargo(read.cargo)
      }
      pendingCargoRef.current = signature
    }
  })

  useEffect(() => {
    if (!auto) return
    pendingScanRef.current = ''
    pendingCargoRef.current = ''
    const timer = window.setInterval(() => { void autoTick() }, autoReadIntervalMs)
    return () => window.clearInterval(timer)
  }, [auto])

  function pointerPosition(event: React.PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect()
    return {
      x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
      y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)),
    }
  }

  function finishDrag(event: React.PointerEvent<HTMLDivElement>) {
    const start = dragStartRef.current
    dragStartRef.current = null
    setDraft(null)
    if (!start) return
    const next = normalizeRegion(start, pointerPosition(event))
    if (next.width < 0.01 || next.height < 0.01) return
    setRegions((current) => ({ ...current, [target]: next }))
    try { window.localStorage.setItem(regionKeys[target], JSON.stringify(next)) } catch { /* region stays for this session */ }
    setStatus(`${regionLabels[target]} area saved. Use Read now or enable auto capture.`)
  }

  function clearRegion() {
    setRegions((current) => ({ ...current, [target]: null }))
    try { window.localStorage.removeItem(regionKeys[target]) } catch { /* nothing stored */ }
    if (target === 'cargo') discardCargo()
    else discardScan()
    setStatus(`${regionLabels[target]} area cleared.`)
  }

  function updateLocation(value: string) {
    setLocation(value)
    try { window.localStorage.setItem(locationKey, value) } catch { /* location stays for this session */ }
  }

  const compositionTotal = scanForm ? scanForm.composition.reduce((sum, row) => sum + (Number(row.percent) || 0), 0) : 0
  const anyRegion = Boolean(regions.scan || regions.cargo)

  return <section className="data-section scan-reader-section">
    <div className="section-toolbar"><div><h2>Scan screen reader</h2><span>Read the in-game SCAN RESULTS and CARGO panels to log scans and update your active ship's ore.</span></div><span className="table-label">{auto ? 'AUTO CAPTURE' : sourceKind === 'screen' ? 'SCREEN LIVE' : sourceKind === 'image' ? 'IMAGE' : 'OCR'}</span></div>
    <div className="mining-scan-form scan-reader-controls">
      <label><span>LOCATION FOR SAVED SCANS</span><input value={location} onChange={(event) => updateLocation(event.target.value)} placeholder="System, belt, or site" maxLength={100} /></label>
      {sources.length > 0 && <label><span>CAPTURE SOURCE</span><select value={sourceId} onChange={(event) => setSourceId(event.target.value)}><option value="">Primary screen</option>{sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}</select></label>}
      <div className="scan-reader-buttons">
        {screenCaptureSupported && (sourceKind === 'screen'
          ? <button className="secondary-button" type="button" onClick={() => { stopScreen(); setSourceKind('none') }}>Stop capture</button>
          : <button className="secondary-button" type="button" onClick={() => { void startScreen() }}>Capture screen</button>)}
        <label className="secondary-button scan-reader-file">Load screenshot<input type="file" accept="image/*" onChange={(event) => { loadImage(event.target.files?.[0]); event.target.value = '' }} /></label>
      </div>
    </div>
    {sourceKind !== 'none' && <div className="scan-reader-target">
      <span>EDITING AREA</span>
      <div className="scan-reader-target-choices" role="radiogroup" aria-label="Read area to edit">
        {(['scan', 'cargo'] as const).map((option) => <button type="button" role="radio" aria-checked={target === option} className={`scan-reader-target-choice ${option} ${target === option ? 'selected' : ''}`} key={option} onClick={() => setTarget(option)}>
          <i aria-hidden="true" />{regionLabels[option]}<small>{regions[option] ? 'SET' : 'NOT SET'}</small>
        </button>)}
      </div>
      <button className="text-button" type="button" disabled={!regions[target]} onClick={clearRegion}>Clear area</button>
    </div>}
    {sourceKind !== 'none' && <div className="scan-reader-preview">
      {sourceKind === 'screen' ? <video ref={videoRef} muted playsInline /> : <img ref={imageRef} src={imageUrl} alt="Scan source" />}
      <div
        className="scan-reader-overlay"
        onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); dragStartRef.current = pointerPosition(event); setDraft(null) }}
        onPointerMove={(event) => { if (dragStartRef.current) setDraft(normalizeRegion(dragStartRef.current, pointerPosition(event))) }}
        onPointerUp={finishDrag}
        onPointerCancel={() => { dragStartRef.current = null; setDraft(null) }}
      >
        {(['scan', 'cargo'] as const).map((option) => {
          const shown = option === target ? draft ?? regions[option] : regions[option]
          return shown && <div className={`scan-reader-region ${option} ${option === target ? 'active' : ''}`} key={option} style={{ left: `${shown.x * 100}%`, top: `${shown.y * 100}%`, width: `${shown.width * 100}%`, height: `${shown.height * 100}%` }}><span>{regionLabels[option]}</span></div>
        })}
      </div>
    </div>}
    <div className="scan-reader-actions">
      <button className="secondary-button" type="button" disabled={sourceKind === 'none' || !anyRegion || busy} onClick={() => { void readNow() }}>{busy ? 'Reading…' : 'Read now'}</button>
      <label className="scan-reader-auto"><input type="checkbox" checked={auto} disabled={sourceKind !== 'screen' || !anyRegion} onChange={(event) => setAuto(event.target.checked)} /><span>Auto fill every {autoReadIntervalMs / 1000}s</span></label>
      {status && <span className="scan-reader-status" role="status">{status}</span>}
    </div>
    <datalist id="scan-reader-minerals">{minerals.map((mineral) => <option key={mineral} value={mineral} />)}<option value="Inert Materials" /></datalist>
    {scanForm && <form className="mining-scan-form scan-reader-review" onSubmit={(event) => { event.preventDefault(); saveScan() }}>
      <div className="scan-reader-review-head"><strong>Review scan</strong><span>{scanDirty ? 'EDITED' : 'READ FROM SCREEN'}</span></div>
      <label><span>MASS</span><div className="number-input"><input type="number" min="1" step="any" value={scanForm.massKg} onChange={(event) => updateScanForm((form) => ({ ...form, massKg: event.target.value }))} placeholder="Not read" required /><span>KG</span></div></label>
      <label><span>RESISTANCE</span><div className="number-input"><input type="number" min="0" max="100" step="any" value={scanForm.resistancePercent} onChange={(event) => updateScanForm((form) => ({ ...form, resistancePercent: event.target.value }))} placeholder="Not read" required /><span>%</span></div></label>
      <label><span>INSTABILITY</span><div className="number-input"><input type="number" min="0" step="any" value={scanForm.instabilityPercent} onChange={(event) => updateScanForm((form) => ({ ...form, instabilityPercent: event.target.value }))} placeholder="Not read" required /></div></label>
      <div className="mining-scan-composition">
        <div className="mining-scan-composition-head"><div><span>COMPOSITION</span><small className={compositionTotal > 100.05 ? 'scan-reader-warning' : ''}>{compositionTotal.toFixed(2)}% total{compositionTotal > 100.05 ? ' · over 100%, check for 0/8 misreads' : ''}</small></div><button className="text-button" type="button" onClick={() => updateScanForm((form) => ({ ...form, composition: [...form.composition, { id: rowId(), commodity: '', percent: '' }] }))}>+ Add mineral</button></div>
        {scanForm.composition.map((row) => <div className="mining-scan-composition-row" key={row.id}>
          <input aria-label="Mineral" list="scan-reader-minerals" value={row.commodity} onChange={(event) => updateCompositionRow(row.id, 'commodity', event.target.value)} placeholder="Mineral" />
          <div className="number-input"><input aria-label="Mineral percent" type="number" min="0" max="100" step="any" value={row.percent} onChange={(event) => updateCompositionRow(row.id, 'percent', event.target.value)} /><span>%</span></div>
          <button className="remove-account" type="button" aria-label="Remove mineral row" onClick={() => updateScanForm((form) => ({ ...form, composition: form.composition.filter((item) => item.id !== row.id) }))}>×</button>
        </div>)}
      </div>
      <div className="mining-scan-submit"><span>Check each value against the game before saving.</span><div className="scan-reader-review-actions"><button className="text-button" type="button" onClick={discardScan}>Discard</button><button className="primary-button" type="submit">Save scan</button></div></div>
    </form>}
    {cargoRows && <form className="mining-scan-form scan-reader-review" onSubmit={(event) => { event.preventDefault(); applyCargo() }}>
      <div className="scan-reader-review-head"><strong>Review cargo</strong><span>{cargoDirty ? 'EDITED' : 'READ FROM SCREEN'}</span></div>
      <div className="mining-scan-composition">
        <div className="mining-scan-composition-head"><div><span>CARGO ORE</span><small>{cargoUnmatched.length ? `Not matched to UEX: ${cargoUnmatched.join(', ')}` : 'Amounts replace this ore on the active ship.'}</small></div><button className="text-button" type="button" onClick={() => { setCargoRows((rows) => [...(rows ?? []), { id: rowId(), commodity: '', scu: '' }]); setCargoDirty(true) }}>+ Add ore</button></div>
        {cargoRows.map((row) => <div className="mining-scan-composition-row" key={row.id}>
          <input aria-label="Ore" list="scan-reader-minerals" value={row.commodity} onChange={(event) => updateCargoRow(row.id, 'commodity', event.target.value)} placeholder="Ore" />
          <div className="number-input"><input aria-label="Ore amount" type="number" min="0" step="0.01" value={row.scu} onChange={(event) => updateCargoRow(row.id, 'scu', event.target.value)} /><span>SCU</span></div>
          <button className="remove-account" type="button" aria-label="Remove ore row" onClick={() => { setCargoRows((rows) => rows && rows.filter((item) => item.id !== row.id)); setCargoDirty(true) }}>×</button>
        </div>)}
        {!cargoRows.length && <small className="scan-reader-empty">No ores read. Add them manually or adjust the cargo area.</small>}
      </div>
      <div className="mining-scan-submit"><span>{activeShipName ? `Updates ore on ${activeShipName}.` : 'Select an active ship in Personal hangar first.'}</span><div className="scan-reader-review-actions"><button className="text-button" type="button" onClick={discardCargo}>Discard</button><button className="primary-button" type="submit" disabled={!activeShipName}>Update {activeShipName ?? 'ship'} cargo</button></div></div>
    </form>}
    {rawText && <div className="scan-reader-result">
      <details><summary>Recognized text</summary><pre>{rawText}</pre></details>
    </div>}
    <div className="table-note"><span>Capture stays on this device. Only the selected area is read.</span><span>OCR language data downloads on first use.</span></div>
  </section>
}
