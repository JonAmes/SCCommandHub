import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type { NewRockScan, RockScan } from './miningOps'
import { isCompleteScan, parseScanText, primaryMineral, scanSignature, type ParsedRockScan, type ScanRegion } from './scanOcr'

const regionKey = 'sc-command-hub.scan-reader-region-v1'
const locationKey = 'sc-command-hub.scan-reader-location-v1'
const autoReadIntervalMs = 2500

type OcrWorker = Awaited<ReturnType<typeof import('tesseract.js')['createWorker']>>
type ScreenSource = { id: string; name: string }

function loadRegion(): ScanRegion | null {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(regionKey) ?? 'null')
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

export function ScanScreenReader({ scans, minerals, onAdd }: { scans: RockScan[]; minerals: string[]; onAdd: (scan: NewRockScan) => string }) {
  const [sourceKind, setSourceKind] = useState<'none' | 'screen' | 'image'>('none')
  const [imageUrl, setImageUrl] = useState('')
  const [region, setRegion] = useState<ScanRegion | null>(loadRegion)
  const [draft, setDraft] = useState<ScanRegion | null>(null)
  const [location, setLocation] = useState(readStoredLocation)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [auto, setAuto] = useState(false)
  const [result, setResult] = useState<ParsedRockScan | null>(null)
  const [rawText, setRawText] = useState('')
  const [sources, setSources] = useState<ScreenSource[]>([])
  const [sourceId, setSourceId] = useState('')
  const videoRef = useRef<HTMLVideoElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const workerRef = useRef<Promise<OcrWorker> | null>(null)
  const dragStartRef = useRef<{ x: number; y: number } | null>(null)
  const busyRef = useRef(false)
  const pendingSignatureRef = useRef('')
  const savedSignaturesRef = useRef(new Set<string>())
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
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK, preserve_interword_spaces: '1' })
      return worker
    })
    workerRef.current.catch(() => { workerRef.current = null })
    return workerRef.current
  }

  function captureRegion() {
    if (!region) return null
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

    // HUD text is bright and colored on a dark background; OCR prefers dark text on white.
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
    const data = pixels.data
    for (let index = 0; index < data.length; index += 4) {
      const value = 255 - Math.max(data[index], data[index + 1], data[index + 2])
      data[index] = value
      data[index + 1] = value
      data[index + 2] = value
    }
    context.putImageData(pixels, 0, 0)
    return canvas
  }

  async function readRegion() {
    if (busyRef.current) return null
    const canvas = captureRegion()
    if (!canvas) {
      setStatus(region ? 'Capture source is not ready yet.' : 'Select a read area first.')
      return null
    }
    busyRef.current = true
    setBusy(true)
    try {
      const worker = await getWorker()
      const { data } = await worker.recognize(canvas)
      const parsed = parseScanText(data.text, minerals)
      setRawText(data.text)
      setResult(parsed)
      return parsed
    } catch {
      setStatus('Text recognition failed. Check your connection the first time OCR loads, then try again.')
      return null
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  function saveParsed(parsed: ParsedRockScan) {
    if (!isCompleteScan(parsed)) return false
    const signature = scanSignature(parsed)
    if (savedSignaturesRef.current.has(signature) || scans.slice(0, 50).some((scan) => scanSignature(scan) === signature)) {
      setStatus('This scan is already saved.')
      return false
    }
    const message = onAdd({
      label: `${primaryMineral(parsed)} rock`,
      location: location.trim() || 'Unspecified location',
      massKg: parsed.massKg,
      resistancePercent: parsed.resistancePercent,
      instabilityPercent: parsed.instabilityPercent,
      composition: parsed.composition,
    })
    if (message && !message.startsWith('Scan saved')) {
      setStatus(message)
      return false
    }
    savedSignaturesRef.current.add(signature)
    setStatus(`Saved ${primaryMineral(parsed)} scan at ${new Date().toLocaleTimeString()}.`)
    return true
  }

  const autoTick = useEffectEvent(async () => {
    const parsed = await readRegion()
    if (!parsed || !isCompleteScan(parsed)) {
      pendingSignatureRef.current = ''
      return
    }
    const signature = scanSignature(parsed)
    // Require two matching reads in a row so a half-rendered panel is not saved.
    if (signature === pendingSignatureRef.current && !savedSignaturesRef.current.has(signature)) saveParsed(parsed)
    pendingSignatureRef.current = signature
  })

  useEffect(() => {
    if (!auto) return
    pendingSignatureRef.current = ''
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
    setRegion(next)
    try { window.localStorage.setItem(regionKey, JSON.stringify(next)) } catch { /* region stays for this session */ }
    setStatus('Read area saved. Use Read now or enable auto capture.')
  }

  function updateLocation(value: string) {
    setLocation(value)
    try { window.localStorage.setItem(locationKey, value) } catch { /* location stays for this session */ }
  }

  const shownRegion = draft ?? region
  const complete = result ? isCompleteScan(result) : false

  return <section className="data-section scan-reader-section">
    <div className="section-toolbar"><div><h2>Scan screen reader</h2><span>Read the in-game SCAN RESULTS panel and save it to your scan log.</span></div><span className="table-label">{auto ? 'AUTO CAPTURE' : sourceKind === 'screen' ? 'SCREEN LIVE' : sourceKind === 'image' ? 'IMAGE' : 'OCR'}</span></div>
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
    {sourceKind !== 'none' && <div className="scan-reader-preview">
      {sourceKind === 'screen' ? <video ref={videoRef} muted playsInline /> : <img ref={imageRef} src={imageUrl} alt="Scan source" />}
      <div
        className="scan-reader-overlay"
        onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); dragStartRef.current = pointerPosition(event); setDraft(null) }}
        onPointerMove={(event) => { if (dragStartRef.current) setDraft(normalizeRegion(dragStartRef.current, pointerPosition(event))) }}
        onPointerUp={finishDrag}
        onPointerCancel={() => { dragStartRef.current = null; setDraft(null) }}
      >
        {shownRegion && <div className="scan-reader-region" style={{ left: `${shownRegion.x * 100}%`, top: `${shownRegion.y * 100}%`, width: `${shownRegion.width * 100}%`, height: `${shownRegion.height * 100}%` }} />}
      </div>
    </div>}
    <div className="scan-reader-actions">
      <button className="secondary-button" type="button" disabled={sourceKind === 'none' || !region || busy} onClick={() => { void readRegion() }}>{busy ? 'Reading…' : 'Read now'}</button>
      <label className="scan-reader-auto"><input type="checkbox" checked={auto} disabled={sourceKind !== 'screen' || !region} onChange={(event) => setAuto(event.target.checked)} /><span>Auto capture new scans every {autoReadIntervalMs / 1000}s</span></label>
      {status && <span className="scan-reader-status" role="status">{status}</span>}
    </div>
    {result && <div className="scan-reader-result">
      <div className="mining-scan-metrics">
        <div><span>MASS</span><strong>{result.massKg !== undefined ? `${result.massKg.toLocaleString()} kg` : 'Not read'}</strong></div>
        <div><span>RESISTANCE</span><strong>{result.resistancePercent !== undefined ? `${result.resistancePercent}%` : 'Not read'}</strong></div>
        <div><span>INSTABILITY</span><strong>{result.instabilityPercent ?? 'Not read'}</strong></div>
      </div>
      <div className="mining-scan-composition-summary"><span>COMPOSITION</span>{result.composition.length ? result.composition.map((part, index) => <span className="mining-scan-mineral" key={`${part.commodity}-${index}`}>{part.commodity} · {part.percent}%</span>) : <span className="mining-scan-mineral">Not read</span>}</div>
      <div className="scan-reader-result-actions">
        <button className="primary-button" type="button" disabled={!complete} onClick={() => saveParsed(result)}>Save scan</button>
        {!complete && <span>Some values could not be read. Adjust the read area to cover only the SCAN RESULTS panel.</span>}
      </div>
      <details><summary>Recognized text</summary><pre>{rawText}</pre></details>
    </div>}
    <div className="table-note"><span>Capture stays on this device. Only the selected area is read.</span><span>OCR language data downloads on first use.</span></div>
  </section>
}
