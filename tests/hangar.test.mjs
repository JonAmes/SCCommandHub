import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { findVehicleForModelCode, importShipsFromJson } from '../src/hangarImport.ts'

const initialState = {
  ships: [{ id: 'existing', vehicleId: 'uex-1', name: 'Existing', manufacturer: 'A', cargoCapacity: 10, photoUrl: '', addedAt: '2026-01-01T00:00:00.000Z' }],
  activeShipId: 'existing',
  cargoByShip: { existing: { Ore: 2 } },
}

test('imports ship details only and preserves existing active ship and cargo', () => {
  const result = importShipsFromJson(initialState, JSON.stringify({
    ships: [{ id: 'local-id', vehicleId: 'uex-2', name: 'New ship', company_name: 'Banu', scu: 64, url_photo: 'ship.jpg' }],
    ccus: [{ id: 'ccu-1', name: 'Upgrade' }],
  }))

  assert.equal(result.added, 1)
  assert.equal(result.skipped, 0)
  assert.equal(result.state?.ships.length, 2)
  assert.deepEqual(result.state?.ships[1], {
    id: result.state?.ships[1].id,
    vehicleId: 'uex-2',
    name: 'New ship',
    manufacturer: 'Banu',
    cargoCapacity: 64,
    photoUrl: 'ship.jpg',
    addedAt: result.state?.ships[1].addedAt,
  })
  assert.equal(result.state?.activeShipId, 'existing')
  assert.deepEqual(result.state?.cargoByShip, { existing: { Ore: 2 }, [result.state.ships[1].id]: {} })
})

test('imports nested app hangar exports and skips existing or repeated ships', () => {
  const result = importShipsFromJson(initialState, JSON.stringify({
    data: { hangar: { ships: [
      { vehicleId: 'uex-1', name: 'Existing' },
      { vehicleId: 'uex-2', name: 'Imported' },
      { vehicleId: 'uex-2', name: 'Duplicate' },
      { vehicleId: 'uex-3' },
    ] } },
  }))

  assert.equal(result.added, 1)
  assert.equal(result.skipped, 3)
  assert.equal(result.state?.ships.at(-1)?.name, 'Imported')
})

test('does not import upgrades or non-ship records from a mixed array', () => {
  const result = importShipsFromJson(initialState, JSON.stringify([
    { id: 'uex-2', name: 'Imported', is_spaceship: 1 },
    { id: 'ccu-1', name: 'Upgrade', type: 'CCU' },
    { id: 'addon-1', name: 'Paint', is_addon: 1 },
  ]))

  assert.equal(result.added, 1)
  assert.equal(result.skipped, 2)
  assert.deepEqual(result.state?.ships.map((ship) => ship.name), ['Existing', 'Imported'])
})

test('imports the provided shiplist fields and enriches from a matching catalog record', async () => {
  const json = await readFile(new URL('../shiplist.json', import.meta.url), 'utf8')
  const result = importShipsFromJson({ ships: [], activeShipId: null, cargoByShip: {} }, json, (ship) => (
    ship.ship_code === 'CRUS_Spirit_C1'
      ? { id: 'uex-c1', company_name: 'Crusader Industries', scu: 128, url_photo: 'c1.jpg' }
      : undefined
  ))

  assert.equal(result.added, 9)
  assert.equal(result.skipped, 0)
  assert.deepEqual(result.state?.ships[0], {
    id: result.state?.ships[0].id,
    vehicleId: 'uex-c1',
    name: 'Spirit C1',
    manufacturer: 'Crusader Industries',
    cargoCapacity: 128,
    photoUrl: 'c1.jpg',
    addedAt: result.state?.ships[0].addedAt,
  })
})

test('matches model codes to catalog names with descriptive suffixes and ranks variants closely', () => {
  const vehicles = [
    { id: 'c8r', name: 'C8R Pisces Rescue' },
    { id: 'c8x', name: 'C8X Pisces Expedition' },
    { id: 'cutter-scout', name: 'Cutter Scout' },
    { id: 'cutter', name: 'Cutter' },
  ]

  assert.equal(findVehicleForModelCode('ANVL_C8R_Pisces', vehicles)?.id, 'c8r')
  assert.equal(findVehicleForModelCode('DRAK_Cutter', vehicles)?.id, 'cutter')
})

test('corrects ships imported with the old name-based ID and keeps their cargo', () => {
  const oldState = {
    ships: [{ id: 'local-ship', vehicleId: 'import:c1-spirit', name: 'C1 Spirit', manufacturer: '', cargoCapacity: 0, photoUrl: '', addedAt: '2026-01-01T00:00:00.000Z' }],
    activeShipId: 'local-ship',
    cargoByShip: { 'local-ship': { Ore: 2 } },
  }
  const result = importShipsFromJson(oldState, JSON.stringify([
    { ship_code: 'CRUS_Spirit_C1', ship_name: 'Spirit C1', name: 'C1 Spirit', manufacturer_name: 'Crusader Industries', entity_type: 'ship' },
  ]))

  assert.equal(result.updated, 1)
  assert.equal(result.added, 0)
  assert.equal(result.state?.ships[0].id, 'local-ship')
  assert.equal(result.state?.ships[0].vehicleId, 'CRUS_Spirit_C1')
  assert.equal(result.state?.ships[0].name, 'Spirit C1')
  assert.deepEqual(result.state?.cargoByShip, oldState.cargoByShip)
})

test('reports malformed JSON and unsupported file shapes', () => {
  assert.match(importShipsFromJson(initialState, '{').error ?? '', /valid JSON/)
  assert.match(importShipsFromJson(initialState, JSON.stringify({ ccus: [] })).error ?? '', /ships array/)
})