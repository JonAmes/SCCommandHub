import type { RockComposition } from './miningOps'

export type ParsedRockScan = {
  massKg?: number
  resistancePercent?: number
  instabilityPercent?: number
  composition: RockComposition[]
}

export type ScanRegion = { x: number; y: number; width: number; height: number }

function readNumberToken(value: string) {
  // OCR commonly swaps these glyphs inside numeric fields.
  const cleaned = value.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1').replace(/,/g, '.').replace(/\s+/g, '')
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : undefined
}

function mineralKey(value: string) {
  return value.toLocaleLowerCase().replace(/[^a-z]/g, '')
}

function titleCase(value: string) {
  return value.toLocaleLowerCase().replace(/(^|[\s(])([a-z])/g, (_match, prefix: string, letter: string) => `${prefix}${letter.toLocaleUpperCase()}`)
}

export function resolveMineralName(ocrName: string, knownMinerals: string[]) {
  const name = ocrName.replace(/\s+/g, ' ').trim()
  const key = mineralKey(name)
  const stripped = key.replace(/(raw|ore)$/, '')
  const match = knownMinerals.find((mineral) => mineralKey(mineral) === key)
    ?? knownMinerals.find((mineral) => mineralKey(mineral).replace(/(raw|ore)$/, '') === stripped)
  return match ?? titleCase(name)
}

export function parseScanText(text: string, knownMinerals: string[] = []): ParsedRockScan {
  const result: ParsedRockScan = { composition: [] }
  const lines = text.toUpperCase().split(/\r?\n/).map((line) => line.trim()).filter(Boolean)

  for (const line of lines) {
    const mass = line.match(/MASS\s*[:;.]?\s*([\d.,OIl| ]+)/)
    if (mass && result.massKg === undefined) {
      const value = readNumberToken(mass[1].replace(/[.,](?=\d{3}\b)/g, ''))
      if (value && value > 0) result.massKg = value
      continue
    }
    const resistance = line.match(/RESIST\w*\s*[:;.]?\s*([\dOIl|]+(?:[.,]\d+)?)/)
    if (resistance && result.resistancePercent === undefined) {
      const value = readNumberToken(resistance[1])
      if (value !== undefined && value >= 0 && value <= 100) result.resistancePercent = value
      continue
    }
    const instability = line.match(/INSTAB\w*\s*[:;.]?\s*([\dOIl|]+(?:[.,]\d+)?)/)
    if (instability && result.instabilityPercent === undefined) {
      const value = readNumberToken(instability[1])
      if (value !== undefined && value >= 0) result.instabilityPercent = value
      continue
    }
    const part = line.match(/^[^\d]*(\d{1,3}(?:[.,]\d{1,2})?)\s*%\s*([A-Z][A-Z ()-]*[A-Z)])/)
    if (part) {
      const percent = readNumberToken(part[1])
      if (percent !== undefined && percent > 0 && percent <= 100) result.composition.push({ commodity: resolveMineralName(part[2], knownMinerals), percent })
    }
  }

  return result
}

export function isCompleteScan(scan: ParsedRockScan): scan is Required<ParsedRockScan> {
  const total = scan.composition.reduce((sum, part) => sum + part.percent, 0)
  return scan.massKg !== undefined && scan.resistancePercent !== undefined && scan.instabilityPercent !== undefined && scan.composition.length > 0 && total > 0 && total <= 100.05
}

export function scanSignature(scan: { massKg?: number; resistancePercent?: number; instabilityPercent?: number; composition: RockComposition[] }) {
  return [scan.massKg, scan.resistancePercent, scan.instabilityPercent, ...scan.composition.map((part) => `${part.commodity}:${part.percent}`)].join('|')
}

export function primaryMineral(scan: ParsedRockScan) {
  const minerals = scan.composition.filter((part) => !/inert/i.test(part.commodity))
  return [...(minerals.length ? minerals : scan.composition)].sort((left, right) => right.percent - left.percent)[0]?.commodity ?? 'Rock'
}
