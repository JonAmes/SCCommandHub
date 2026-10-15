import type { HangarState } from './hangar'
import type { RefiningOre } from './refining'

const storageKey = 'sc-command-hub.location-cargo-v1'

export type LocationCargoState = { byLocation: Record<string, Record<string, number>> }
export type LocationCargoRow = { location: string; commodity: string; scu: number }

const round = (value: number) => Math.round(value * 100) / 100

export function loadLocationCargo(): LocationCargoState {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(storageKey) ?? 'null')
    const byLocation = parsed && typeof parsed === 'object' ? (parsed as Partial<LocationCargoState>).byLocation : undefined
    if (!byLocation || typeof byLocation !== 'object') return { byLocation: {} }
    return {
      byLocation: Object.fromEntries(Object.entries(byLocation)
        .map(([location, cargo]) => [location, Object.fromEntries(Object.entries(cargo && typeof cargo === 'object' ? cargo : {}).filter((entry): entry is [string, number] => Number.isFinite(entry[1]) && entry[1] > 0))])
        .filter(([, cargo]) => Object.keys(cargo).length)),
    }
  } catch {
    return { byLocation: {} }
  }
}

export function saveLocationCargo(state: LocationCargoState) {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(state))
    return true
  } catch {
    return false
  }
}

export function refineryLocation(refinery: string) {
  return refinery.replace(/^Refinement\s+(Processing|Center)\s*-\s*/i, '').trim() || refinery
}

export function refinedMaterialName(ore: string) {
  return ore.replace(/\s*\((Raw|Ore)\)\s*$/i, '').trim() || ore
}

export function addLocationCargo(state: LocationCargoState, location: string, items: RefiningOre[]): LocationCargoState {
  const cargo = { ...(state.byLocation[location] ?? {}) }
  for (const item of items) {
    if (!item.commodity.trim() || !Number.isFinite(item.scu) || item.scu <= 0) continue
    cargo[item.commodity] = round((cargo[item.commodity] ?? 0) + item.scu)
  }
  return Object.keys(cargo).length ? { byLocation: { ...state.byLocation, [location]: cargo } } : state
}

export function listLocationCargo(state: LocationCargoState): LocationCargoRow[] {
  return Object.entries(state.byLocation)
    .flatMap(([location, cargo]) => Object.entries(cargo).map(([commodity, scu]) => ({ location, commodity, scu })))
    .sort((left, right) => left.location.localeCompare(right.location) || left.commodity.localeCompare(right.commodity))
}

export type UnifiedHolding = {
  commodity: string
  total: number
  ledgerQuantity: number
  averagePurchasePrice: number
  unassigned: number
  ships: { shipId: string; shipName: string; scu: number }[]
  stored: { location: string; scu: number }[]
}

// Combines ledger purchases, ship holds, and station storage into one row per commodity.
export function buildUnifiedHoldings(ledger: { commodity: string; quantity: number; averagePurchasePrice: number }[], hangar: HangarState, stored: LocationCargoState): UnifiedHolding[] {
  const commodities = new Set([
    ...ledger.map((holding) => holding.commodity),
    ...Object.values(hangar.cargoByShip).flatMap((cargo) => Object.keys(cargo)),
    ...Object.values(stored.byLocation).flatMap((cargo) => Object.keys(cargo)),
  ])
  return [...commodities].map((commodity) => {
    const owned = ledger.find((holding) => holding.commodity === commodity)
    const ships = hangar.ships
      .map((ship) => ({ shipId: ship.id, shipName: ship.name, scu: hangar.cargoByShip[ship.id]?.[commodity] ?? 0 }))
      .filter((ship) => ship.scu > 0)
    const storedRows = Object.entries(stored.byLocation)
      .map(([location, cargo]) => ({ location, scu: cargo[commodity] ?? 0 }))
      .filter((row) => row.scu > 0)
    const shipTotal = ships.reduce((sum, ship) => sum + ship.scu, 0)
    const ledgerQuantity = owned?.quantity ?? 0
    const unassigned = Math.max(0, ledgerQuantity - shipTotal)
    return {
      commodity,
      total: round(unassigned + shipTotal + storedRows.reduce((sum, row) => sum + row.scu, 0)),
      ledgerQuantity,
      averagePurchasePrice: owned?.averagePurchasePrice ?? 0,
      unassigned: round(unassigned),
      ships,
      stored: storedRows,
    }
  }).filter((holding) => holding.total > 0).sort((left, right) => left.commodity.localeCompare(right.commodity))
}

export type CargoSource = { kind: 'ship'; shipId: string } | { kind: 'stored'; location: string }

export function removeHeldCargo(stored: LocationCargoState, hangar: HangarState, source: CargoSource, commodity: string, quantity: number): { stored?: LocationCargoState; hangar?: HangarState; error?: string } {
  const take = (cargo: Record<string, number>) => {
    const available = cargo[commodity] ?? 0
    if (!Number.isFinite(quantity) || quantity <= 0) return { error: 'Enter the quantity sold.' }
    if (quantity > available + 0.001) return { error: `Only ${available} SCU of ${commodity} is at that location.` }
    const next = { ...cargo }
    const remaining = round(available - quantity)
    if (remaining > 0) next[commodity] = remaining
    else delete next[commodity]
    return { next }
  }
  if (source.kind === 'ship') {
    const result = take(hangar.cargoByShip[source.shipId] ?? {})
    if (!result.next) return { error: result.error }
    return { stored, hangar: { ...hangar, cargoByShip: { ...hangar.cargoByShip, [source.shipId]: result.next } } }
  }
  const result = take(stored.byLocation[source.location] ?? {})
  if (!result.next) return { error: result.error }
  const byLocation = { ...stored.byLocation, [source.location]: result.next }
  if (!Object.keys(result.next).length) delete byLocation[source.location]
  return { stored: { byLocation }, hangar }
}

export function moveLocationCargoToShip(state: LocationCargoState, hangar: HangarState, location: string, commodity: string, quantity: number, shipId: string): { state?: LocationCargoState; hangar?: HangarState; error?: string } {
  const stored = state.byLocation[location]?.[commodity] ?? 0
  const ship = hangar.ships.find((item) => item.id === shipId)
  if (!ship) return { error: 'Choose a ship from your hangar.' }
  if (!Number.isFinite(quantity) || quantity <= 0) return { error: 'Enter an amount to move.' }
  if (quantity > stored + 0.001) return { error: `Only ${stored} SCU of ${commodity} is stored at ${location}.` }
  const shipCargo = hangar.cargoByShip[shipId] ?? {}
  const used = Object.values(shipCargo).reduce((sum, value) => sum + value, 0)
  if (ship.cargoCapacity > 0 && used + quantity > ship.cargoCapacity + 0.001) return { error: `Only ${round(Math.max(0, ship.cargoCapacity - used))} SCU of hold space remains on ${ship.name}.` }

  const locationCargo = { ...state.byLocation[location] }
  const remaining = round(stored - quantity)
  if (remaining > 0) locationCargo[commodity] = remaining
  else delete locationCargo[commodity]
  const byLocation = { ...state.byLocation, [location]: locationCargo }
  if (!Object.keys(locationCargo).length) delete byLocation[location]
  return {
    state: { byLocation },
    hangar: { ...hangar, cargoByShip: { ...hangar.cargoByShip, [shipId]: { ...shipCargo, [commodity]: round((shipCargo[commodity] ?? 0) + quantity) } } },
  }
}
