import assert from 'node:assert/strict'
import test from 'node:test'
import { addSalvageMoney, observeSalvage, reconcileSalvage, startSalvageSession, validSalvagingState } from '../src/salvagingOps.ts'
import { saveScannerObservation, validScannerState } from '../src/scannerOps.ts'

const rmc = 'Recycled Material Composite'
const reading = (buffer, hold) => ({ target: 'salvage', identity: 'SALVAGE', values: { ...(buffer === undefined ? {} : { [`buffer:${rmc}`]: buffer }), ...(hold === undefined ? {} : { [`hold:${rmc}`]: hold }) }, live: {}, text: '' })
const fresh = () => startSalvageSession({ sessions: [] }, { shipId: 'v', shipName: 'Vulture', target: 'Wreck', location: 'Yela' }).sessions[0]

test('salvage observations establish baseline, deduplicate and count verified increases', () => {
  const baseline = observeSalvage(fresh(), reading(2, 4))
  assert.equal(baseline.collected[rmc], 0)
  assert.equal(observeSalvage(baseline, reading(2, 4)), baseline)
  const next = observeSalvage(baseline, reading(2.5, 4))
  assert.equal(next.collected[rmc], 0.5)
  assert.equal(observeSalvage(next, reading(3, undefined)).current[`hold:${rmc}`], 4)
  assert.ok(validSalvagingState({ sessions: [next] }))
})

test('boxing and drops pause accounting until explicitly reconciled', () => {
  let session = observeSalvage(fresh(), reading(2, 4))
  session = observeSalvage(session, reading(0, 6))
  assert.deepEqual(session.pending, [rmc])
  assert.equal(session.collected[rmc], 0)
  session = observeSalvage(session, reading(1, 6))
  assert.equal(session.collected[rmc], 0)
  session = reconcileSalvage(session, rmc, 1, 'Boxed 2 SCU, then collected 1 SCU')
  assert.equal(session.collected[rmc], 1)
  assert.deepEqual(session.pending, [])
  session = observeSalvage(session, reading(1.5, 6))
  assert.equal(session.collected[rmc], 1.5)
})

test('manual corrections are not OCR verification and financial links deduplicate', () => {
  let session = observeSalvage(fresh(), reading(2, 4), true)
  assert.deepEqual(session.pending, [rmc])
  const money = { kind: 'sale', amount: 100, note: 'RMC sale', ledgerId: 'ledger-1' }
  session = addSalvageMoney(session, money)
  assert.equal(addSalvageMoney(session, money), session)
  assert.equal(addSalvageMoney(session, { ...money, amount: -10 }), session)
  assert.equal(observeSalvage({ ...session, endedAt: new Date().toISOString() }, reading(4, 4)).current[`buffer:${rmc}`], 2)
})

test('scanner saves stable values only, deduplicates, and validates persistence', () => {
  const scan = { target: 'shipTarget', identity: 'Vulture', values: { 'CARGO (SCU)': 4 }, live: { distance: 100 }, text: '' }
  const state = saveScannerObservation({ observations: [] }, scan, 'Yela')
  assert.equal(saveScannerObservation(state, { ...scan, live: { distance: 200 } }, 'Yela'), state)
  assert.equal(state.observations[0].live, undefined)
  assert.ok(validScannerState(state))
  assert.equal(validSalvagingState({ sessions: [{ ...fresh(), current: { rmc: -1 } }] }), false)
})