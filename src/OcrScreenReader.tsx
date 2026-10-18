import { useEffect, useRef, useState } from 'react'
import { ImagePlus, Monitor, Square } from 'lucide-react'
import { createScanWorker, type ScanWorker } from './scanRecognition'
import { captureDelay, captureOcrBurst, captureOcrImage, type OcrCaptureResult } from './ocrCapture'
import { readingSignature, type OcrReading, type OcrTarget } from './ocrReadings'

export function OcrScreenReader({ target, onVerified, onUnavailable }: { target: OcrTarget; onVerified: (readings: OcrReading[]) => void; onUnavailable?: () => void }) {
  const [busy, setBusy] = useState(false)
  const [live, setLive] = useState(false)
  const [status, setStatus] = useState('Idle')
  const [source, setSource] = useState('browser')
  const [sources, setSources] = useState<{ id: string; name: string }[]>([])
  const [result, setResult] = useState<OcrCaptureResult | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const controllerRef = useRef<AbortController | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const workerRef = useRef<Promise<ScanWorker> | null>(null)
  const busyRef = useRef(false)
  const callbackRef = useRef(onVerified)
  const unavailableRef = useRef(onUnavailable)
  const signaturesRef = useRef(new Map<string, string>())
  useEffect(() => { callbackRef.current = onVerified; unavailableRef.current = onUnavailable }, [onVerified, onUnavailable])
  useEffect(() => {
    let disposed = false
    void window.starCitizenBridge?.listScreenSources?.().then((available) => {
      if (disposed) return
      setSources(available)
      const primary = available.filter((entry) => entry.kind === 'screen' && entry.isPrimary)
      setSource(primary.length === 1 ? primary[0].id : '')
    }).catch(() => undefined)
    return () => {
      disposed = true
      controllerRef.current?.abort()
      streamRef.current?.getTracks().forEach((track) => track.stop())
      void workerRef.current?.then((worker) => worker.terminate()).catch(() => undefined)
    }
  }, [])

  function stop() {
    controllerRef.current?.abort()
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    setLive(false)
    setStatus('Stopped')
    unavailableRef.current?.()
    signaturesRef.current.clear()
  }

  function getWorker() {
    workerRef.current ??= createScanWorker()
    void workerRef.current.catch(() => { workerRef.current = null })
    return workerRef.current
  }

  async function start() {
    if (busyRef.current) return
    const controller = new AbortController()
    controllerRef.current = controller
    const { signal } = controller
    busyRef.current = true
    setBusy(true)
    setStatus('Opening capture source...')
    signaturesRef.current.clear()
    unavailableRef.current?.()
    try {
      if (window.starCitizenBridge?.listScreenSources && (!source || source === 'browser')) throw new Error('Select an available capture source first.')
      if (source !== 'browser' && !await window.starCitizenBridge?.selectScreenSource?.(source)) throw new Error('The selected capture source is unavailable.')
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false })
      if (signal.aborted) { stream.getTracks().forEach((track) => track.stop()); return }
      streamRef.current = stream
      stream.getVideoTracks()[0]?.addEventListener('ended', () => { if (controllerRef.current === controller) stop() }, { once: true })
      const video = videoRef.current!
      video.srcObject = stream
      await video.play()
      signal.throwIfAborted()
      setLive(true)
      const worker = await getWorker()
      let failures = 0
      while (!signal.aborted) {
        const captured = await captureOcrBurst(worker, video, target, signal, (message) => { if (!signal.aborted) setStatus(message) })
        signal.throwIfAborted()
        setResult((previous) => captured.verified ? captured : previous?.verified ? { ...previous, areas: captured.areas } : captured)
        if (captured.verified) {
          failures = 0
          const fresh: OcrReading[] = []
          for (const reading of captured.readings) {
            const signature = readingSignature(reading)
            const key = `${reading.target}|${reading.identity}|${Object.keys(reading.values).sort().join('|')}`
            if (signaturesRef.current.get(key) !== signature) {
              fresh.push(reading)
              signaturesRef.current.set(key, signature)
              if (signaturesRef.current.size > 100) signaturesRef.current.delete(signaturesRef.current.keys().next().value!)
            }
          }
          if (fresh.length) callbackRef.current(fresh)
          setStatus('Verified: three matching captures')
        } else {
          failures += 1
          unavailableRef.current?.()
          signaturesRef.current.clear()
          setStatus(`No stable match. Rediscovering (attempt ${failures})...`)
        }
        await captureDelay(signal, Math.min(5000, 1000 * Math.max(1, failures)))
      }
    } catch (error) {
      if (!signal.aborted) { setStatus(error instanceof Error ? error.message : 'Capture failed'); unavailableRef.current?.() }
    } finally {
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      busyRef.current = false
      if (!signal.aborted) { setLive(false); setBusy(false) }
      else if (controllerRef.current === controller) setBusy(false)
    }
  }

  async function loadImage(file?: File) {
    if (!file || busyRef.current) return
    const controller = new AbortController()
    controllerRef.current = controller
    busyRef.current = true
    setBusy(true)
    setResult(null)
    setStatus('Discovering screenshot data areas...')
    const url = URL.createObjectURL(file)
    try {
      const image = new Image()
      image.src = url
      await image.decode()
      controller.signal.throwIfAborted()
      const frame = document.createElement('canvas')
      frame.width = image.naturalWidth
      frame.height = image.naturalHeight
      frame.getContext('2d')!.drawImage(image, 0, 0)
      const captured = await captureOcrImage(await getWorker(), frame, target, controller.signal)
      controller.signal.throwIfAborted()
      setResult(captured)
      setStatus(captured.readings.length ? 'Screenshot preview: not live-verified' : 'No supported data areas found in this screenshot')
    } catch (error) {
      if (!controller.signal.aborted) setStatus(error instanceof Error ? error.message : 'Image recognition failed')
    } finally {
      URL.revokeObjectURL(url)
      busyRef.current = false
      if (controllerRef.current === controller) setBusy(false)
    }
  }

  return <section className="data-section operations-reader">
    <div className="section-toolbar"><h2>Screen capture</h2><span className="table-label">{live ? 'LIVE' : result?.verified ? 'VERIFIED' : 'OCR'}</span></div>
    <div className="operations-toolbar">
      {sources.length > 0 && <label>Capture source<select value={source} disabled={busy} onChange={(event) => setSource(event.target.value)}><option value="" disabled>Choose capture source</option>{sources.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>}
      <button type="button" className="secondary-button" disabled={busy || !navigator.mediaDevices?.getDisplayMedia} onClick={() => { void start() }}><Monitor size={16} /> Capture screen</button>
      <button type="button" className="icon-button" disabled={!busy} onClick={stop} title="Stop capture" aria-label="Stop capture"><Square size={16} /></button>
      <label className={`secondary-button scan-reader-file ${busy ? 'disabled' : ''}`}><ImagePlus size={16} /> Load screenshot<input type="file" accept="image/*" disabled={busy} onChange={(event) => { void loadImage(event.target.files?.[0]); event.target.value = '' }} /></label>
      <span role="status" className="scan-reader-status">{status}</span>
    </div>
    <video className="operations-video" ref={videoRef} muted playsInline hidden={!live} />
    {result && <>
      <div className="operations-crops">{result.crops.map((crop, index) => <figure key={index}><img src={crop} alt={`Automatically discovered capture ${index + 1}`} /><figcaption>{result.verified ? `Capture ${index + 1}/3` : 'Unverified preview'}</figcaption></figure>)}</div>
      <div className="operations-readings">{result.readings.map((reading, index) => <div key={`${reading.identity}-${index}`}><strong>{reading.identity}</strong><span className="table-label">{result.verified ? 'VERIFIED' : 'PREVIEW'}</span><dl>{Object.entries(reading.values).map(([key, amount]) => <div key={key}><dt>{key}</dt><dd>{amount}</dd></div>)}{Object.entries(reading.live).map(([key, amount]) => <div key={key}><dt>{key} (unverified)</dt><dd>{amount}</dd></div>)}</dl></div>)}</div>
      <details><summary>Recognized text</summary><pre>{result.readings.map((reading) => reading.text).join('\n\n')}</pre></details>
    </>}
  </section>
}