import { access, readFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Ingests pre-parsed Star Citizen game data into SQLite.
 *
 * Supported input (StarCitizenWiki/scunpacked-data layout):
 *   - ships:      `ships.json` — array of vehicle objects (`UUID`, `ClassName`, `Name`,
 *                 `Manufacturer`, `Mass`, `Cargo`, `Loadout[]`).
 *   - components: `ship-items.json` (or `components.json` / `items.json`) — array of items
 *                 (`reference`, `className`, `type`, `subType`, `size`, `grade`, `name`, `stdItem`).
 *
 * Entries already in the normalized database shape (`id`, `name`, `class_name`, `hardpoints`,
 * `stats`, ...) are also accepted, which keeps hand-written fixtures and seed files simple.
 */

export const SHIP_FILES = ['ships.json']
export const COMPONENT_FILES = ['ship-items.json', 'components.json', 'items.json']

const PLACEHOLDER_NAME = '<= PLACEHOLDER =>'

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const firstDefined = (...values) => values.find((value) => value !== undefined && value !== null)

function toNumber(value) {
  if (value === undefined || value === null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function toText(value) {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text === '' ? null : text
}

/** Split a dotted scunpacked type (`"WeaponGun.Gun"`) into `[type, subType]`. */
function splitType(value) {
  const text = toText(value)
  if (!text) return [null, null]
  const [type, subType] = text.split('.')
  return [type || null, normalizeSubType(subType)]
}

function normalizeSubType(value) {
  const text = toText(value)
  return text && text.toUpperCase() !== 'UNDEFINED' ? text : null
}

/** Unwrap per-item files (`{ Raw, Item }`) to the item itself. */
const unwrap = (entry) => (isObject(entry?.Item) ? entry.Item : entry)

function manufacturerName(value) {
  if (isObject(value)) return toText(firstDefined(value.name, value.Name, value.code, value.Code))
  return toText(value)
}

/** Normalize a hardpoint/port definition into `{ name, types, minSize, maxSize, ... }`. */
export function normalizeHardpoint(raw) {
  if (!isObject(raw)) return null

  const pathName = Array.isArray(raw.Path) && raw.Path.length > 0 ? raw.Path.join('/') : null
  const name = toText(firstDefined(raw.name, pathName, raw.HardpointName, raw.PortName))
  if (!name) return null

  let types = []
  const compatible = firstDefined(raw.types, raw.CompatibleTypes, raw.Types)
  if (Array.isArray(compatible)) {
    types = compatible
      .map((entry) => {
        if (typeof entry === 'string') {
          const [type, subType] = splitType(entry)
          return type ? { type, subTypes: subType ? [subType] : [] } : null
        }
        const type = toText(firstDefined(entry?.type, entry?.Type))
        if (!type) return null
        const subTypes = firstDefined(entry.subTypes, entry.SubTypes, [])
        return {
          type,
          subTypes: Array.isArray(subTypes) ? subTypes.map(normalizeSubType).filter(Boolean) : [],
        }
      })
      .filter(Boolean)
  }
  if (types.length === 0) {
    const [type, subType] = splitType(firstDefined(raw.type, raw.Type))
    if (type) types = [{ type, subTypes: subType ? [subType] : [] }]
  }

  const size = toNumber(firstDefined(raw.size, raw.Size))
  const minSize = toNumber(firstDefined(raw.minSize, raw.MinSize, size))
  const maxSize = toNumber(firstDefined(raw.maxSize, raw.MaxSize, size))

  return {
    name,
    type: types[0]?.type ?? null,
    types,
    minSize: minSize ?? 0,
    maxSize: maxSize ?? minSize ?? 0,
    editable: firstDefined(raw.editable, raw.Editable, true) !== false,
    defaultItem: toText(firstDefined(raw.defaultItem, raw.ClassName)),
  }
}

/** Normalize a ship/vehicle record into an `sc_ships` row. */
export function normalizeShip(entry) {
  const raw = unwrap(entry)
  if (!isObject(raw)) return null

  const className = toText(firstDefined(raw.class_name, raw.className, raw.ClassName))
  const id = toText(firstDefined(raw.id, raw.uuid, raw.UUID, raw.reference, className))
  if (!id) return null

  const rawHardpoints = firstDefined(raw.hardpoints, raw.Hardpoints, raw.Loadout, [])
  const hardpoints = Array.isArray(rawHardpoints)
    ? rawHardpoints.map(normalizeHardpoint).filter(Boolean)
    : []

  return {
    id,
    name: toText(firstDefined(raw.name, raw.Name)) ?? className ?? id,
    class_name: className,
    manufacturer: manufacturerName(firstDefined(raw.manufacturer, raw.Manufacturer)),
    mass: toNumber(firstDefined(raw.mass, raw.Mass)),
    cargo_capacity: toNumber(firstDefined(raw.cargo_capacity, raw.cargo, raw.Cargo)),
    hardpoints: JSON.stringify(hardpoints),
  }
}

function selectResourceState(resourceNetwork) {
  const states = Array.isArray(resourceNetwork?.States) ? resourceNetwork.States : []
  return states.find((state) => state?.Name === 'Online') ?? states[0] ?? null
}

/**
 * Extract the calculator metrics from a scunpacked `stdItem` block.
 * Missing values are omitted rather than defaulted, so consumers can tell "0" from "unknown".
 */
export function extractStats(stdItem) {
  if (!isObject(stdItem)) return {}

  const stats = {}
  const set = (key, value) => {
    const number = toNumber(value)
    if (number !== null) stats[key] = number
  }

  const damage = stdItem.Weapon?.Damage
  set('burstDps', firstDefined(damage?.Burst, damage?.DpsTotal))
  set('sustainedDps', damage?.Sustained)
  set('alphaDamage', damage?.AlphaTotal)

  set('shieldHp', stdItem.Shield?.MaxShieldHealth)
  set('shieldRegen', stdItem.Shield?.MaxShieldRegen)

  const network = stdItem.ResourceNetwork
  if (isObject(network)) {
    set('powerOutput', network.Generation?.Power)
    set('coolingRate', network.Generation?.Coolant)

    const deltas = selectResourceState(network)?.Deltas
    const powerDeltas = Array.isArray(deltas)
      ? deltas.filter(
          (delta) =>
            delta?.Resource === 'Power' &&
            (delta.Type === 'Consumption' || delta.Type === 'Conversion'),
        )
      : []
    if (powerDeltas.length > 0) {
      set('powerDraw', powerDeltas.reduce((sum, delta) => sum + (toNumber(delta.Rate) ?? 0), 0))
    } else if (stats.powerOutput === undefined) {
      set('powerDraw', network.Usage?.Power?.Maximum)
    }

    // Coolers report their own coolant usage; it is already netted out of their output.
    if (stats.coolingRate === undefined) set('heatGeneration', network.Usage?.Coolant?.Maximum)
  }

  return stats
}

/** Normalize a component/item record into an `sc_components` row. */
export function normalizeComponent(entry) {
  const raw = unwrap(entry)
  if (!isObject(raw)) return null

  const stdItem = firstDefined(raw.stdItem, raw.StdItem, {})
  const className = toText(firstDefined(raw.class_name, raw.className, raw.ClassName, stdItem.ClassName))
  const id = toText(firstDefined(raw.id, raw.reference, raw.uuid, raw.UUID, stdItem.UUID, className))
  if (!id) return null

  const [stdType, stdSubType] = splitType(stdItem.Type)
  const descriptionData = isObject(stdItem.DescriptionData) ? stdItem.DescriptionData : {}

  let name = toText(firstDefined(raw.name, raw.Name, stdItem.Name))
  if (!name || name === PLACEHOLDER_NAME) name = className ?? id

  const explicitStats = isObject(raw.stats) ? raw.stats : {}

  return {
    id,
    name,
    type: toText(firstDefined(raw.type, raw.Type, stdType)),
    sub_type: normalizeSubType(firstDefined(raw.sub_type, raw.subType, raw.SubType, stdSubType)),
    size: toNumber(firstDefined(raw.size, raw.Size, stdItem.Size)),
    grade: toText(firstDefined(descriptionData.Grade, raw.grade, raw.Grade, stdItem.Grade)),
    class: toText(firstDefined(raw.class, descriptionData.Class)),
    stats: JSON.stringify({ ...extractStats(stdItem), ...explicitStats }),
  }
}

async function findFirstFile(dataDir, candidates) {
  for (const candidate of candidates) {
    const filePath = path.join(dataDir, candidate)
    try {
      await access(filePath)
      return filePath
    } catch {
      // try the next candidate
    }
  }
  return null
}

async function readJsonArray(filePath) {
  const parsed = JSON.parse(await readFile(filePath, 'utf8'))
  if (Array.isArray(parsed)) return parsed
  // Tolerate `{ data: [...] }` style wrappers (e.g. API dumps).
  if (isObject(parsed) && Array.isArray(parsed.data)) return parsed.data
  throw new Error(`Expected a JSON array in ${filePath}`)
}

/**
 * Read ship and component JSON files from `dataDir` and bulk upsert them.
 *
 * @param {import('better-sqlite3').Database} db  Database with the SC schema applied.
 * @param {string} dataDir                       Directory containing the data files.
 * @returns {Promise<{ ships: number, components: number, skipped: number, files: { ships: string|null, components: string|null } }>}
 */
export async function ingestGameData(db, dataDir) {
  const shipFile = await findFirstFile(dataDir, SHIP_FILES)
  const componentFile = await findFirstFile(dataDir, COMPONENT_FILES)
  if (!shipFile && !componentFile) {
    throw new Error(
      `No game data found in ${dataDir}. Expected one of: ${[...SHIP_FILES, ...COMPONENT_FILES].join(', ')}`,
    )
  }

  const rawShips = shipFile ? await readJsonArray(shipFile) : []
  const rawComponents = componentFile ? await readJsonArray(componentFile) : []

  const ships = rawShips.map(normalizeShip).filter(Boolean)
  const components = rawComponents.map(normalizeComponent).filter(Boolean)

  const upsertShip = db.prepare(`
    INSERT INTO sc_ships (id, name, class_name, manufacturer, mass, cargo_capacity, hardpoints)
    VALUES (@id, @name, @class_name, @manufacturer, @mass, @cargo_capacity, @hardpoints)
    ON CONFLICT (id) DO UPDATE SET
      name = excluded.name,
      class_name = excluded.class_name,
      manufacturer = excluded.manufacturer,
      mass = excluded.mass,
      cargo_capacity = excluded.cargo_capacity,
      hardpoints = excluded.hardpoints
  `)

  const upsertComponent = db.prepare(`
    INSERT INTO sc_components (id, name, type, sub_type, size, grade, class, stats)
    VALUES (@id, @name, @type, @sub_type, @size, @grade, @class, @stats)
    ON CONFLICT (id) DO UPDATE SET
      name = excluded.name,
      type = excluded.type,
      sub_type = excluded.sub_type,
      size = excluded.size,
      grade = excluded.grade,
      class = excluded.class,
      stats = excluded.stats
  `)

  db.transaction(() => {
    for (const ship of ships) upsertShip.run(ship)
    for (const component of components) upsertComponent.run(component)
  })()

  return {
    ships: ships.length,
    components: components.length,
    skipped: rawShips.length - ships.length + (rawComponents.length - components.length),
    files: { ships: shipFile, components: componentFile },
  }
}
