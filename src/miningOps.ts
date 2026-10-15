const storageKey = 'sc-command-hub.mining-ops-v1'

export type RockComposition = { commodity: string; percent: number }

export type RockScan = {
  id: string
  label: string
  location: string
  massKg: number
  resistancePercent: number
  instabilityPercent: number
  composition: RockComposition[]
  scannedAt: string
}

export type MiningOpsState = { scans: RockScan[] }
export type NewRockScan = Omit<RockScan, 'id' | 'scannedAt'>

const emptyState = (): MiningOpsState => ({ scans: [] })

function createId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function isRockScan(value: unknown): value is RockScan {
  if (!value || typeof value !== 'object') return false
  const scan = value as Partial<RockScan>
  return typeof scan.id === 'string'
    && typeof scan.label === 'string'
    && typeof scan.location === 'string'
    && Number.isFinite(scan.massKg)
    && (scan.massKg ?? 0) > 0
    && Number.isFinite(scan.resistancePercent)
    && (scan.resistancePercent ?? -1) >= 0
    && (scan.resistancePercent ?? 101) <= 100
    && Number.isFinite(scan.instabilityPercent)
    && (scan.instabilityPercent ?? -1) >= 0
    && Array.isArray(scan.composition)
    && scan.composition.every((part) => typeof part.commodity === 'string' && part.commodity.length > 0 && Number.isFinite(part.percent) && part.percent > 0 && part.percent <= 100)
    && typeof scan.scannedAt === 'string'
}

export function loadMiningOpsState(): MiningOpsState {
  try {
    const stored = window.localStorage.getItem(storageKey)
    if (!stored) return emptyState()
    const parsed: unknown = JSON.parse(stored)
    if (!parsed || typeof parsed !== 'object') return emptyState()
    const value = parsed as Partial<MiningOpsState>
    return { scans: Array.isArray(value.scans) ? value.scans.filter(isRockScan) : [] }
  } catch {
    return emptyState()
  }
}

export function saveMiningOpsState(state: MiningOpsState) {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(state))
    return true
  } catch {
    return false
  }
}

export function addRockScan(state: MiningOpsState, scan: NewRockScan): { state?: MiningOpsState; error?: string } {
  const label = scan.label.trim()
  const location = scan.location.trim()
  if (!label) return { error: 'Enter a scan label.' }
  if (!location) return { error: 'Enter the scan location.' }
  if (!Number.isFinite(scan.massKg) || scan.massKg <= 0) return { error: 'Mass must be greater than zero.' }
  if (!Number.isFinite(scan.resistancePercent) || scan.resistancePercent < 0 || scan.resistancePercent > 100) return { error: 'Resistance must be between 0 and 100%.' }
  if (!Number.isFinite(scan.instabilityPercent) || scan.instabilityPercent < 0) return { error: 'Instability must be zero or greater.' }

  const composition = scan.composition
    .map((part) => ({ commodity: part.commodity.trim(), percent: part.percent }))
    .filter((part) => part.commodity && Number.isFinite(part.percent) && part.percent > 0)
  if (!composition.length) return { error: 'Add at least one mineral composition reading.' }
  const totalPercent = composition.reduce((sum, part) => sum + part.percent, 0)
  // Scanner percentages are rounded, so allow a small overshoot.
  if (totalPercent > 100.05) return { error: 'Mineral composition cannot exceed 100%.' }

  const entry: RockScan = {
    id: createId(),
    label,
    location,
    massKg: scan.massKg,
    resistancePercent: scan.resistancePercent,
    instabilityPercent: scan.instabilityPercent,
    composition,
    scannedAt: new Date().toISOString(),
  }
  return { state: { scans: [entry, ...state.scans] } }
}

export function removeRockScan(state: MiningOpsState, scanId: string): MiningOpsState {
  return { scans: state.scans.filter((scan) => scan.id !== scanId) }
}
