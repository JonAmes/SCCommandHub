import assert from 'node:assert/strict'
import test from 'node:test'
import { isCompleteScan, parseScanText, primaryMineral } from '../src/scanOcr.ts'

const minerals = ['Beryl', 'Titanium', 'Aslarite']

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
