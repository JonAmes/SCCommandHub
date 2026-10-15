import type { HangarState } from './hangar'

const storageKey = 'sc-command-hub.refining-v1'
const maxDurationMinutes = 14 * 24 * 60

export type RefiningOre = { commodity: string; scu: number }

export type RefiningJob = {
  id: string
  refinery: string
  method: string
  shipId: string
  shipName: string
  ores: RefiningOre[]
  totalScu: number
  startedAt: string
  completesAt: string
  collectedAt?: string
  refined?: RefiningOre[]
}

export type RefiningState = { jobs: RefiningJob[] }
export type RefiningStatus = 'processing' | 'ready' | 'collected'
export type NewRefiningOrder = { refinery: string; method: string; durationMinutes: number }

const emptyState = (): RefiningState => ({ jobs: [] })

function createId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function isRefiningJob(value: unknown): value is RefiningJob {
  if (!value || typeof value !== 'object') return false
  const job = value as Partial<RefiningJob>
  return typeof job.id === 'string'
    && typeof job.refinery === 'string'
    && typeof job.method === 'string'
    && typeof job.shipId === 'string'
    && typeof job.shipName === 'string'
    && Array.isArray(job.ores)
    && job.ores.every((ore) => typeof ore?.commodity === 'string' && Number.isFinite(ore.scu) && ore.scu > 0)
    && Number.isFinite(job.totalScu)
    && typeof job.startedAt === 'string' && !Number.isNaN(Date.parse(job.startedAt))
    && typeof job.completesAt === 'string' && !Number.isNaN(Date.parse(job.completesAt))
    && (job.collectedAt === undefined || typeof job.collectedAt === 'string')
    && (job.refined === undefined || (Array.isArray(job.refined) && job.refined.every((item) => typeof item?.commodity === 'string' && Number.isFinite(item.scu))))
}

export function loadRefiningState(): RefiningState {
  try {
    const stored = window.localStorage.getItem(storageKey)
    if (!stored) return emptyState()
    const parsed: unknown = JSON.parse(stored)
    const jobs = parsed && typeof parsed === 'object' ? (parsed as Partial<RefiningState>).jobs : undefined
    return { jobs: Array.isArray(jobs) ? jobs.filter(isRefiningJob) : [] }
  } catch {
    return emptyState()
  }
}

export function saveRefiningState(state: RefiningState) {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(state))
    return true
  } catch {
    return false
  }
}

export function getShipOre(hangar: HangarState, shipId: string | null, minerals: string[]): RefiningOre[] {
  if (!shipId) return []
  const ore = new Set(minerals)
  return Object.entries(hangar.cargoByShip[shipId] ?? {})
    .filter(([commodity, scu]) => ore.has(commodity) && scu > 0)
    .map(([commodity, scu]) => ({ commodity, scu }))
    .sort((left, right) => right.scu - left.scu)
}

export function createRefiningOrder(state: RefiningState, hangar: HangarState, order: NewRefiningOrder, minerals: string[], now = new Date()): { state?: RefiningState; hangar?: HangarState; error?: string } {
  const ship = hangar.ships.find((item) => item.id === hangar.activeShipId)
  if (!ship) return { error: 'Select an active ship in Personal hangar first.' }
  const ores = getShipOre(hangar, ship.id, minerals)
  if (!ores.length) return { error: `${ship.name} has no raw ore in its hold.` }
  if (!order.refinery.trim()) return { error: 'Choose a refinery.' }
  if (!order.method.trim()) return { error: 'Choose a refining method.' }
  if (!Number.isFinite(order.durationMinutes) || order.durationMinutes <= 0 || order.durationMinutes > maxDurationMinutes) return { error: 'Enter the processing time shown at the refinery terminal.' }

  const job: RefiningJob = {
    id: createId(),
    refinery: order.refinery.trim(),
    method: order.method.trim(),
    shipId: ship.id,
    shipName: ship.name,
    ores,
    totalScu: Math.round(ores.reduce((sum, ore) => sum + ore.scu, 0) * 100) / 100,
    startedAt: now.toISOString(),
    completesAt: new Date(now.getTime() + Math.round(order.durationMinutes * 60_000)).toISOString(),
  }
  const cargo = { ...(hangar.cargoByShip[ship.id] ?? {}) }
  for (const ore of ores) delete cargo[ore.commodity]
  return {
    state: { jobs: [job, ...state.jobs] },
    hangar: { ...hangar, cargoByShip: { ...hangar.cargoByShip, [ship.id]: cargo } },
  }
}

export function getRefiningStatus(job: RefiningJob, now = Date.now()): RefiningStatus {
  if (job.collectedAt) return 'collected'
  return Date.parse(job.completesAt) <= now ? 'ready' : 'processing'
}

export function getRefiningProgress(job: RefiningJob, now = Date.now()) {
  const start = Date.parse(job.startedAt)
  const end = Date.parse(job.completesAt)
  return end <= start ? 1 : Math.min(1, Math.max(0, (now - start) / (end - start)))
}

export function collectRefiningJob(state: RefiningState, jobId: string, refined: RefiningOre[], now = new Date()): RefiningState {
  const output = refined.filter((item) => item.commodity.trim() && Number.isFinite(item.scu) && item.scu > 0)
  return { jobs: state.jobs.map((job) => job.id === jobId && getRefiningStatus(job, now.getTime()) === 'ready' ? { ...job, collectedAt: now.toISOString(), refined: output } : job) }
}

export function removeRefiningJob(state: RefiningState, jobId: string): RefiningState {
  return { jobs: state.jobs.filter((job) => job.id !== jobId) }
}

export function formatRemaining(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000))
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (days) return `${days}d ${hours}h ${minutes}m`
  if (hours) return `${hours}h ${minutes}m`
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}
