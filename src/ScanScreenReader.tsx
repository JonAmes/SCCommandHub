import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import type { NewRockScan, RockScan } from './miningOps'
import { captureScanRegion, captureScreenBurst, createScanWorker, discoverScanPanels, recognizeScanRegion } from './scanRecognition'
import { captureDelay } from './ocrCapture'
import { isCompleteScan, primaryMineral, scanSignature, type CargoReading, type ParsedRockScan, type ScanRegion } from './scanOcr'

const locationKey = 'sc-command-hub.scan-reader-location-v1'
const autoReadIntervalMs = 2500

type OcrWorker = Awaited<ReturnType<typeof import('tesseract.js')['createWorker']>>
type ScreenSource = { id: string; name: string; kind: 'screen' | 'window'; isPrimary?: boolean; isGame?: boolean }
type ImageSourceMode = 'primary' | 'apps' | 'game'
type RegionTarget = 'scan' | 'cargo'

const regionLabels: Record<RegionTarget, string> = { scan: 'Scan results', cargo: 'Cargo' }

function readStoredLocation() {
  try {
    return window.localStorage.getItem(locationKey) ?? ''
  } catch {
    return ''
  }
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
  const [imageSourceMode, setImageSourceMode] = useState<ImageSourceMode>('primary')
  const [sourceReady, setSourceReady] = useState(false)
  const [sourceRatio, setSourceRatio] = useState(16 / 9)
  const [regions, setRegions] = useState<Record<RegionTarget, ScanRegion | null>>({ scan: null, cargo: null })
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
  const [readWarnings, setReadWarnings] = useState<string[]>([])
  const [sources, setSources] = useState<ScreenSource[]>([])
  const [appSourceId, setAppSourceId] = useState('')
  const videoRef = useRef<HTMLVideoElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const pendingImageRef = useRef<HTMLImageElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const workerRef = useRef<Promise<OcrWorker> | null>(null)
  const busyRef = useRef(false)
  const revisionRef = useRef(0)
  const burstRef = useRef<AbortController | null>(null)
  const pendingBurstRef = useRef(false)
  const pendingScanRef = useRef('')
  const filledScanRef = useRef('')
  const pendingCargoRef = useRef('')
  const filledCargoRef = useRef('')
  const screenCaptureSupported = typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getDisplayMedia)
  const desktopSourcesSupported = Boolean(window.starCitizenBridge?.listScreenSources)
  const mobileDeviceDetected = ['android', 'ios'].includes(Capacitor.getPlatform()) || typeof navigator !== 'undefined' && (
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || /Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1
  )

  useEffect(() => {
    const bridge = window.starCitizenBridge
    if (!bridge?.listScreenSources) return
    bridge.listScreenSources().then(setSources).catch(() => setStatus('Capture sources could not be listed. Try opening the app selector again.'))
  }, [])

  async function refreshSources() {
    const available = await window.starCitizenBridge?.listScreenSources?.() ?? []
    setSources(available)
    setAppSourceId((current) => available.some((source) => source.kind === 'window' && source.id === current) ? current : '')
    return available
  }

  useEffect(() => () => {
    revisionRef.current += 1
    burstRef.current?.abort()
    streamRef.current?.getTracks().forEach((track) => track.stop())
    void workerRef.current?.then((worker) => worker.terminate()).catch(() => undefined)
  }, [])

  useEffect(() => () => { if (imageUrl.startsWith('blob:')) URL.revokeObjectURL(imageUrl) }, [imageUrl])

  function stopScreen() {
    revisionRef.current += 1
    burstRef.current?.abort()
    pendingBurstRef.current = false
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    setAuto(false)
    setSourceReady(false)
    pendingScanRef.current = ''
    pendingCargoRef.current = ''
    filledScanRef.current = ''
    filledCargoRef.current = ''
  }

  async function startScreen() {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    const revision = revisionRef.current
    try {
      const bridge = window.starCitizenBridge
      if (bridge?.listScreenSources) {
        const available = await refreshSources()
        if (revision !== revisionRef.current) return
        const candidates = available.filter((source) => imageSourceMode === 'primary'
          ? source.kind === 'screen' && source.isPrimary
          : imageSourceMode === 'game' ? source.kind === 'window' && source.isGame : source.kind === 'window' && source.id === appSourceId)
        if (candidates.length !== 1) {
          setStatus(imageSourceMode === 'primary' ? 'The primary screen is unavailable. Select another image source.' : imageSourceMode === 'game' ? 'Star Citizen was not found unambiguously. Select another image source.' : 'Choose an available app window, then click Capture screen.')
          return
        }
        if (!await bridge.selectScreenSource?.(candidates[0].id)) throw new Error('Capture source is unavailable')
      } else setStatus('Choose the desired screen or window in the browser sharing picker.')
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false })
      if (revision !== revisionRef.current) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      stopScreen()
      if (!scanDirty) discardScan()
      if (!cargoDirty) discardCargo()
      setRawText('')
      setReadWarnings([])
      streamRef.current = stream
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        stopScreen()
        setSourceKind('none')
      })
      setImageUrl('')
      setRegions({ scan: null, cargo: null })
      burstRef.current = new AbortController()
      pendingBurstRef.current = true
      setSourceReady(false)
      setSourceKind('screen')
      setStatus('Waiting for the selected source...')
    } catch {
      if (revision === revisionRef.current) setStatus('Screen capture was cancelled or is unavailable. Select an available source and try again.')
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const beginCaptureBurst = useEffectEvent(async (video: HTMLVideoElement) => {
    const controller = burstRef.current
    if (!controller || controller.signal.aborted) return
    const revision = revisionRef.current
    busyRef.current = true
    setBusy(true)
    try {
      const worker = await getWorker()
      controller.signal.throwIfAborted()
      let attempts = 0
      while (!controller.signal.aborted) {
        const result = await captureScreenBurst(worker, video, minerals, {
          signal: controller.signal,
          onProgress: (message) => { if (!controller.signal.aborted) setStatus(message) },
          onRegions: (value) => { if (!controller.signal.aborted) setRegions(value) },
        })
        if (revision !== revisionRef.current || controller.signal.aborted) return
        setRawText(result.text)
        setReadWarnings(result.warnings)
        if (result.parsed && !scanDirty) fillScan(result.parsed)
        if (result.cargo && !cargoDirty) fillCargo(result.cargo)
        if (result.parsed || result.cargo) {
          setStatus(scanDirty || cargoDirty ? 'Save or discard your edits before loading a new reading.' : 'Three cropped captures compared. Review the agreed values, then save.')
          break
        }
        attempts += 1
        setStatus(`No stable reading. Rediscovering panels (attempt ${attempts})...`)
        await captureDelay(controller.signal, Math.min(5000, attempts * 1000))
      }
    } catch (error) {
      if (revision === revisionRef.current && !controller.signal.aborted) setStatus(error instanceof Error ? error.message : 'Capture failed. Restart capture to rediscover panels.')
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  })

  useEffect(() => {
    if (sourceKind !== 'screen' || !videoRef.current || !streamRef.current) return
    const video = videoRef.current
    let width = video.videoWidth
    let height = video.videoHeight
    const resized = () => {
      if (width && height && (video.videoWidth !== width || video.videoHeight !== height)) {
        setRegions({ scan: null, cargo: null })
        setStatus('Capture dimensions changed. Rediscovering panels on the next read.')
      }
      width = video.videoWidth
      height = video.videoHeight
      if (width && height) setSourceRatio(width / height)
    }
    video.addEventListener('resize', resized)
    video.srcObject = streamRef.current
    void video.play().catch(() => undefined)
    if (pendingBurstRef.current) {
      pendingBurstRef.current = false
      void beginCaptureBurst(videoRef.current)
    }
    return () => video.removeEventListener('resize', resized)
  }, [sourceKind])

  const cameraInputRef = useRef<HTMLInputElement>(null)

  async function takeCameraPicture() {
    if (typeof window !== 'undefined' && (window as any).Capacitor?.Plugins?.TextScanner) {
      try {
        const res = await (window as any).Capacitor.Plugins.TextScanner.scanText()
        if (res?.imageUrl) {
          openImage(res.imageUrl)
          if (res.text) {
            setRawText(res.text)
          }
        }
      } catch (err: any) {
        if (err?.message && !err.message.includes('cancelled')) {
          setStatus(`Camera error: ${err.message}`)
        }
      }
    } else {
      cameraInputRef.current?.click()
    }
  }

  function loadImage(file: File | undefined) {
    if (!file || !file.type.startsWith('image/')) return
    setRegions({ scan: null, cargo: null })
    openImage(URL.createObjectURL(file))
  }

  function openImage(url: string) {
    stopScreen()
    if (!scanDirty) discardScan()
    if (!cargoDirty) discardCargo()
    setSourceReady(false)
    setRawText('')
    setReadWarnings([])
    pendingScanRef.current = ''
    pendingCargoRef.current = ''
    setImageUrl(url)
    setSourceKind('image')
    setStatus('Image loaded. Discovering panels automatically...')
  }

  function getWorker() {
    workerRef.current ??= createScanWorker()
    workerRef.current.catch(() => { workerRef.current = null })
    return workerRef.current
  }

  async function discoverImage(image: HTMLImageElement) {
    const revision = revisionRef.current
    if (busyRef.current) { pendingImageRef.current = image; return }
    busyRef.current = true
    setBusy(true)
    try {
      const frame = document.createElement('canvas')
      frame.width = image.naturalWidth
      frame.height = image.naturalHeight
      frame.getContext('2d')!.drawImage(image, 0, 0)
      const found = await discoverScanPanels(await getWorker(), frame)
      if (revision !== revisionRef.current) return
      setRegions(found.regions)
      setStatus(found.regions.scan || found.regions.cargo ? 'Panels discovered. Screenshot readings require review.' : 'No supported panels found. Load another screenshot.')
    } catch {
      if (revision === revisionRef.current) setStatus('Automatic panel discovery failed. Try another screenshot.')
    } finally {
      busyRef.current = false
      setBusy(false)
      const pending = pendingImageRef.current
      pendingImageRef.current = null
      if (pending && pending === imageRef.current && pending.complete && pending.naturalWidth) void discoverImage(pending)
    }
  }

  async function readRegion() {
    if (busyRef.current || !sourceReady) return null
    const revision = revisionRef.current
    busyRef.current = true
    setBusy(true)
    try {
      const worker = await getWorker()
      const source = sourceKind === 'screen' ? videoRef.current : imageRef.current
      const width = sourceKind === 'screen' ? videoRef.current?.videoWidth : imageRef.current?.naturalWidth
      const height = sourceKind === 'screen' ? videoRef.current?.videoHeight : imageRef.current?.naturalHeight
      if (!source || !width || !height) return null
      const frame = document.createElement('canvas')
      frame.width = width
      frame.height = height
      frame.getContext('2d')!.drawImage(source, 0, 0)
      const found = await discoverScanPanels(worker, frame)
      if (revision !== revisionRef.current) return null
      setRegions(found.regions)
      const scanCanvas = found.regions.scan ? captureScanRegion(frame, width, height, found.regions.scan) : null
      const cargoCanvas = found.regions.cargo ? captureScanRegion(frame, width, height, found.regions.cargo) : null
      if (!scanCanvas && !cargoCanvas) { setStatus('No supported panels visible. Waiting for a new view.'); return null }
      const texts: string[] = []
      const warnings: string[] = []
      let scanSafe = false
      let cargoSafe = false
      let parsed: ParsedRockScan | undefined
      let cargo: CargoReading | undefined
      if (scanCanvas) {
        const reading = await recognizeScanRegion(worker, scanCanvas, 'scan', minerals)
        parsed = reading.parsed
        scanSafe = reading.warnings.length === 0
        warnings.push(...reading.warnings)
        texts.push(`--- SCAN RESULTS (${reading.passes} passes, ${reading.elapsedMs}ms) ---\n${reading.text}`)
      }
      if (cargoCanvas) {
        const reading = await recognizeScanRegion(worker, cargoCanvas, 'cargo', minerals)
        cargo = reading.cargo
        cargoSafe = reading.warnings.length === 0
        warnings.push(...reading.warnings)
        texts.push(`--- CARGO (${reading.passes} passes, ${reading.elapsedMs}ms) ---\n${reading.text}`)
      }
      if (revision !== revisionRef.current) return null
      setRawText(texts.join('\n'))
      setReadWarnings([...new Set(warnings)])
      return { parsed, cargo, scanSafe, cargoSafe }
    } catch {
      if (revision === revisionRef.current) setStatus('Text recognition failed. Check your connection the first time OCR loads, then try again.')
      return null
    } finally {
      busyRef.current = false
      setBusy(false)
      const pending = pendingImageRef.current
      pendingImageRef.current = null
      if (pending && pending === imageRef.current && pending.complete && pending.naturalWidth) void discoverImage(pending)
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
    if (scanDirty || cargoDirty) {
      setStatus('Save or discard your edits before reading again.')
      return
    }
    const read = await readRegion()
    if (read?.parsed) fillScan(read.parsed)
    if (read?.cargo) fillCargo(read.cargo)
    if (read) setStatus('Review the values below, correct any misreads, then save.')
  }

  function updateScanForm(update: (form: ScanForm) => ScanForm) {
    revisionRef.current += 1
    burstRef.current?.abort()
    setScanForm((current) => current && update(current))
    setScanDirty(true)
  }

  function updateCompositionRow(id: string, field: 'commodity' | 'percent', value: string) {
    updateScanForm((form) => ({ ...form, composition: form.composition.map((row) => row.id === id ? { ...row, [field]: value } : row) }))
  }

  function discardScan() {
    revisionRef.current += 1
    burstRef.current?.abort()
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
    revisionRef.current += 1
    burstRef.current?.abort()
    setCargoRows((rows) => rows && rows.map((row) => row.id === id ? { ...row, [field]: value } : row))
    setCargoDirty(true)
  }

  function discardCargo() {
    revisionRef.current += 1
    burstRef.current?.abort()
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
    if (!read) return
    if (read.parsed && read.scanSafe && isCompleteScan(read.parsed)) {
      const signature = scanSignature(read.parsed)
      // Two matching reads in a row avoid filling from a half-rendered panel.
      if (signature === pendingScanRef.current && signature !== filledScanRef.current) {
        if (scanDirty) setStatus('A new scan was read. Save or discard your edits to load it.')
        else fillScan(read.parsed)
      }
      pendingScanRef.current = signature
    } else pendingScanRef.current = ''
    if (read.cargo?.items.length && read.cargoSafe) {
      const signature = cargoSignature(read.cargo)
      if (signature === pendingCargoRef.current && signature !== filledCargoRef.current) {
        if (cargoDirty) setStatus('A new cargo reading is ready. Update or discard your edits to load it.')
        else fillCargo(read.cargo)
      }
      pendingCargoRef.current = signature
    } else pendingCargoRef.current = ''
    if (!read.scanSafe && read.parsed || !read.cargoSafe && read.cargo) setStatus('Uncertain reading. Use Read now to review and correct the values.')
  })

  useEffect(() => {
    if (!auto) return
    pendingScanRef.current = ''
    pendingCargoRef.current = ''
    const timer = window.setInterval(() => { void autoTick() }, autoReadIntervalMs)
    return () => window.clearInterval(timer)
  }, [auto])

  function updateLocation(value: string) {
    setLocation(value)
    try { window.localStorage.setItem(locationKey, value) } catch { /* location stays for this session */ }
  }

  const compositionTotal = scanForm ? scanForm.composition.reduce((sum, row) => sum + (Number(row.percent) || 0), 0) : 0

  return <section className="data-section scan-reader-section">
    <div className="section-toolbar"><div><h2>Scan screen reader</h2><span>Read the in-game SCAN RESULTS and CARGO panels to log scans and update your active ship's ore.</span></div><span className="table-label">{auto ? 'AUTO CAPTURE' : sourceKind === 'screen' ? 'SCREEN LIVE' : sourceKind === 'image' ? 'IMAGE' : 'OCR'}</span></div>
    <div className="mining-scan-form scan-reader-controls">
      <label><span>LOCATION FOR SAVED SCANS</span><input value={location} onChange={(event) => updateLocation(event.target.value)} placeholder="System, belt, or site" maxLength={100} /></label>
      <label><span>IMAGE SOURCE</span><select value={imageSourceMode} disabled={!screenCaptureSupported || busy || sourceKind === 'screen'} onChange={(event) => setImageSourceMode(event.target.value as ImageSourceMode)}><option value="primary">Primary screen</option><option value="apps" disabled={!desktopSourcesSupported}>Running apps</option><option value="game">Star Citizen</option></select></label>
      {imageSourceMode === 'apps' && <label><span>APP WINDOW</span><select value={appSourceId} disabled={!desktopSourcesSupported || busy || sourceKind === 'screen'} onFocus={() => { void refreshSources().catch(() => setStatus('App windows could not be refreshed. Try again.')) }} onChange={(event) => setAppSourceId(event.target.value)}><option value="">Choose an app window</option>{sources.filter((source) => source.kind === 'window').map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}</select></label>}
      <div className="scan-reader-buttons">
        {screenCaptureSupported && (sourceKind === 'screen'
          ? <button className="secondary-button" type="button" onClick={() => { stopScreen(); setSourceKind('none') }}>Stop capture</button>
          : <button className="secondary-button" type="button" disabled={busy} onClick={() => { void startScreen() }}>Capture screen</button>)}
        {mobileDeviceDetected && <button className="secondary-button" type="button" onClick={() => { void takeCameraPicture() }}>Take picture</button>}
        <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={(event) => { loadImage(event.target.files?.[0]); event.target.value = '' }} />
        <label className="secondary-button scan-reader-file">Load screenshot<input type="file" accept="image/*" onChange={(event) => { loadImage(event.target.files?.[0]); event.target.value = '' }} /></label>
      </div>
    </div>
    {sourceKind !== 'none' && <div className="scan-reader-preview" style={{ width: `min(calc(100% - 28px), ${70 * sourceRatio}vh)` }}>
      {sourceKind === 'screen' ? <video ref={videoRef} muted playsInline onLoadedMetadata={(event) => { setSourceRatio(event.currentTarget.videoWidth / event.currentTarget.videoHeight); setSourceReady(true) }} /> : <img key={imageUrl} ref={imageRef} src={imageUrl} alt="Scan source" onLoad={(event) => { setSourceRatio(event.currentTarget.naturalWidth / event.currentTarget.naturalHeight); setSourceReady(true); void discoverImage(event.currentTarget) }} onError={() => { setSourceReady(false); setStatus('This image could not be decoded. Try a PNG or JPEG screenshot.') }} />}
      <div className="scan-reader-overlay" style={{ pointerEvents: 'none', cursor: 'default' }}>
        {(['scan', 'cargo'] as const).map((option) => {
          const shown = regions[option]
          return shown && <div className={`scan-reader-region ${option}`} key={option} style={{ left: `${shown.x * 100}%`, top: `${shown.y * 100}%`, width: `${shown.width * 100}%`, height: `${shown.height * 100}%` }}><span>{regionLabels[option]}</span></div>
        })}
      </div>
    </div>}
    <div className="scan-reader-actions">
      <button className="secondary-button" type="button" disabled={sourceKind === 'none' || !sourceReady || busy} onClick={() => { void readNow() }}>{busy ? 'Reading…' : 'Read now'}</button>
      <label className="scan-reader-auto"><input type="checkbox" checked={auto} disabled={sourceKind !== 'screen'} onChange={(event) => setAuto(event.target.checked)} /><span>Auto fill every {autoReadIntervalMs / 1000}s</span></label>
      {status && <span className="scan-reader-status" role="status">{status}</span>}
    </div>
    {readWarnings.length > 0 && <div className="scan-reader-warnings" role="status">{readWarnings.map((warning) => <p key={warning}>{warning}</p>)}</div>}
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
        <div className="mining-scan-composition-head"><div><span>CARGO ORE</span><small>{cargoUnmatched.length ? `Not matched to UEX: ${cargoUnmatched.join(', ')}` : 'Amounts replace this ore on the active ship.'}</small></div><button className="text-button" type="button" onClick={() => { revisionRef.current += 1; setCargoRows((rows) => [...(rows ?? []), { id: rowId(), commodity: '', scu: '' }]); setCargoDirty(true) }}>+ Add ore</button></div>
        {cargoRows.map((row) => <div className="mining-scan-composition-row" key={row.id}>
          <input aria-label="Ore" list="scan-reader-minerals" value={row.commodity} onChange={(event) => updateCargoRow(row.id, 'commodity', event.target.value)} placeholder="Ore" />
          <div className="number-input"><input aria-label="Ore amount" type="number" min="0" step="0.01" value={row.scu} onChange={(event) => updateCargoRow(row.id, 'scu', event.target.value)} /><span>SCU</span></div>
          <button className="remove-account" type="button" aria-label="Remove ore row" onClick={() => { revisionRef.current += 1; setCargoRows((rows) => rows && rows.filter((item) => item.id !== row.id)); setCargoDirty(true) }}>×</button>
        </div>)}
        {!cargoRows.length && <small className="scan-reader-empty">No ores read. Add a manual entry or wait for a complete cargo panel.</small>}
      </div>
      <div className="mining-scan-submit"><span>{activeShipName ? `Updates ore on ${activeShipName}.` : 'Select an active ship in Personal hangar first.'}</span><div className="scan-reader-review-actions"><button className="text-button" type="button" onClick={discardCargo}>Discard</button><button className="primary-button" type="submit" disabled={!activeShipName}>Update {activeShipName ?? 'ship'} cargo</button></div></div>
    </form>}
    {rawText && <div className="scan-reader-result">
      <details><summary>Recognized text</summary><pre>{rawText}</pre></details>
    </div>}
    <div className="table-note"><span>Capture stays on this device. Areas are discovered automatically.</span><span>{sourceKind === 'image' ? 'Screenshot preview / manual review' : 'OCR language data downloads on first use.'}</span></div>
  </section>
}
