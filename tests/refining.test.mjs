import assert from 'node:assert/strict'
import test from 'node:test'
import { collectRefiningJob, createRefiningOrder, formatRemaining, getRefiningProgress, getRefiningStatus, getShipOre } from '../src/refining.ts'

const minerals = ['Beryl (Raw)', 'Titanium (Ore)']
const hangar = {
  ships: [{ id: 'mole', vehicleId: 'v', name: 'MOLE', manufacturer: 'Argo', cargoCapacity: 96, photoUrl: '', addedAt: '' }],
  activeShipId: 'mole',
  cargoByShip: { mole: { 'Beryl (Raw)': 31.6, 'Titanium (Ore)': 7.6, Medical: 2 } },
}
const start = new Date('2026-10-15T12:00:00.000Z')

test('detects only raw ore on the active ship', () => {
  assert.deepEqual(getShipOre(hangar, 'mole', minerals), [{ commodity: 'Beryl (Raw)', scu: 31.6 }, { commodity: 'Titanium (Ore)', scu: 7.6 }])
})

test('an order takes all ore at once and applies the refinery timer', () => {
  const result = createRefiningOrder({ jobs: [] }, hangar, { refinery: 'ARC-L1', method: 'Dinyx Solventation', durationMinutes: 150 }, minerals, start)
  const job = result.state.jobs[0]
  assert.equal(job.totalScu, 39.2)
  assert.equal(job.completesAt, '2026-10-15T14:30:00.000Z')
  assert.deepEqual(result.hangar.cargoByShip.mole, { Medical: 2 })

  assert.equal(getRefiningStatus(job, start.getTime() + 60 * 60_000), 'processing')
  assert.equal(getRefiningProgress(job, start.getTime() + 75 * 60_000), 0.5)
  assert.equal(collectRefiningJob(result.state, job.id, [], new Date(start.getTime() + 60_000)).jobs[0].collectedAt, undefined)
  const done = new Date(start.getTime() + 151 * 60_000)
  assert.equal(getRefiningStatus(job, done.getTime()), 'ready')
  const collected = collectRefiningJob(result.state, job.id, [{ commodity: 'Beryl', scu: 30.1 }, { commodity: 'Titanium', scu: 0 }], done).jobs[0]
  assert.equal(getRefiningStatus(collected, done.getTime()), 'collected')
  assert.deepEqual(collected.refined, [{ commodity: 'Beryl', scu: 30.1 }])
})

test('rejects orders without ore or a valid timer', () => {
  assert.match(createRefiningOrder({ jobs: [] }, { ...hangar, cargoByShip: { mole: {} } }, { refinery: 'ARC-L1', method: 'Cormack', durationMinutes: 60 }, minerals).error, /no raw ore/)
  assert.match(createRefiningOrder({ jobs: [] }, hangar, { refinery: 'ARC-L1', method: 'Cormack', durationMinutes: 0 }, minerals).error, /processing time/)
})

test('formats countdowns', () => {
  assert.equal(formatRemaining(90 * 60_000), '1h 30m')
  assert.equal(formatRemaining(125_000), '2m 05s')
  assert.equal(formatRemaining(26 * 3600_000), '1d 2h 0m')
})
