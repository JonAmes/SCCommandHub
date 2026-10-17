import assert from 'node:assert/strict'
import test from 'node:test'
import { agreeCaptureReadings, isCompleteScan, parseCargoText, parseScanText, primaryMineral } from '../src/scanOcr.ts'

const minerals = ['Beryl', 'Titanium', 'Aslarite']
const cargoMinerals = ['Beryl (Raw)', 'Titanium (Ore)', 'Quantainium (Raw)']

test('three-frame agreement preserves zeros, duplicate minerals and uncertainty', () => {
  const scan = { massKg: 458, resistancePercent: 0, instabilityPercent: 0, composition: [{ commodity: 'Beryl', percent: 40 }, { commodity: 'Beryl', percent: 60 }] }
  const readings = [{ parsed: scan, warnings: ['Low OCR confidence'] }, { parsed: { ...scan, composition: [...scan.composition].reverse() }, warnings: [] }, { parsed: { ...scan, massKg: 999 }, warnings: [] }]
  const result = agreeCaptureReadings(readings)
  assert.deepEqual(result.parsed, scan)
  assert.ok(result.warnings.includes('Low OCR confidence'))
  assert.ok(result.warnings.some((warning) => warning.includes('One scan differed')))
  assert.equal(agreeCaptureReadings(readings.slice(0, 2)).parsed, undefined)
})

test('never combines different rocks or averages disagreement', () => {
  const scan = { massKg: 458, resistancePercent: 20, instabilityPercent: 1, composition: [{ commodity: 'Beryl', percent: 100 }] }
  const readings = [0, 1, 2].map((offset) => ({ parsed: { ...scan, massKg: 458 + offset }, warnings: [] }))
  assert.equal(agreeCaptureReadings(readings).parsed, undefined)
  const stable = [10, 20, 30].map((resistancePercent) => ({ parsed: { ...scan, resistancePercent }, warnings: [] }))
  assert.equal(agreeCaptureReadings(stable).parsed.resistancePercent, undefined)
  assert.ok(agreeCaptureReadings(stable).warnings.some((warning) => warning.includes('Resistance')))
})

test('cargo agreement compares canonical totals including unknown materials', () => {
  const cargo = { items: [{ commodity: 'Beryl', scu: 2 }, { commodity: 'Titanium', scu: 1 }], unmatched: ['Inert Materials'] }
  const readings = [{ cargo, warnings: [] }, { cargo: { ...cargo, items: [...cargo.items].reverse() }, warnings: [] }, { cargo: { items: [], unmatched: [] }, warnings: [] }]
  assert.deepEqual(agreeCaptureReadings(readings).cargo, cargo)
  assert.deepEqual(agreeCaptureReadings(Array.from({ length: 3 }, () => ({ cargo: { items: [], unmatched: [] }, warnings: [] }))).cargo.items, [])
})

test('never reads letters inside a field label as a missing numeric value', () => {
  for (const text of ['INSTABILITY: :65', 'INSTABILITY: Y24)', 'RESISTANCE: unreadable', 'INSTABILITY', 'INSTABN IY: 6).980']) {
    const parsed = parseScanText(text)
    assert.equal(parsed.instabilityPercent, undefined, text)
    assert.equal(parsed.resistancePercent, undefined, text)
  }
  assert.equal(parseScanText('INSTABILITY: .78').instabilityPercent, 0.78)
  assert.equal(parseScanText('RESISTANCE: 0.30').resistancePercent, 0.3)
})

test('matches older HUD raw prefixes and ore suffixes to current names', () => {
  const parsed = parseScanText('21.69% RAW BERYL\n1.00% RAW QUANTAINIUM\n35.35% INERT MATERIALS', cargoMinerals)
  assert.deepEqual(parsed.composition, [
    { commodity: 'Beryl (Raw)', percent: 21.69 },
    { commodity: 'Quantainium (Raw)', percent: 1 },
    { commodity: 'Inert Materials', percent: 35.35 },
  ])
  assert.deepEqual(parseCargoText('RAW QUANTAINIUM 0.26 SCU\nTITANIUM ORE 1.02 SCU', cargoMinerals).items, [
    { commodity: 'Quantainium (Raw)', scu: 0.26 }, { commodity: 'Titanium (Ore)', scu: 1.02 },
  ])
})

test('fixes misread mineral letters, S/5 and dotted-zero misreads from a real capture', () => {
  const parsed = parseScanText(`SCAN RESULTS
MASS:       23180
RESISTANCE: 21%
INSTABILITY: 136.91
33.11% ASRICIUM (ORE)
S6.05% CORUMDUM (RAW)
18.82% INERT MATERIALS`, ['Agricium (Ore)', 'Corundum (Raw)', 'Aluminum (Ore)'])
  assert.deepEqual(parsed.composition, [
    { commodity: 'Agricium (Ore)', percent: 33.11 },
    { commodity: 'Corundum (Raw)', percent: 56.05 },
    { commodity: 'Inert Materials', percent: 10.82 },
  ])
  assert.equal(isCompleteScan(parsed), true)

  const ambiguous = parseScanText('MASS: 23180\nRESISTANCE: 21%\nINSTABILITY: 136.91\n33.11% AGRICIUM (ORE)\n56.85% CORUNDUM (RAW)\n10.82% INERT MATERIALS')
  assert.equal(isCompleteScan(ambiguous), false)
})

test('reads the CARGO panel, totals each UEX ore, and reports unknown materials', () => {
  const cargo = parseCargoText(`CARGO 85.61 / 96.00 SCU
BERYL (RAW) 324 31.60 SCU
ASLARITE (RAW) 207 10.54 SCU
TITANIUM (ORE) 622 5.32 SCU
BERYL (RAW) 547 28.19 SCU
TITANIUM (ORE) 704 2.28 SCU
INERT MATERIALS 1.68 SCU`, cargoMinerals)
  assert.deepEqual(cargo.items, [{ commodity: 'Beryl (Raw)', scu: 59.79 }, { commodity: 'Titanium (Ore)', scu: 7.6 }])
  assert.deepEqual(cargo.unmatched, ['Aslarite (Raw)', 'Inert Materials'])
})

test('parses an in-game SCAN RESULTS panel', () => {
  const parsed = parseScanText(`SCAN RESULTS
BERYL (RAW)
MASS: 10744
RESISTANCE: 39%
INSTABILITY: 252.34
IMPOSSIBLE
COMPOSITION 34.07 SCU
10.86% BERYL (RAW) 547
58.10% BERYL (RAW) 324
31.03% INERT MATERIALS 0`, minerals)

  assert.equal(parsed.massKg, 10744)
  assert.equal(parsed.resistancePercent, 39)
  assert.equal(parsed.instabilityPercent, 252.34)
  assert.deepEqual(parsed.composition, [
    { commodity: 'Beryl', percent: 10.86 },
    { commodity: 'Beryl', percent: 58.1 },
    { commodity: 'Inert Materials', percent: 31.03 },
  ])
  assert.equal(isCompleteScan(parsed), true)
  assert.equal(primaryMineral(parsed), 'Beryl')
})

test('tolerates common OCR noise and reports incomplete reads', () => {
  const parsed = parseScanText('MASS; 1O,744\nRESISTANCE 39 %\n» 58,10 % TITANIUM (ORE) 2O4', minerals)
  assert.equal(parsed.massKg, 10744)
  assert.equal(parsed.resistancePercent, 39)
  assert.deepEqual(parsed.composition, [{ commodity: 'Titanium', percent: 58.1 }])
  assert.equal(isCompleteScan(parsed), false)
})
