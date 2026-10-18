import assert from 'node:assert/strict'
import test from 'node:test'
import { agreeOcrSamples, locateOcrAreas, matchTerminalShip, parseOcrReading, parseTerminalRows } from '../src/ocrReadings.ts'

test('terminal requires exact Store in its own row and a unique ship match', () => {
  assert.deepEqual(parseTerminalRows('Vulture STORE\nProspector CLAIM\nCutlass UNKNOWN\nSTOREHOUSE'), ['Vulture'])
  assert.deepEqual(parseTerminalRows('Vulture UNKNOWN STORE\nProspector CLAIM STORE'), [])
  assert.equal(parseOcrReading('shipTerminal', 'Vulture STORE\nReclaimer STORE'), null)
  assert.equal(matchTerminalShip('DRAKE VULTURE', [{ id: 'v', name: 'Vulture', manufacturer: 'Drake' }]), 'v')
  assert.equal(matchTerminalShip('Vulture', [{ id: 'a', name: 'Vulture' }, { id: 'b', name: 'Vulture' }]), null)
  assert.equal(matchTerminalShip('Vultur', [{ id: 'v', name: 'Vulture' }]), null)
})

test('three confident readings must agree; distance stays unverified', () => {
  const sample = (text, confidence = 95) => ({ reading: parseOcrReading('shipTarget', text), confidence, warnings: [] })
  const first = sample('TARGET: VULTURE\nDISTANCE: 2 KM\nCARGO: 4 SCU')
  const last = sample('TARGET: VULTURE\nDISTANCE: 1900 M\nCARGO: 4 SCU')
  assert.equal(agreeOcrSamples([first, first, last]).live['DISTANCE (M)'], 1900)
  assert.equal(agreeOcrSamples([first, first]), null)
  assert.equal(agreeOcrSamples([first, first, sample('TARGET: VULTURE\nCARGO: 5 SCU')]), null)
  assert.equal(agreeOcrSamples([first, first, { ...last, confidence: 79 }]), null)
  assert.equal(agreeOcrSamples([first, first, { ...last, warnings: ['clipped'] }]), null)
})

test('salvage keeps buffer and hold separate, including explicit zero', () => {
  const reading = parseOcrReading('salvage', 'RMC BUFFER 0.5 / 13 SCU\nRMC HOLD 4 SCU\nCONSTRUCTION MATERIALS BUFFER 0 / 10 SCU')
  assert.equal(reading.values['buffer:Recycled Material Composite'], 0.5)
  assert.equal(reading.values['hold:Recycled Material Composite'], 4)
  assert.equal(reading.values['buffer:Construction Materials'], 0)
  assert.equal(parseOcrReading('salvage', 'RMC BUFFER 14 / 13 SCU'), null)
  assert.equal(parseOcrReading('salvage', 'RMC 14 SCU'), null)
})

test('automatic terminal discovery joins wide columns without joining other rows', () => {
  const word = (text, x0, y0, x1) => ({ text, bbox: { x0, y0, x1, y1: y0 + 15 } })
  const words = [word('VULTURE', 20, 50, 100), word('STORE', 600, 50, 660), word('PROSPECTOR', 20, 90, 150), word('CLAIM', 600, 90, 660)]
  const areas = locateOcrAreas(words, 800, 600, 'shipTerminal')
  assert.equal(areas.length, 1)
  assert.ok(areas[0].x < 20 / 800 && (areas[0].x + areas[0].width) > 660 / 800)
  assert.ok((areas[0].y + areas[0].height) < 90 / 600)
  assert.deepEqual(locateOcrAreas([], 800, 600, 'shipTerminal'), [])
})