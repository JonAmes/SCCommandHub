import { readNumber, readText, type UexRow } from './uex'
import { getCommodityHoldings, type FinanceState } from './finance'
import { isContainerSizedQuantity } from './containerSizes'

const storageKey = 'sc-command-hub.hangar-v1'

export type HangarShip = {
  id: string
  vehicleId: string
  name: string
  manufacturer: string
  cargoCapacity: number
  photoUrl: string
  addedAt: string
  permanent?: boolean
  gameModelSlug?: string
}

export type HangarState = {
  ships: HangarShip[]
  activeShipId: string | null
  cargoByShip: Record<string, Record<string, number>>
}

const emptyState = (): HangarState => ({ ships: [], activeShipId: null, cargoByShip: {} })

function createId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function isHangarShip(value: unknown): value is HangarShip {
  if (!value || typeof value !== 'object') return false
  const ship = value as Partial<HangarShip>
  return typeof ship.id === 'string'
    && typeof ship.vehicleId === 'string'
    && typeof ship.name === 'string'
    && Number.isFinite(ship.cargoCapacity)
}

export function loadHangarState(): HangarState {
  try {
    const stored = window.localStorage.getItem(storageKey)
    if (!stored) return emptyState()
    const parsed: unknown = JSON.parse(stored)
    if (!parsed || typeof parsed !== 'object') return emptyState()
    const value = parsed as Partial<HangarState>
    const ships = Array.isArray(value.ships) ? value.ships.filter(isHangarShip) : []
    const cargoByShip = value.cargoByShip && typeof value.cargoByShip === 'object' ? value.cargoByShip : {}
    const validCargo = Object.fromEntries(ships.map((ship) => {
      const cargo = cargoByShip[ship.id]
      if (!cargo || typeof cargo !== 'object') return [ship.id, {}]
      const entries = Object.entries(cargo).filter((entry): entry is [string, number] => typeof entry[0] === 'string' && Number.isFinite(entry[1]) && entry[1] > 0)
      return [ship.id, Object.fromEntries(entries)]
    }))
    const requestedActiveId = typeof value.activeShipId === 'string' ? value.activeShipId : null
    return {
      ships,
      activeShipId: ships.some((ship) => ship.id === requestedActiveId) ? requestedActiveId : null,
      cargoByShip: validCargo,
    }
  } catch {
    return emptyState()
  }
}

export function saveHangarState(state: HangarState) {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(state))
    return true
  } catch {
    return false
  }
}

export function addShip(state: HangarState, vehicle: UexRow): { state?: HangarState; error?: string } {
  const vehicleId = readText(vehicle, 'id')
  const name = readText(vehicle, 'name')
  if (!vehicleId || !name) return { error: 'This vehicle is missing its UEX identifier or name.' }
  if (state.ships.some((ship) => ship.vehicleId === vehicleId)) return { error: `${name} is already in your hangar.` }

  const ship: HangarShip = {
    id: createId(),
    vehicleId,
    name,
    manufacturer: readText(vehicle, 'company_name'),
    cargoCapacity: Math.max(0, readNumber(vehicle, 'scu')),
    photoUrl: readText(vehicle, 'url_photo'),
    addedAt: new Date().toISOString(),
  }
  return {
    state: {
      ...state,
      ships: [...state.ships, ship],
      activeShipId: state.activeShipId ?? ship.id,
      cargoByShip: { ...state.cargoByShip, [ship.id]: {} },
    },
  }
}

export function addDetectedShip(state: HangarState, modelSlug: string, vehicle?: UexRow): { state?: HangarState; error?: string } {
  const vehicleId = vehicle ? readText(vehicle, 'id') : ''
  if (state.ships.some((ship) => ship.gameModelSlug === modelSlug || (vehicleId && ship.vehicleId === vehicleId))) {
    return { error: 'This ship is already in your hangar.' }
  }

  if (vehicleId && vehicle && readText(vehicle, 'name')) {
    const result = addShip(state, vehicle)
    if (!result.state) return result
    const added = result.state.ships[result.state.ships.length - 1]
    return {
      state: {
        ...result.state,
        ships: result.state.ships.map((ship) => ship.id === added.id ? { ...ship, gameModelSlug: modelSlug } : ship),
      },
    }
  }

  const [manufacturerCode, ...nameParts] = modelSlug.split('_')
  const name = nameParts.join(' ') || modelSlug
  const ship: HangarShip = {
    id: createId(),
    vehicleId: `game-log:${modelSlug}`,
    name,
    manufacturer: manufacturerCode,
    cargoCapacity: 0,
    photoUrl: '',
    addedAt: new Date().toISOString(),
    gameModelSlug: modelSlug,
  }
  return {
    state: {
      ...state,
      ships: [...state.ships, ship],
      activeShipId: state.activeShipId ?? ship.id,
      cargoByShip: { ...state.cargoByShip, [ship.id]: {} },
    },
  }
}

export function removeShip(state: HangarState, shipId: string): HangarState {
  const cargoByShip = { ...state.cargoByShip }
  delete cargoByShip[shipId]
  return {
    ships: state.ships.filter((ship) => ship.id !== shipId),
    activeShipId: state.activeShipId === shipId ? null : state.activeShipId,
    cargoByShip,
  }
}

export function setActiveShip(state: HangarState, shipId: string | null): HangarState {
  return { ...state, activeShipId: state.ships.some((ship) => ship.id === shipId) ? shipId : null }
}

export function getShipCargoQuantity(state: HangarState, shipId: string, commodity: string) {
  return Math.max(0, state.cargoByShip[shipId]?.[commodity] ?? 0)
}

export function getShipCargoUsed(state: HangarState, shipId: string) {
  return Object.values(state.cargoByShip[shipId] ?? {}).reduce((sum, quantity) => sum + quantity, 0)
}

export function getAssignedQuantity(state: HangarState, commodity: string) {
  return state.ships.reduce((sum, ship) => sum + getShipCargoQuantity(state, ship.id, commodity), 0)
}

export function getUnassignedQuantity(finance: FinanceState, hangar: HangarState, commodity: string) {
  const held = getCommodityHoldings(finance).find((item) => item.commodity === commodity)?.quantity ?? 0
  return Math.max(0, held - getAssignedQuantity(hangar, commodity))
}

export function loadCargo(finance: FinanceState, state: HangarState, shipId: string, commodity: string, requested: number): { state?: HangarState; error?: string } {
  if (!isContainerSizedQuantity(requested)) return { error: 'Cargo load must be a whole number of SCU containers.' }
  const ship = state.ships.find((item) => item.id === shipId)
  if (!ship) return { error: 'Choose a ship in your hangar.' }
  const available = getUnassignedQuantity(finance, state, commodity)
  if (requested > available) return { error: `Only ${available} SCU of ${commodity} is unassigned.` }
  const remainingCapacity = Math.max(0, ship.cargoCapacity - getShipCargoUsed(state, shipId))
  if (requested > remainingCapacity) return { error: `Only ${remainingCapacity} SCU of hold capacity remains on ${ship.name}.` }

  const currentCargo = state.cargoByShip[shipId] ?? {}
  return { state: { ...state, cargoByShip: { ...state.cargoByShip, [shipId]: { ...currentCargo, [commodity]: (currentCargo[commodity] ?? 0) + requested } } } }
}

export function unloadCargo(state: HangarState, shipId: string, commodity: string, quantity: number): { state?: HangarState; error?: string } {
  if (!isContainerSizedQuantity(quantity)) return { error: 'Cargo unload must be a whole number of SCU containers.' }
  const currentQuantity = getShipCargoQuantity(state, shipId, commodity)
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > currentQuantity) return { error: `Only ${currentQuantity} SCU of ${commodity} is loaded on this ship.` }
  const nextQuantity = Math.round((currentQuantity - quantity) * 100) / 100
  const currentCargo = { ...(state.cargoByShip[shipId] ?? {}) }
  if (nextQuantity > 0) currentCargo[commodity] = nextQuantity
  else delete currentCargo[commodity]
  return { state: { ...state, cargoByShip: { ...state.cargoByShip, [shipId]: currentCargo } } }
}

export function clearHangarCargo(state: HangarState): HangarState {
  return { ...state, cargoByShip: Object.fromEntries(state.ships.map((ship) => [ship.id, {}])) }
}