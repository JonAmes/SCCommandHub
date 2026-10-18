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

function mineralStem(value: string) {
  return mineralKey(value).replace(/^raw/, '').replace(/(raw|ore)$/, '')
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
  const stripped = mineralStem(ocrName)
  const exact = knownMinerals.find((mineral) => mineralKey(mineral) === key)
    ?? knownMinerals.find((mineral) => mineralStem(mineral) === stripped)
  if (exact || stripped.length < 4) return exact
  // Allow roughly one misread letter per five so "ASRICIUM" still finds Agricium.
  const ranked = knownMinerals
    .map((mineral) => ({ mineral, distance: editDistance(stripped, mineralStem(mineral)) }))
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
    const resistance = line.match(/\bRESIST[A-Z]*\b\s*[:;.]?\s*([\dOI|]+(?:[.,]\d+)?|[.,]\d+)(?![A-Z\d.,])/)
    if (resistance && result.resistancePercent === undefined) {
      const value = readNumberToken(resistance[1])
      if (value !== undefined && value >= 0 && value <= 100) result.resistancePercent = value
      continue
    }
    const instability = line.match(/\bINSTAB[A-Z]*\b\s*[:;.]?\s*([\dOI|]+(?:[.,]\d+)?|[.,]\d+)(?![A-Z\d.,])/)
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

export type BurstReading = { parsed?: ParsedRockScan; cargo?: CargoReading; warnings: string[] }

export function agreeCaptureReadings(readings: BurstReading[]) {
  const warnings = [...new Set(readings.flatMap((reading) => reading.warnings))]
  let parsed: ParsedRockScan | undefined
  let cargo: CargoReading | undefined
  if (readings.length !== 3) return { parsed, cargo, warnings: [...warnings, 'Three fresh cropped readings are required.'] }
  const scans = readings.flatMap((reading) => reading.parsed ? [reading.parsed] : [])
  const compositionKey = (scan: ParsedRockScan) => scan.composition.map((part) => `${part.commodity}:${part.percent}`).sort().join('|')
  const stable = scans.find((scan) => scan.massKg !== undefined && Number.isFinite(scan.massKg) && scan.massKg > 0 && scan.composition.length > 0 && scans.filter((other) => other.massKg === scan.massKg && compositionKey(other) === compositionKey(scan)).length >= 2)
  if (stable) {
    const matching = scans.filter((scan) => scan.massKg === stable.massKg && compositionKey(scan) === compositionKey(stable))
    parsed = { composition: stable.composition.map((part) => ({ ...part })) }
    for (const key of ['massKg', 'resistancePercent', 'instabilityPercent'] as const) {
      const values = matching.map((scan) => scan[key]).filter((value): value is number => value !== undefined && Number.isFinite(value) && value >= 0 && (key !== 'resistancePercent' || value <= 100))
      const value = values.find((candidate) => values.filter((other) => other === candidate).length >= 2)
      if (value === undefined) warnings.push(`${key === 'massKg' ? 'Mass' : key === 'resistancePercent' ? 'Resistance' : 'Instability'} did not agree in two captures; enter it manually.`)
      else parsed[key] = value
    }
    if (matching.length !== 3) warnings.push('One scan differed from the other two; verify the selected reading.')
    if (!isCompleteScan(parsed)) warnings.push('The agreed scan is incomplete or invalid; review it manually.')
  } else if (scans.length) warnings.push('The rock or its composition did not stay consistent across captures; waiting for a stable panel.')
  const cargoReadings = readings.flatMap((reading) => reading.cargo ? [reading.cargo] : [])
  const cargoKey = (reading: CargoReading) => JSON.stringify([reading.items.map((item) => `${item.commodity}:${item.scu}`).sort(), [...reading.unmatched].sort()])
  cargo = cargoReadings.find((reading) => cargoReadings.filter((other) => cargoKey(other) === cargoKey(reading)).length >= 2)
  if (cargoReadings.length && !cargo) warnings.push('Cargo amounts did not agree in two captures; use Read now to review them.')
  if (cargo && cargoReadings.some((reading) => cargoKey(reading) !== cargoKey(cargo!))) warnings.push('One cargo capture differed; verify the agreed amounts.')
  return { parsed, cargo, warnings: [...new Set(warnings)] }
}
