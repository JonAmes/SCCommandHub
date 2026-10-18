import { captureScanRegion, prepareScanImage, waitForCaptureFrame, type ScanWorker } from './scanRecognition'
import { agreeOcrSamples, locateOcrAreas, parseOcrReading, type OcrArea, type OcrReading, type OcrSample, type OcrTarget } from './ocrReadings'

export type OcrCaptureResult = { readings: OcrReading[]; areas: OcrArea[]; crops: string[]; verified: boolean }

export async function discoverOcrAreas(worker: ScanWorker, frame: HTMLCanvasElement, target: OcrTarget) {
  const { PSM } = await import('tesseract.js')
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT, tessedit_char_whitelist: '' })
  for (const mode of ['contrast', 'hud'] as const) {
    const { data } = await worker.recognize(prepareScanImage(frame, mode), {}, { text: true, blocks: true })
    const words = data.blocks?.flatMap((block) => block.paragraphs.flatMap((paragraph) => paragraph.lines.flatMap((line) => line.words))) ?? []
    const areas = locateOcrAreas(words, frame.width, frame.height, target)
    if (areas.length) return areas
  }
  return []
}

async function readCrop(worker: ScanWorker, crop: HTMLCanvasElement, target: OcrTarget): Promise<OcrSample> {
  const { PSM } = await import('tesseract.js')
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK, tessedit_char_whitelist: '' })
  const { data } = await worker.recognize(prepareScanImage(crop))
  return { reading: parseOcrReading(target, data.text), confidence: data.confidence, warnings: [] }
}

export async function captureOcrImage(worker: ScanWorker, frame: HTMLCanvasElement, target: OcrTarget, signal: AbortSignal): Promise<OcrCaptureResult> {
  const areas = await discoverOcrAreas(worker, frame, target)
  signal.throwIfAborted()
  const readings: OcrReading[] = []
  const crops: string[] = []
  for (const area of areas) {
    const crop = captureScanRegion(frame, frame.width, frame.height, area)
    if (!crop) continue
    const sample = await readCrop(worker, crop, target)
    signal.throwIfAborted()
    if (sample.reading) readings.push(sample.reading)
    if (crops.length < 3) crops.push(crop.toDataURL())
  }
  return { areas, readings, crops, verified: false }
}

export async function captureOcrBurst(worker: ScanWorker, video: HTMLVideoElement, target: OcrTarget, signal: AbortSignal, progress: (message: string) => void): Promise<OcrCaptureResult> {
  progress('Discovering visible data areas...')
  let time = await waitForCaptureFrame(video, signal)
  const width = video.videoWidth
  const height = video.videoHeight
  const frame = document.createElement('canvas')
  frame.width = width
  frame.height = height
  frame.getContext('2d')!.drawImage(video, 0, 0)
  const areas = await discoverOcrAreas(worker, frame, target)
  signal.throwIfAborted()
  if (!areas.length || target === 'shipTerminal' && areas.length !== 1) return { areas, readings: [], crops: [], verified: false }
  const snapshots: HTMLCanvasElement[][] = []
  for (let index = 0; index < 3; index += 1) {
    progress(`Capturing discovered areas ${index + 1}/3...`)
    time = await waitForCaptureFrame(video, signal, time)
    signal.throwIfAborted()
    if (video.videoWidth !== width || video.videoHeight !== height) return { areas: [], readings: [], crops: [], verified: false }
    snapshots.push(areas.map((area) => captureScanRegion(video, width, height, area)).filter((crop): crop is HTMLCanvasElement => Boolean(crop)))
  }
  const readings: OcrReading[] = []
  const crops: string[] = []
  for (const [areaIndex, area] of areas.entries()) {
    const samples: OcrSample[] = []
    for (const [index, snapshot] of snapshots.entries()) {
      signal.throwIfAborted()
      progress(`Verifying area ${areaIndex + 1}, reading ${index + 1}/3...`)
      const crop = snapshot[areaIndex]
      if (!crop) continue
      const sample = await readCrop(worker, crop, target)
      signal.throwIfAborted()
      const found = await discoverOcrAreas(worker, crop, target)
      signal.throwIfAborted()
      if (!found.length || target === 'shipTerminal' && found.length !== 1) sample.warnings.push('Panel identity or anchors changed.')
      samples.push(sample)
      if (areaIndex === 0) crops.push(crop.toDataURL())
    }
    const reading = agreeOcrSamples(samples)
    if (reading && area.width > 0) readings.push(reading)
  }
  const identities = readings.map((reading) => reading.identity)
  if (new Set(identities).size !== identities.length && target !== 'salvage') return { areas, readings: [], crops, verified: false }
  if (target === 'salvage' && readings.length) {
    const values: Record<string, number> = {}
    for (const reading of readings) for (const [key, amount] of Object.entries(reading.values)) {
      if (values[key] !== undefined && values[key] !== amount) return { areas, readings: [], crops, verified: false }
      values[key] = amount
    }
    return { areas, readings: [{ ...readings[0], values, text: readings.map((reading) => reading.text).join('\n') }], crops, verified: true }
  }
  return { areas, readings, crops, verified: readings.length > 0 }
}

export function captureDelay(signal: AbortSignal, milliseconds: number) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new DOMException('Capture stopped', 'AbortError')) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, milliseconds)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}