import assert from 'node:assert/strict'
import test from 'node:test'
import { isCompleteScan, parseCargoText, parseScanText, primaryMineral } from '../src/scanOcr.ts'

const minerals = ['Beryl', 'Titanium', 'Aslarite']
const cargoMinerals = ['Beryl (Raw)', 'Titanium (Ore)', 'Quantainium (Raw)']

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
