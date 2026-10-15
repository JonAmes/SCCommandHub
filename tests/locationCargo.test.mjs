import assert from 'node:assert/strict'
import test from 'node:test'
import { addLocationCargo, buildUnifiedHoldings, listLocationCargo, moveLocationCargoToShip, refinedMaterialName, refineryLocation } from '../src/locationCargo.ts'

const hangar = {
  ships: [{ id: 'c1', vehicleId: 'v', name: 'Spirit C1', manufacturer: 'Crusader', cargoCapacity: 64, photoUrl: '', addedAt: '' }],
  activeShipId: 'c1',
  cargoByShip: { c1: { Medical: 4 } },
}

test('names refinery locations and refined materials', () => {
  assert.equal(refineryLocation('Refinement Processing - ARC-L1'), 'ARC-L1')
  assert.equal(refineryLocation('Refinement Center - Levski'), 'Levski')
  assert.equal(refinedMaterialName('Beryl (Raw)'), 'Beryl')
  assert.equal(refinedMaterialName('Titanium (Ore)'), 'Titanium')
})

test('stores collected material at a location and moves it to a ship', () => {
  let state = addLocationCargo({ byLocation: {} }, 'ARC-L1', [{ commodity: 'Beryl', scu: 30.1 }, { commodity: 'Titanium', scu: 7 }])
  state = addLocationCargo(state, 'ARC-L1', [{ commodity: 'Beryl', scu: 0.2 }])
  assert.deepEqual(listLocationCargo(state), [{ location: 'ARC-L1', commodity: 'Beryl', scu: 30.3 }, { location: 'ARC-L1', commodity: 'Titanium', scu: 7 }])

  const partial = moveLocationCargoToShip(state, hangar, 'ARC-L1', 'Beryl', 10, 'c1')
  assert.equal(partial.state.byLocation['ARC-L1'].Beryl, 20.3)
  assert.deepEqual(partial.hangar.cargoByShip.c1, { Medical: 4, Beryl: 10 })

  const rest = moveLocationCargoToShip(partial.state, partial.hangar, 'ARC-L1', 'Titanium', 7, 'c1')
  assert.equal(rest.state.byLocation['ARC-L1'].Titanium, undefined)
  assert.match(moveLocationCargoToShip(state, hangar, 'ARC-L1', 'Beryl', 31, 'c1').error, /Only 30.3 SCU/)
  assert.match(moveLocationCargoToShip(addLocationCargo(state, 'ARC-L1', [{ commodity: 'Beryl', scu: 40 }]), hangar, 'ARC-L1', 'Beryl', 61, 'c1').error, /hold space remains/)
})

test('unifies purchased, ship, and stored cargo into one row per commodity', () => {
  const ledger = [{ commodity: 'Gold', quantity: 8, averagePurchasePrice: 5 }]
  const fleet = { ...hangar, cargoByShip: { c1: { Gold: 3, Beryl: 10 } } }
  const stored = { byLocation: { 'ARC-L1': { Beryl: 8.4 } } }
  const rows = buildUnifiedHoldings(ledger, fleet, stored)
  assert.deepEqual(rows.map((row) => [row.commodity, row.total, row.unassigned, row.ledgerQuantity]), [['Beryl', 18.4, 0, 0], ['Gold', 8, 5, 8]])
  assert.deepEqual(rows[0].stored, [{ location: 'ARC-L1', scu: 8.4 }])
  assert.deepEqual(rows[0].ships, [{ shipId: 'c1', shipName: 'Spirit C1', scu: 10 }])
})
