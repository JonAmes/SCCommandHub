const storageKey = 'sc-command-hub.route-plans-v1'

export type PlannedRouteStatus = 'planned' | 'purchased' | 'completed'

export type PlannedRoute = {
  id: string
  commodity: string
  buyTerminalId: string
  buyTerminalName: string
  sellTerminalId: string
  sellTerminalName: string
  quantity: number
  createdAt: string
  status: PlannedRouteStatus
  purchasedQuantity?: number
  buyShipId?: string | null
  buyLedgerEntryId?: string
  sellLedgerEntryId?: string
}

export type NewPlannedRoute = Omit<PlannedRoute, 'id' | 'createdAt' | 'status' | 'purchasedQuantity' | 'buyShipId' | 'buyLedgerEntryId' | 'sellLedgerEntryId'>

function isPlannedRoute(value: unknown): value is PlannedRoute {
  if (!value || typeof value !== 'object') return false
  const route = value as Partial<PlannedRoute>
  return typeof route.id === 'string'
    && typeof route.commodity === 'string'
    && typeof route.buyTerminalId === 'string'
    && typeof route.buyTerminalName === 'string'
    && typeof route.sellTerminalId === 'string'
    && typeof route.sellTerminalName === 'string'
    && Number.isFinite(route.quantity)
    && (route.quantity ?? 0) > 0
    && (route.status === undefined || route.status === 'planned' || route.status === 'purchased' || route.status === 'completed')
    && (route.purchasedQuantity === undefined || (Number.isFinite(route.purchasedQuantity) && route.purchasedQuantity > 0))
    && (route.buyShipId === undefined || route.buyShipId === null || typeof route.buyShipId === 'string')
    && (route.buyLedgerEntryId === undefined || typeof route.buyLedgerEntryId === 'string')
    && (route.sellLedgerEntryId === undefined || typeof route.sellLedgerEntryId === 'string')
    && typeof route.createdAt === 'string'
}

export function loadRoutePlans(): PlannedRoute[] {
  try {
    const stored = window.localStorage.getItem(storageKey)
    if (!stored) return []
    const parsed: unknown = JSON.parse(stored)
    return Array.isArray(parsed) ? parsed.filter(isPlannedRoute).map((route) => ({ ...route, status: route.status ?? 'planned' })) : []
  } catch {
    return []
  }
}

export function saveRoutePlans(routes: PlannedRoute[]) {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(routes))
    return true
  } catch {
    return false
  }
}

export function clearRoutePlans() {
  try {
    window.localStorage.removeItem(storageKey)
    return true
  } catch {
    return false
  }
}

export function createPlannedRoute(route: NewPlannedRoute): PlannedRoute {
  return {
    ...route,
    id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt: new Date().toISOString(),
    status: 'planned',
  }
}