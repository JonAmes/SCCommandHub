import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { formatLocationCode, isAtLocation, locationKeys } from '../src/playerLocation.ts'

const require = createRequire(import.meta.url)
const { createGameLogParserState, parseGameLogLines } = require('../electron/gameLogParser.cjs')

test('parses player location from Game.log inventory requests', () => {
  const events = parseGameLogLines([
    '<2026-10-15T15:00:00.000Z> [Notice] <RequestLocationInventory> Player[Wintermute] requested inventory for Location[RR_ARC_L1] [Team_GameServices][Inventory]',
  ], createGameLogParserState('LIVE'))
  assert.deepEqual(events, [{ type: 'location', channel: 'LIVE', locationCode: 'RR_ARC_L1', recordedAt: '2026-10-15T15:00:00.000Z' }])
})

test('matches location codes to UEX terminal place names', () => {
  assert.deepEqual(locationKeys('RR_ARC_L1'), ['arcl1'])
  assert.equal(formatLocationCode('RR_ARC_L1'), 'ARC-L1')
  assert.equal(formatLocationCode('Stanton1_Lorville'), 'Lorville')
  assert.equal(isAtLocation('RR_ARC_L1', ['Commodity Shop - ARC-L1', 'ARC-L1 Wide Forest Station']), true)
  assert.equal(isAtLocation('RR_ARC_L1', ['ARC-L2 Lively Pathway Station']), false)
  assert.equal(isAtLocation('Stanton1_Lorville', ['TDD - Lorville', 'Lorville']), true)
  assert.equal(isAtLocation('Stanton3_Area18', ['TDD - Area 18']), true)
  assert.equal(isAtLocation(null, ['Lorville']), false)
})
