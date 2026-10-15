import type { HangarShip, HangarState } from './hangar'

function createImportedId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function getImportedText(ship: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = ship[key]
    if (typeof value === 'string' || typeof value === 'number') return String(value).trim()
  }
  return ''
}

function getImportedNumber(ship: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = Number(ship[key])
    if (Number.isFinite(value) && value >= 0) return value
  }
  return 0
}

export function findVehicleForModelCode(modelCode: string, vehicles: Record<string, unknown>[]) {
  const modelTokens = modelCode.split('_').slice(1).map((part) => part.toLowerCase()).filter(Boolean)
  if (!modelTokens.length) return undefined
  return vehicles
    .map((vehicle) => ({ vehicle, tokens: (getImportedText(vehicle, 'name', 'vehicle_name', 'name_full').toLowerCase().match(/[a-z0-9]+/g) ?? []) as string[] }))
    .filter(({ tokens }) => modelTokens.every((token) => tokens.includes(token)))
    .sort((left, right) => (left.tokens.length - modelTokens.length) - (right.tokens.length - modelTokens.length))[0]?.vehicle
}

function getLegacyImportId(name: string) {
  return `import:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`
}

export function importShipsFromJson(
  state: HangarState,
  json: string,
  resolveVehicle?: (ship: Record<string, unknown>) => Record<string, unknown> | undefined,
): { state?: HangarState; added?: number; updated?: number; skipped?: number; error?: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return { error: 'This file is not valid JSON.' }
  }

  let imported: unknown
  if (Array.isArray(parsed)) {
    imported = parsed
  } else if (parsed && typeof parsed === 'object') {
    const root = parsed as Record<string, unknown>
    const data = root.data && typeof root.data === 'object' ? root.data as Record<string, unknown> : null
    const hangar = root.hangar && typeof root.hangar === 'object' ? root.hangar as Record<string, unknown> : null
    const dataHangar = data?.hangar && typeof data.hangar === 'object' ? data.hangar as Record<string, unknown> : null
    imported = root.ships ?? hangar?.ships ?? dataHangar?.ships
  }
  if (!Array.isArray(imported)) return { error: 'Expected a JSON array of ships or an object containing a ships array.' }

  const ships = [...state.ships]
  const vehicleIds = new Set(ships.map((ship) => ship.vehicleId))
  let added = 0
  let updated = 0
  let skipped = 0
  for (const entry of imported) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      skipped += 1
      continue
    }
    const source = entry as Record<string, unknown>
    const recordType = getImportedText(source, 'entity_type', 'type', 'kind', 'category', 'item_type').toLowerCase()
    const markedAsNonShip = source.is_spaceship === false || Number(source.is_spaceship) === 0
      || source.is_addon === true || Number(source.is_addon) === 1
      || source.is_ccu === true || Number(source.is_ccu) === 1
      || source.is_upgrade === true || Number(source.is_upgrade) === 1
      || recordType.includes('ccu') || recordType.includes('upgrade')
    if (markedAsNonShip) {
      skipped += 1
      continue
    }
    const vehicle = resolveVehicle?.(source)
    const name = getImportedText(source, 'ship_name', 'vehicle_name', 'name')
    if (!name) {
      skipped += 1
      continue
    }
    const vehicleId = getImportedText(vehicle ?? {}, 'id')
      || getImportedText(source, 'vehicleId', 'vehicle_id', 'ship_code', 'id_vehicle', 'ship_id', 'id')
      || getLegacyImportId(name)
    const legacyNames = ['name', 'vehicle_name', 'ship_name'].map((key) => getImportedText(source, key)).filter(Boolean)
    const legacyShipIndex = ships.findIndex((ship) => legacyNames.some((legacyName) => ship.vehicleId === getLegacyImportId(legacyName)))
    if (legacyShipIndex >= 0) {
      const legacyShip = ships[legacyShipIndex]
      if (vehicleIds.has(vehicleId) && legacyShip.vehicleId !== vehicleId) {
        skipped += 1
        continue
      }
      vehicleIds.delete(legacyShip.vehicleId)
      vehicleIds.add(vehicleId)
      ships[legacyShipIndex] = {
        ...legacyShip,
        vehicleId,
        name,
        manufacturer: getImportedText(source, 'manufacturer_name', 'manufacturer', 'company_name', 'company')
          || getImportedText(vehicle ?? {}, 'company_name')
          || getImportedText(source, 'manufacturer_code')
          || legacyShip.manufacturer,
        cargoCapacity: getImportedNumber(source, 'cargoCapacity', 'cargo_capacity', 'cargo_scu', 'scu')
          || getImportedNumber(vehicle ?? {}, 'scu')
          || legacyShip.cargoCapacity,
        photoUrl: getImportedText(source, 'photoUrl', 'photo_url', 'url_photo', 'image')
          || getImportedText(vehicle ?? {}, 'url_photo')
          || legacyShip.photoUrl,
      }
      updated += 1
      continue
    }
    if (vehicleIds.has(vehicleId)) {
      skipped += 1
      continue
    }
    vehicleIds.add(vehicleId)
    const ship: HangarShip = {
      id: createImportedId(),
      vehicleId,
      name,
      manufacturer: getImportedText(source, 'manufacturer_name', 'manufacturer', 'company_name', 'company')
        || getImportedText(vehicle ?? {}, 'company_name')
        || getImportedText(source, 'manufacturer_code'),
      cargoCapacity: getImportedNumber(source, 'cargoCapacity', 'cargo_capacity', 'cargo_scu', 'scu')
        || getImportedNumber(vehicle ?? {}, 'scu'),
      photoUrl: getImportedText(source, 'photoUrl', 'photo_url', 'url_photo', 'image')
        || getImportedText(vehicle ?? {}, 'url_photo'),
      addedAt: new Date().toISOString(),
    }
    ships.push(ship)
    added += 1
  }
  if (!added && !updated && !skipped) return { error: 'No ships were found in this file.' }

  const newShips = ships.slice(state.ships.length)
  return {
    state: {
      ...state,
      ships,
      activeShipId: state.activeShipId ?? newShips[0]?.id ?? null,
      cargoByShip: { ...state.cargoByShip, ...Object.fromEntries(newShips.map((ship) => [ship.id, {}])) },
    },
    added,
    updated,
    skipped,
  }
}