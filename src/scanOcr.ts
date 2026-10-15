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
  const cleaned = value.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1').replace(/S/g, '5').replace(/,/g, '.').replace(/\s+/g, '')
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : undefined
}

function mineralKey(value: string) {
  return value.toLocaleLowerCase().replace(/[^a-z]/g, '')
}

function titleCase(value: string) {
  return value.toLocaleLowerCase().replace(/(^|[\s(])([a-z])/g, (_match, prefix: string, letter: string) => `${prefix}${letter.toLocaleUpperCase()}`)
}

function editDistance(left: string, right: string) {
  let previous = Array.from({ length: right.length + 1 }, (_value, index) => index)
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row]
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(previous[column] + 1, current[column - 1] + 1, previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1))
    }
    previous = current
  }
  return previous[right.length]
}

export function matchMineralName(ocrName: string, knownMinerals: string[]) {
  const key = mineralKey(ocrName)
  const stripped = key.replace(/(raw|ore)$/, '')
  const exact = knownMinerals.find((mineral) => mineralKey(mineral) === key)
    ?? knownMinerals.find((mineral) => mineralKey(mineral).replace(/(raw|ore)$/, '') === stripped)
  if (exact || stripped.length < 4) return exact
  // Allow roughly one misread letter per five so "ASRICIUM" still finds Agricium.
  const ranked = knownMinerals
    .map((mineral) => ({ mineral, distance: editDistance(stripped, mineralKey(mineral).replace(/(raw|ore)$/, '')) }))
    .sort((left, right) => left.distance - right.distance)
  const [best, runnerUp] = ranked
  if (!best || best.distance > Math.max(1, Math.floor(stripped.length / 5))) return undefined
  return runnerUp && runnerUp.distance === best.distance ? undefined : best.mineral
}

export function resolveMineralName(ocrName: string, knownMinerals: string[]) {
  const name = ocrName.replace(/\s+/g, ' ').trim()
  return matchMineralName(name, knownMinerals) ?? titleCase(name)
}

export type CargoReading = { items: { commodity: string; scu: number }[]; unmatched: string[] }

export function parseCargoText(text: string, knownMinerals: string[]): CargoReading {
  const totals = new Map<string, number>()
  const unmatched = new Set<string>()
  for (const line of text.toUpperCase().split(/\r?\n/)) {
    // The hold always shows two decimals, which separates the amount from the quality column.
    const match = line.match(/^[^A-Z]*([A-Z][A-Z ()]*?[A-Z)])\s+(?:\d{1,4}\s+)?(\d+[.,]\d{1,2})\s*(?:S\s*C|$)/)
    if (!match || /^CARGO\b/.test(match[1])) continue
    const scu = readNumberToken(match[2])
    if (scu === undefined || scu <= 0) continue
    const commodity = matchMineralName(match[1], knownMinerals)
    if (!commodity) {
      unmatched.add(titleCase(match[1].replace(/\s+/g, ' ').trim()))
      continue
    }
    totals.set(commodity, Math.round(((totals.get(commodity) ?? 0) + scu) * 100) / 100)
  }
  return { items: [...totals].map(([commodity, scu]) => ({ commodity, scu })), unmatched: [...unmatched] }
}

export function parseScanText(text: string, knownMinerals: string[] = []): ParsedRockScan {
  const result: ParsedRockScan = { composition: [] }
  const rawPercents: string[] = []
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
    const part = line.match(/^[^\dS]*([\dS]\d{0,2}(?:[.,]\d{1,2})?)\s*%\s*([A-Z][A-Z ()-]*[A-Z)])/)
    if (part) {
      const percent = readNumberToken(part[1])
      if (percent !== undefined && percent > 0 && percent <= 100) {
        result.composition.push({ commodity: resolveMineralName(part[2], knownMinerals), percent })
        rawPercents.push(part[1].replace(/S/g, '5').replace(/,/g, '.'))
      }
    }
  }

  result.composition = resolveZeroEightMisreads(result.composition, rawPercents)
  return result
}

function zeroEightVariants(raw: string) {
  const positions = [...raw].flatMap((character, index) => character === '8' ? [index] : [])
  return Array.from({ length: 2 ** Math.min(positions.length, 4) }, (_value, mask) => {
    const characters = [...raw]
    positions.slice(0, 4).forEach((position, bit) => { if (mask & (1 << bit)) characters[position] = '0' })
    return { percent: Number(characters.join('')), changes: mask.toString(2).replace(/0/g, '').length }
  }).filter((variant) => Number.isFinite(variant.percent) && variant.percent > 0)
}

// The HUD font draws 0 with an inner dot that OCR often reads as 8; a composition must total about 100%.
function resolveZeroEightMisreads(composition: RockComposition[], rawPercents: string[]) {
  const total = composition.reduce((sum, part) => sum + part.percent, 0)
  if (total <= 100.05 || composition.length !== rawPercents.length || composition.length > 8) return composition
  let combos: { percents: number[]; changes: number }[] = [{ percents: [], changes: 0 }]
  for (const raw of rawPercents) {
    combos = combos.flatMap((combo) => zeroEightVariants(raw).map((variant) => ({ percents: [...combo.percents, variant.percent], changes: combo.changes + variant.changes })))
    if (combos.length > 4096) return composition
  }
  const valid = combos.filter((combo) => {
    const sum = combo.percents.reduce((value, percent) => value + percent, 0)
    return sum >= 99.5 && sum <= 100.05
  })
  const fewest = Math.min(...valid.map((combo) => combo.changes))
  const best = valid.filter((combo) => combo.changes === fewest)
  if (best.length !== 1) return composition
  return composition.map((part, index) => ({ ...part, percent: best[0].percents[index] }))
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
