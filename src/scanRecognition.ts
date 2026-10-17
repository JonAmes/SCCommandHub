import type { WorkerOptions } from 'tesseract.js'
import { agreeCaptureReadings, isCompleteScan, matchMineralName, parseCargoText, parseScanText, type BurstReading, type ScanRegion } from './scanOcr'

export type ScanWorker = Awaited<ReturnType<typeof import('tesseract.js')['createWorker']>>
export type ScanImageMode = 'contrast' | 'hud'
export type CaptureRegions = Record<'scan' | 'cargo', ScanRegion | null>
export type LocatedText = { text: string; bbox: { x0: number; y0: number; x1: number; y1: number } }

export function locateScanPanels(words: LocatedText[], width: number, height: number) {
  const rows: LocatedText[] = []
  for (const word of [...words].sort((left, right) => left.bbox.y0 - right.bbox.y0 || left.bbox.x0 - right.bbox.x0)) {
    const row = rows.find((entry) => Math.abs((entry.bbox.y0 + entry.bbox.y1) / 2 - (word.bbox.y0 + word.bbox.y1) / 2) < Math.min(entry.bbox.y1 - entry.bbox.y0, word.bbox.y1 - word.bbox.y0) * 0.6 && word.bbox.x0 >= entry.bbox.x1 && word.bbox.x0 - entry.bbox.x1 < (word.bbox.y1 - word.bbox.y0) * 3)
    if (row) {
      row.text += ` ${word.text}`
      row.bbox = { x0: Math.min(row.bbox.x0, word.bbox.x0), y0: Math.min(row.bbox.y0, word.bbox.y0), x1: Math.max(row.bbox.x1, word.bbox.x1), y1: Math.max(row.bbox.y1, word.bbox.y1) }
    } else rows.push({ text: word.text, bbox: { ...word.bbox } })
  }
  const scanHeaders = rows.filter((row) => /\b(?:SCAN\s*)?RES[UVI]L[TI]S\b/i.test(row.text))
  const cargoHeaders = rows.filter((row) => /^CARGO\b/i.test(row.text))
  const regions: CaptureRegions = { scan: null, cargo: null }
  const warnings: string[] = []
  for (const [target, headers] of [['scan', scanHeaders], ['cargo', cargoHeaders]] as const) {
    if (headers.length !== 1) {
      warnings.push(headers.length ? `Multiple ${target} panels found; select the area manually.` : `No ${target} panel found.`)
      continue
    }
    const header = headers[0]
    const textHeight = Math.max(1, header.bbox.y1 - header.bbox.y0)
    const left = Math.max(0, header.bbox.x0 - textHeight * (target === 'scan' ? 12 : 1))
    let right = Math.min(width, header.bbox.x0 + Math.max((header.bbox.x1 - header.bbox.x0) * 3.2, textHeight * 40))
    let bottom = Math.min(height, header.bbox.y0 + textHeight * 42)
    for (const other of [...scanHeaders, ...cargoHeaders]) {
      if (other === header) continue
      if (other.bbox.x0 > header.bbox.x1 && Math.abs(other.bbox.y0 - header.bbox.y0) < textHeight * 4) right = Math.min(right, other.bbox.x0 - textHeight)
      if (other.bbox.y0 > header.bbox.y1 && Math.abs(other.bbox.x0 - header.bbox.x0) < textHeight * 16) bottom = Math.min(bottom, other.bbox.y0 - textHeight)
    }
    const content = rows.filter((row) => row.bbox.x0 >= left && row.bbox.x1 <= right && row.bbox.y0 >= header.bbox.y0 && row.bbox.y1 <= bottom)
    const labels = content.filter((row) => /\b(?:MASS|RESIST[A-Z]*|INSTAB[A-Z]*)\b/i.test(row.text))
    if (target === 'scan' && (labels.length < 2 || !content.some((row) => /%|COMPOSITION/i.test(row.text)))) {
      warnings.push('Scan heading found without enough measurements; select the area manually.')
      continue
    }
    if (target === 'cargo' && (!content.some((row) => /\d+[.,]\d+/.test(row.text)) || !content.some((row) => /S[CG][UVY]|\d+[.,]\d+\s*\//i.test(row.text)))) {
      warnings.push('Cargo heading is clipped or unreadable; select the area manually.')
      continue
    }
    let relevant = content.filter((row) => target === 'scan'
      ? /SCAN\s*RES|\bMASS\b|RESIST|INSTAB|COMPOSITION|%|\b(?:RAW|ORE|INERT)\b/i.test(row.text)
      : /CARGO|\d+[.,]\d+|\b(?:RAW|ORE|INERT)\b|S[CG][UV]/i.test(row.text))
    if (target === 'scan') {
      const labelLeft = Math.min(header.bbox.x0, ...labels.map((row) => row.bbox.x0))
      relevant = relevant.filter((row) => row.bbox.x0 >= labelLeft - textHeight)
      const composition = content.find((row) => /CO[MNP]+[A-Z]*SITION/i.test(row.text))
      if (composition) {
        let last = composition.bbox.y1
        for (const row of relevant.filter((entry) => entry.bbox.y0 > composition.bbox.y0).sort((first, second) => first.bbox.y0 - second.bbox.y0)) {
          if (row.bbox.y0 - last > textHeight * 4) break
          last = Math.max(last, row.bbox.y1)
        }
        relevant = relevant.filter((row) => row.bbox.y0 <= last)
      }
    }
    const pad = Math.max(4, textHeight * 0.8)
    const x0 = Math.max(0, Math.min(...relevant.map((row) => row.bbox.x0)) - pad)
    const y0 = Math.max(0, header.bbox.y0 - pad)
    const x1 = Math.min(width, Math.max(...relevant.map((row) => row.bbox.x1)) + pad)
    const y1 = Math.min(height, Math.max(...relevant.map((row) => row.bbox.y1)) + pad * 2)
    regions[target] = { x: x0 / width, y: y0 / height, width: (x1 - x0) / width, height: (y1 - y0) / height }
  }
  return { regions, warnings }
}

export async function discoverScanPanels(worker: ScanWorker, frame: HTMLCanvasElement) {
  const { PSM } = await import('tesseract.js')
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT, tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,:%()/- ' })
  const scale = Math.min(1, 3840 / frame.width, 2160 / frame.height)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(frame.width * scale)
  canvas.height = Math.round(frame.height * scale)
  canvas.getContext('2d')!.drawImage(frame, 0, 0, canvas.width, canvas.height)
  const texts: string[] = []
  const regions: CaptureRegions = { scan: null, cargo: null }
  for (const mode of ['contrast', 'hud'] as const) {
    const { data } = await worker.recognize(prepareScanImage(canvas, mode), {}, { text: true, blocks: true })
    texts.push(`${mode}\n${data.text}`)
    const words = data.blocks?.flatMap((block) => block.paragraphs.flatMap((paragraph) => paragraph.lines.flatMap((line) => line.words))) ?? []
    const located = locateScanPanels(words, canvas.width, canvas.height)
    regions.scan ??= located.regions.scan
    regions.cargo ??= located.regions.cargo
    if (regions.scan && regions.cargo) break
  }
  const warnings: string[] = []
  if (!regions.scan) warnings.push('No unambiguous scan panel found; select its area manually.')
  if (!regions.cargo) warnings.push('No complete cargo panel found; select its area manually if visible.')
  return { regions, warnings, text: texts.join('\n') }
}

export function waitForCaptureFrame(video: HTMLVideoElement, signal: AbortSignal, after = -1) {
  return new Promise<number>((resolve, reject) => {
    let callbackId = 0
    let timer: ReturnType<typeof setTimeout>
    let fallback: ReturnType<typeof setTimeout>
    const cleanup = () => {
      clearTimeout(timer)
      clearTimeout(fallback)
      if (callbackId) video.cancelVideoFrameCallback?.(callbackId)
      signal.removeEventListener('abort', aborted)
    }
    const fail = (error: Error) => { cleanup(); reject(error) }
    const aborted = () => fail(new DOMException('Capture cancelled', 'AbortError'))
    const check = (time: number) => {
      if (signal.aborted) { aborted(); return }
      if (video.readyState >= 2 && video.videoWidth > 0 && time > after + (after < 0 ? 0 : 0.2)) {
        cleanup()
        resolve(time)
      } else schedule()
    }
    const schedule = () => {
      if (video.requestVideoFrameCallback) callbackId = video.requestVideoFrameCallback((_now, metadata) => check(metadata.mediaTime))
      else fallback = setTimeout(() => check(video.currentTime), 50)
    }
    if (signal.aborted) { aborted(); return }
    signal.addEventListener('abort', aborted, { once: true })
    timer = setTimeout(() => fail(new Error('No fresh game frames arrived. Restore the game window or select an area manually.')), 5000)
    schedule()
  })
}

export async function captureScreenBurst(worker: ScanWorker, video: HTMLVideoElement, minerals: string[], options: {
  signal: AbortSignal
  onProgress: (message: string) => void
  onRegions: (regions: CaptureRegions) => void
}) {
  const { signal, onProgress, onRegions } = options
  const check = () => signal.throwIfAborted()
  onProgress('Capturing the selected source...')
  let frameTime = await waitForCaptureFrame(video, signal)
  const width = video.videoWidth
  const height = video.videoHeight
  const fullFrame = document.createElement('canvas')
  fullFrame.width = width
  fullFrame.height = height
  const context = fullFrame.getContext('2d')
  if (!context) throw new Error('Screen capture canvas is unavailable.')
  context.drawImage(video, 0, 0)
  onProgress('Locating scan and cargo panels...')
  const discovery = await discoverScanPanels(worker, fullFrame)
  check()
  onRegions(discovery.regions)
  if (!discovery.regions.scan && !discovery.regions.cargo) return { ...agreeCaptureReadings([]), warnings: discovery.warnings, text: discovery.text, frameTimes: [frameTime] }
  const frameTimes = [frameTime]
  const snapshots: { scan: HTMLCanvasElement | null; cargo: HTMLCanvasElement | null }[] = []
  for (let index = 0; index < 3; index += 1) {
    onProgress(`Capturing cropped snapshot ${index + 1}/3...`)
    frameTime = await waitForCaptureFrame(video, signal, frameTime)
    check()
    if (video.videoWidth !== width || video.videoHeight !== height) throw new Error('The capture size changed. Start capture again to locate the panels.')
    snapshots.push({
      scan: discovery.regions.scan ? captureScanRegion(video, width, height, discovery.regions.scan) : null,
      cargo: discovery.regions.cargo ? captureScanRegion(video, width, height, discovery.regions.cargo) : null,
    })
    frameTimes.push(frameTime)
  }
  const readings: BurstReading[] = []
  const texts = [`--- DISCOVERY ---\n${discovery.text}`]
  for (const [index, snapshot] of snapshots.entries()) {
    check()
    onProgress(`Reading cropped snapshot ${index + 1}/3...`)
    const reading: BurstReading = { warnings: [] }
    for (const target of ['scan', 'cargo'] as const) {
      const crop = snapshot[target]
      if (!crop) continue
      const result = await recognizeScanRegion(worker, crop, target, minerals)
      check()
      reading.parsed ??= result.parsed
      reading.cargo ??= result.cargo
      reading.warnings.push(...result.warnings)
      texts.push(`--- SNAPSHOT ${index + 1}, ${target.toUpperCase()} ---\n${result.text}`)
    }
    readings.push(reading)
  }
  const agreed = agreeCaptureReadings(readings)
  return { ...agreed, warnings: [...new Set([...discovery.warnings, ...agreed.warnings])], text: texts.join('\n'), frameTimes }
}

export async function createScanWorker(options?: Partial<WorkerOptions>) {
  const { createWorker, PSM } = await import('tesseract.js')
  const worker = await createWorker('eng', 1, { errorHandler: () => undefined, ...options })
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK, preserve_interword_spaces: '1', tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,:%()/- ' })
  return worker
}

export function captureScanRegion(source: CanvasImageSource, width: number, height: number, region: ScanRegion) {
  if (!width || !height || ![region.x, region.y, region.width, region.height].every(Number.isFinite) || region.width <= 0 || region.height <= 0) return null
  const sx = Math.max(0, Math.min(width - 1, Math.round(region.x * width)))
  const sy = Math.max(0, Math.min(height - 1, Math.round(region.y * height)))
  const sw = Math.min(width - sx, Math.max(1, Math.round(region.width * width)))
  const sh = Math.min(height - sy, Math.max(1, Math.round(region.height * height)))
  const scale = Math.min(4, Math.max(1, 1200 / sw))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(sw * scale)
  canvas.height = Math.round(sh * scale)
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return null
  context.imageSmoothingQuality = 'high'
  context.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
  return canvas
}

export function prepareScanImage(source: HTMLCanvasElement, mode: ScanImageMode = 'contrast') {
  const canvas = document.createElement('canvas')
  canvas.width = source.width
  canvas.height = source.height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Canvas is unavailable')
  context.drawImage(source, 0, 0)
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
  const data = pixels.data
  let darkest = 255
  let brightest = 0
  for (let index = 0; index < data.length; index += 4) {
    const maximum = Math.max(data[index], data[index + 1], data[index + 2])
    const brightness = mode === 'hud' ? (maximum > 200 || data[index] > 100 && data[index] - Math.max(data[index + 1], data[index + 2]) > 40 ? 255 : 0) : maximum
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

export async function recognizeScanRegion(worker: ScanWorker, source: HTMLCanvasElement, target: 'scan' | 'cargo', minerals: string[]) {
  const { PSM } = await import('tesseract.js')
  const started = performance.now()
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK, tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,:%()/- ' })
  const prepared = prepareScanImage(source)
  const { data } = await worker.recognize(prepared, {}, { text: true, blocks: true })
  const parsed = target === 'scan' ? parseScanText(data.text, minerals) : undefined
  const cargo = target === 'cargo' ? parseCargoText(data.text, minerals) : undefined
  const warnings: string[] = []
  const details = [`Contrast (${data.confidence}% confidence)\n${data.text}`]
  let passes = 1
  if (data.confidence < 80) warnings.push('Low OCR confidence; compare every value with the source.')
  if (parsed) {
    const masked = prepareScanImage(source, 'hud')
    const lines = data.blocks?.flatMap((block) => block.paragraphs.flatMap((paragraph) => paragraph.lines)) ?? []
    const fields = [
      { key: 'massKg', label: 'Mass', pattern: /^MASS\b/ },
      { key: 'resistancePercent', label: 'Resistance', pattern: /^RESIST[A-Z]*[.:;]?$/ },
      { key: 'instabilityPercent', label: 'Instability', pattern: /^INSTAB[A-Z]*[.:;]?$/ },
    ] as const
    for (const field of fields) {
      const line = lines.find((entry) => entry.words.some((word) => field.pattern.test(word.text.toUpperCase())))
      const label = line?.words.find((word) => field.pattern.test(word.text.toUpperCase()))
      if (!line || !label) continue
      const left = label.bbox.x1 + 2
      const top = Math.max(0, line.bbox.y0 - 4)
      const width = Math.min(prepared.width, line.bbox.x1 + 4) - left
      const height = Math.min(prepared.height, line.bbox.y1 + 4) - top
      if (width < 5 || height < 5) continue
      const candidates: { value: number; confidence: number }[] = []
      for (const [mode, image] of [['contrast', prepared], ['hud', masked]] as const) {
        const canvas = document.createElement('canvas')
        canvas.width = width + 24
        canvas.height = height + 24
        const context = canvas.getContext('2d')
        if (!context) continue
        context.fillStyle = 'white'
        context.fillRect(0, 0, canvas.width, canvas.height)
        context.drawImage(image, left, top, width, height, 12, 12, width, height)
        await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE, tessedit_char_whitelist: '0123456789.,%' })
        const { data: numeric } = await worker.recognize(canvas)
        passes += 1
        details.push(`${field.label}, ${mode} (${numeric.confidence}% confidence)\n${numeric.text}`)
        const token = numeric.text.trim()
        if (!/^\d+(?:[.,]\d+)?%?$/.test(token) || numeric.confidence < 60) continue
        const value = Number(token.replace(',', '.').replace('%', ''))
        if (field.key === 'massKg' && (!Number.isInteger(value) || value <= 0)) continue
        if (field.key === 'resistancePercent' && value > 100) continue
        candidates.push({ value, confidence: numeric.confidence })
      }
      const values = new Set(candidates.map((candidate) => candidate.value))
      let candidate = candidates[0]
      if (values.size > 1) {
        warnings.push(`${field.label} differs between image filters; verify it manually.`)
        const ranked = [...candidates].sort((left, right) => right.confidence - left.confidence)
        if (ranked[0].confidence < 90 || ranked[0].confidence - ranked[1].confidence < 10) continue
        candidate = ranked[0]
      }
      if (!candidate || candidates.length < 2 && candidate.confidence < 85) continue
      if (parsed[field.key] !== undefined && parsed[field.key] !== candidate.value) {
        const original = parsed[field.key]!
        if (!Number.isInteger(original) && [10, 100, 1000].some((factor) => Math.abs(candidate.value - original * factor) < 0.000001)) {
          warnings.push(`${field.label} retry may have lost a decimal point; the panel value is retained.`)
          continue
        }
        warnings.push(`${field.label} differs from the panel read; the numeric retry is shown.`)
      }
      parsed[field.key] = candidate.value
    }
    if (!isCompleteScan(parsed)) warnings.push('Scan is incomplete or has an invalid composition total.')
    const total = parsed.composition.reduce((sum, part) => sum + part.percent, 0)
    if (total > 0 && total < 99.5) warnings.push(`Composition totals ${total.toFixed(2)}%; some rows or digits may be missing.`)
    if (parsed.composition.some((part) => !matchMineralName(part.commodity, [...minerals, 'Inert Materials']))) {
      warnings.push('Some mineral names could not be matched; verify them manually.')
    }
  }
  if (cargo) {
    if (cargo.unmatched.length) warnings.push(`Unmatched cargo: ${cargo.unmatched.join(', ')}.`)
    if (!cargo.items.length) warnings.push('No ore amounts recognized; the hold may be empty or unreadable.')
  }
  return { parsed, cargo, warnings, confidence: data.confidence, text: details.join('\n'), passes, elapsedMs: Math.round(performance.now() - started) }
}