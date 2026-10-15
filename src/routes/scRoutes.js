import { json, Router } from 'express'
import { calculateLoadout } from '../services/loadoutEngine.js'

const MAX_LOADOUT_SLOTS = 500

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function parseJsonColumn(value, fallback) {
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

const toShip = (row) => row && { ...row, hardpoints: parseJsonColumn(row.hardpoints, []) }
const toComponent = (row) => row && { ...row, stats: parseJsonColumn(row.stats, {}) }

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * Express router for the Star Citizen item database and loadout calculator.
 * Mount at `/api/sc`, e.g. `app.use('/api/sc', createSCRouter(db))`.
 *
 * @param {import('better-sqlite3').Database} db  Database with the SC schema applied.
 */
export function createSCRouter(db) {
  const router = Router()
  router.use(json({ limit: '100kb' }))

  const statements = {
    listShips: db.prepare(
      'SELECT id, name, class_name, manufacturer, mass, cargo_capacity FROM sc_ships ORDER BY name',
    ),
    getShip: db.prepare('SELECT * FROM sc_ships WHERE id = ?'),
    listComponents: db.prepare(`
      SELECT * FROM sc_components
      WHERE (@type IS NULL OR type = @type COLLATE NOCASE)
        AND (@size IS NULL OR size = @size)
      ORDER BY type, size, name
    `),
    componentsByIds: db.prepare('SELECT * FROM sc_components WHERE id IN (SELECT value FROM json_each(?))'),
  }

  router.get('/ships', (_req, res) => {
    res.json(statements.listShips.all())
  })

  router.get('/ships/:id', (req, res) => {
    const ship = toShip(statements.getShip.get(req.params.id))
    if (!ship) throw new HttpError(404, `Ship "${req.params.id}" not found`)
    res.json(ship)
  })

  router.get('/components', (req, res) => {
    const { type, size } = req.query
    if (type !== undefined && typeof type !== 'string') throw new HttpError(400, '"type" must be a string')

    let sizeFilter = null
    if (size !== undefined) {
      if (typeof size !== 'string' || !/^\d+$/.test(size)) {
        throw new HttpError(400, '"size" must be a non-negative integer')
      }
      sizeFilter = Number(size)
    }

    const rows = statements.listComponents.all({ type: type || null, size: sizeFilter })
    res.json(rows.map(toComponent))
  })

  router.post('/loadouts/calculate', (req, res) => {
    const { shipId, loadoutMap } = req.body ?? {}

    if (typeof shipId !== 'string' && typeof shipId !== 'number') {
      throw new HttpError(400, '"shipId" is required')
    }
    if (!isPlainObject(loadoutMap)) {
      throw new HttpError(400, '"loadoutMap" must be an object of slot name to component ID')
    }
    const entries = Object.entries(loadoutMap)
    if (entries.length > MAX_LOADOUT_SLOTS) {
      throw new HttpError(400, `"loadoutMap" may contain at most ${MAX_LOADOUT_SLOTS} slots`)
    }
    for (const [slot, componentId] of entries) {
      if (componentId !== null && typeof componentId !== 'string' && typeof componentId !== 'number') {
        throw new HttpError(400, `Component ID for slot "${slot}" must be a string or null`)
      }
    }

    const ship = toShip(statements.getShip.get(String(shipId)))
    if (!ship) throw new HttpError(404, `Ship "${shipId}" not found`)

    const componentIds = [
      ...new Set(entries.map(([, id]) => id).filter((id) => id !== null && id !== '').map(String)),
    ]
    const components = statements.componentsByIds.all(JSON.stringify(componentIds)).map(toComponent)

    res.json(calculateLoadout(ship, loadoutMap, components))
  })

  // Router-scoped error handler so callers get JSON errors without extra server wiring.
  router.use((err, _req, res, next) => {
    if (res.headersSent) return next(err)
    const status = err.status ?? err.statusCode ?? 500
    if (status >= 500) console.error('[sc-api]', err)
    res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message })
  })

  return router
}
