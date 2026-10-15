import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import express from 'express'
import { initSCSchema } from '../src/db/scSchema.js'
import { createSCRouter } from '../src/routes/scRoutes.js'
import { calculateLoadout } from '../src/services/loadoutEngine.js'
import { ingestGameData } from '../src/services/scDataIngestor.js'

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sc')

const GLADIUS = 'b6b59889-7226-458e-a6b0-1c9392128a3c'
const CANNON_S1 = '42e2ddb1-7397-4299-88ee-2ddfaa0efc67'
const SHIELD = '0baaf20a-460e-4668-84f2-d09f9d31b492'
const POWER_PLANT = '3493c2d7-9b7f-43ca-aebb-8019fbcc9ef4'
const COOLER = '4ec3037b-4b6f-4837-b00d-cd9b4836a82a'

const STOCK_LOADOUT = {
  hardpoint_gun_nose: 'test-cannon-s3',
  hardpoint_power_plant: POWER_PLANT,
  Hardpoint_cooler_left: COOLER,
  Hardpoint_cooler_right: COOLER,
  hardpoint_shield_generator_left: SHIELD,
  hardpoint_shield_generator_right: SHIELD,
}

async function createDb() {
  const db = initSCSchema(new Database(':memory:'))
  await ingestGameData(db, fixturesDir)
  return db
}

const loadShip = (db, id) => db.prepare('SELECT * FROM sc_ships WHERE id = ?').get(id)
const loadComponents = (db) => db.prepare('SELECT * FROM sc_components').all()

describe('scDataIngestor', () => {
  it('normalizes scunpacked ships and components and upserts idempotently', async () => {
    const db = initSCSchema(new Database(':memory:'))
    const first = await ingestGameData(db, fixturesDir)
    const second = await ingestGameData(db, fixturesDir)

    assert.equal(first.ships, 1)
    assert.equal(first.components, 6)
    assert.deepEqual(second, first)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sc_components').get().n, 6)

    const ship = loadShip(db, GLADIUS)
    assert.equal(ship.name, 'Aegis Gladius')
    assert.equal(ship.class_name, 'AEGS_Gladius')
    assert.equal(ship.manufacturer, 'Aegis Dynamics')
    assert.equal(ship.mass, 48552)
    assert.equal(ship.cargo_capacity, 0)
    const nose = JSON.parse(ship.hardpoints).find((h) => h.name === 'hardpoint_gun_nose')
    assert.deepEqual(nose.types.map((t) => t.type), ['Turret', 'WeaponGun'])
    assert.equal(nose.maxSize, 3)

    const byId = (id) => {
      const row = db.prepare('SELECT * FROM sc_components WHERE id = ?').get(id)
      return { ...row, stats: JSON.parse(row.stats) }
    }

    const cannon = byId(CANNON_S1)
    assert.equal(cannon.type, 'WeaponGun')
    assert.equal(cannon.sub_type, 'Gun')
    assert.equal(cannon.size, 1)
    assert.equal(cannon.stats.burstDps, 303.8)
    assert.equal(cannon.stats.sustainedDps, 189.2)
    assert.equal(cannon.stats.powerDraw, 0.704)

    const shield = byId(SHIELD)
    assert.equal(shield.sub_type, null)
    assert.equal(shield.grade, 'A')
    assert.equal(shield.class, 'Military')
    assert.equal(shield.stats.shieldHp, 3168)
    assert.equal(shield.stats.powerDraw, 3)

    const powerPlant = byId(POWER_PLANT)
    assert.equal(powerPlant.stats.powerOutput, 16)
    assert.equal(powerPlant.stats.powerDraw, undefined)

    const cooler = byId(COOLER)
    assert.equal(cooler.stats.coolingRate, 34)
    assert.equal(cooler.stats.heatGeneration, undefined)
  })

  it('rejects a directory without data files', async () => {
    const db = initSCSchema(new Database(':memory:'))
    await assert.rejects(ingestGameData(db, path.join(fixturesDir, 'missing')), /No game data found/)
  })
})

describe('loadoutEngine.calculateLoadout', () => {
  let db
  before(async () => {
    db = await createDb()
  })
  after(() => db.close())

  it('aggregates DPS, shields, power and cooling for a valid loadout', () => {
    const result = calculateLoadout(loadShip(db, GLADIUS), STOCK_LOADOUT, loadComponents(db))

    assert.equal(result.valid, true)
    assert.deepEqual(result.errors, [])
    assert.equal(result.totals.burstDps, 800)
    assert.equal(result.totals.sustainedDps, 500)
    assert.equal(result.totals.shieldHp, 6336)
    assert.deepEqual(result.totals.power, {
      generation: 16,
      draw: 14.5,
      margin: 1.5,
      utilization: 90.63,
      valid: true,
      status: 'ok',
    })
    assert.equal(result.totals.cooling.capacity, 68)
    assert.equal(result.totals.cooling.heatGeneration, 24.5)
    assert.equal(result.totals.cooling.valid, true)
  })

  it('rejects oversized, undersized, mistyped and unknown entries', () => {
    const result = calculateLoadout(
      loadShip(db, GLADIUS),
      {
        hardpoint_gun_nose: 'test-cannon-s4',
        Hardpoint_cooler_left: CANNON_S1,
        hardpoint_shield_generator_left: 'does-not-exist',
        hardpoint_missing: SHIELD,
        hardpoint_controller_shield: SHIELD,
        Hardpoint_cooler_right: null,
      },
      loadComponents(db),
    )

    const codes = result.errors.map((e) => `${e.slot}:${e.code}`).sort()
    assert.deepEqual(codes, [
      'Hardpoint_cooler_left:TYPE_MISMATCH',
      'hardpoint_controller_shield:SLOT_NOT_EDITABLE',
      'hardpoint_controller_shield:TYPE_MISMATCH',
      'hardpoint_gun_nose:SIZE_TOO_LARGE',
      'hardpoint_missing:UNKNOWN_SLOT',
      'hardpoint_shield_generator_left:UNKNOWN_COMPONENT',
    ])
    assert.equal(result.valid, false)
    assert.equal(result.totals.burstDps, 0)
    assert.equal(result.slots.length, 5)
  })

  it('flags undersized weapons and power/cooling shortfalls', () => {
    const result = calculateLoadout(
      loadShip(db, GLADIUS),
      { hardpoint_gun_nose: CANNON_S1, hardpoint_shield_generator_left: SHIELD },
      loadComponents(db),
    )

    assert.deepEqual(result.errors.map((e) => e.code), ['SIZE_TOO_SMALL'])
    assert.equal(result.totals.power.valid, false)
    assert.equal(result.totals.power.status, 'no_generation')
    assert.equal(result.totals.cooling.status, 'no_cooling')
    assert.deepEqual(result.warnings.map((w) => w.code), ['NO_POWER_GENERATION', 'NO_COOLING'])
  })
})

describe('createSCRouter', () => {
  let db
  let server
  let baseUrl

  before(async () => {
    db = await createDb()
    const app = express()
    app.use('/api/sc', createSCRouter(db))
    server = app.listen(0, '127.0.0.1')
    await new Promise((resolve) => server.once('listening', resolve))
    baseUrl = `http://127.0.0.1:${server.address().port}/api/sc`
  })
  after(() => {
    server.close()
    db.close()
  })

  const get = async (url) => {
    const res = await fetch(baseUrl + url)
    return { status: res.status, body: await res.json() }
  }
  const post = async (url, body) => {
    const res = await fetch(baseUrl + url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
    return { status: res.status, body: await res.json() }
  }

  it('lists ships and fetches a ship with parsed hardpoints', async () => {
    const list = await get('/ships')
    assert.equal(list.status, 200)
    assert.deepEqual(list.body.map((s) => s.id), [GLADIUS])
    assert.equal(list.body[0].hardpoints, undefined)

    const ship = await get(`/ships/${GLADIUS}`)
    assert.equal(ship.status, 200)
    assert.ok(Array.isArray(ship.body.hardpoints))

    assert.equal((await get('/ships/nope')).status, 404)
  })

  it('filters components by type and size', async () => {
    const weapons = await get('/components?type=weapongun')
    assert.equal(weapons.status, 200)
    assert.equal(weapons.body.length, 3)
    assert.equal(typeof weapons.body[0].stats, 'object')

    const s3 = await get('/components?type=WeaponGun&size=3')
    assert.deepEqual(s3.body.map((c) => c.id), ['test-cannon-s3'])

    assert.equal((await get('/components')).body.length, 6)
    assert.equal((await get('/components?size=abc')).status, 400)
  })

  it('calculates a loadout and validates input', async () => {
    const ok = await post('/loadouts/calculate', { shipId: GLADIUS, loadoutMap: STOCK_LOADOUT })
    assert.equal(ok.status, 200)
    assert.equal(ok.body.valid, true)
    assert.equal(ok.body.totals.shieldHp, 6336)

    assert.equal((await post('/loadouts/calculate', { loadoutMap: {} })).status, 400)
    assert.equal((await post('/loadouts/calculate', { shipId: GLADIUS, loadoutMap: [] })).status, 400)
    assert.equal(
      (await post('/loadouts/calculate', { shipId: GLADIUS, loadoutMap: { a: { x: 1 } } })).status,
      400,
    )
    assert.equal((await post('/loadouts/calculate', { shipId: 'nope', loadoutMap: {} })).status, 404)
    assert.equal((await post('/loadouts/calculate', '{bad json')).status, 400)
  })
})
