import type { OcrReading } from './ocrReadings.ts'

export const salvageStorageKey = 'sc-command-hub.salvaging-ops-v1'
export const salvageMaterials = ['Recycled Material Composite', 'Construction Materials'] as const
export type SalvageMoney = { id: string; kind: 'sale' | 'expense'; amount: number; note: string; ledgerId?: string; recordedAt: string }
export type SalvageEvent = { id: string; recordedAt: string; kind: 'observation' | 'reconciliation' | 'manual'; values: Record<string, number>; note: string }
export type SalvageSession = {
  id: string; shipId: string | null; shipName: string; target: string; location: string; startedAt: string; endedAt?: string
  current: Record<string, number>; collected: Record<string, number>; pending: string[]; events: SalvageEvent[]; money: SalvageMoney[]
}
export type SalvagingState = { sessions: SalvageSession[] }
export const emptySalvagingState = (): SalvagingState => ({ sessions: [] })
const rounded = (value: number) => Math.round(value * 10000) / 10000
const id = () => globalThis.crypto.randomUUID()
const numericRecord = (value: unknown): value is Record<string, number> => Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.entries(value).length <= 30 && Object.entries(value).every(([key, amount]) => key.length < 160 && typeof amount === 'number' && Number.isFinite(amount) && amount >= 0))
const shortText = (value: unknown): value is string => typeof value === 'string' && value.length <= 500

export function validSalvagingState(value: unknown): value is SalvagingState {
  if (!value || typeof value !== 'object') return false
  const state = value as SalvagingState
  return Array.isArray(state.sessions) && state.sessions.length <= 500 && new Set(state.sessions.map((session) => session?.id)).size === state.sessions.length && state.sessions.every((session) => session && shortText(session.id) && Boolean(session.id) && (session.shipId === null || shortText(session.shipId)) && shortText(session.shipName) && shortText(session.target) && shortText(session.location) && typeof session.startedAt === 'string' && Number.isFinite(Date.parse(session.startedAt)) && (session.endedAt === undefined || Number.isFinite(Date.parse(session.endedAt))) && numericRecord(session.current) && numericRecord(session.collected) && Array.isArray(session.pending) && session.pending.length <= 2 && session.pending.every((material) => salvageMaterials.includes(material as typeof salvageMaterials[number])) && Array.isArray(session.events) && session.events.length <= 1000 && session.events.every((event) => event && shortText(event.id) && typeof event.recordedAt === 'string' && Number.isFinite(Date.parse(event.recordedAt)) && ['observation', 'reconciliation', 'manual'].includes(event.kind) && numericRecord(event.values) && shortText(event.note)) && Array.isArray(session.money) && session.money.length <= 1000 && session.money.every((entry) => entry && shortText(entry.id) && ['sale', 'expense'].includes(entry.kind) && Number.isFinite(entry.amount) && entry.amount > 0 && shortText(entry.note) && (entry.ledgerId === undefined || shortText(entry.ledgerId)) && typeof entry.recordedAt === 'string' && Number.isFinite(Date.parse(entry.recordedAt))))
}

export function loadSalvagingState(): SalvagingState {
  try { const value: unknown = JSON.parse(window.localStorage.getItem(salvageStorageKey) ?? 'null'); return validSalvagingState(value) ? value : emptySalvagingState() } catch { return emptySalvagingState() }
}

export function saveSalvagingState(state: SalvagingState) {
  try { window.localStorage.setItem(salvageStorageKey, JSON.stringify(state)); return true } catch { return false }
}

export function startSalvageSession(state: SalvagingState, input: Pick<SalvageSession, 'shipId' | 'shipName' | 'target' | 'location'>): SalvagingState {
  if (state.sessions.some((session) => !session.endedAt) || state.sessions.length >= 500) return state
  const session: SalvageSession = { ...input, id: id(), startedAt: new Date().toISOString(), current: {}, collected: {}, pending: [], events: [], money: [] }
  return { sessions: [session, ...state.sessions] }
}

export function updateSalvageSession(state: SalvagingState, sessionId: string, update: (session: SalvageSession) => SalvageSession): SalvagingState {
  return { sessions: state.sessions.map((session) => session.id === sessionId ? update(session) : session) }
}

export function observeSalvage(session: SalvageSession, reading: OcrReading, manual = false): SalvageSession {
  if (session.endedAt || reading.target !== 'salvage' || !numericRecord(reading.values)) return session
  if (!Object.entries(reading.values).some(([key, amount]) => session.current[key] !== amount)) return session
  const current = { ...session.current, ...reading.values }
  for (const [key, amount] of Object.entries(current)) {
    if ((key.startsWith('buffer:') || key.startsWith('hold:')) && current[`capacity:${key}`] !== undefined && amount > current[`capacity:${key}`]) return session
  }
  const collected = { ...session.collected }
  const pending = new Set(session.pending)
  for (const material of salvageMaterials) {
    const buffer = `buffer:${material}`
    const hold = `hold:${material}`
    if (reading.values[buffer] === undefined && reading.values[hold] === undefined) continue
    const changed = [buffer, hold].filter((key) => reading.values[key] !== undefined && session.current[key] !== undefined)
    const dropped = changed.some((key) => reading.values[key] < session.current[key])
    const holdIncreased = changed.includes(hold) && reading.values[hold] > session.current[hold]
    const bufferFirstAppeared = session.current[buffer] === undefined && reading.values[buffer] !== undefined
    if (manual || dropped || holdIncreased && (session.current[buffer] !== undefined || bufferFirstAppeared)) pending.add(material)
    if (!pending.has(material)) {
      const increase = changed.reduce((sum, key) => sum + Math.max(0, reading.values[key] - session.current[key]), 0)
      collected[material] = rounded((collected[material] ?? 0) + increase)
    }
  }
  const event: SalvageEvent = { id: id(), recordedAt: new Date().toISOString(), kind: manual ? 'manual' : 'observation', values: { ...reading.values }, note: manual ? 'Manual correction; reconcile collection totals.' : 'Three matching OCR captures' }
  return { ...session, current, collected, pending: [...pending], events: [event, ...session.events].slice(0, 1000) }
}

export function reconcileSalvage(session: SalvageSession, material: string, additionalCollected: number, note: string): SalvageSession {
  if (session.endedAt || !salvageMaterials.includes(material as typeof salvageMaterials[number]) || !Number.isFinite(additionalCollected) || additionalCollected < 0 || !note.trim()) return session
  const event: SalvageEvent = { id: id(), recordedAt: new Date().toISOString(), kind: 'reconciliation', values: { [material]: additionalCollected }, note: note.trim().slice(0, 500) }
  return { ...session, pending: session.pending.filter((item) => item !== material), collected: { ...session.collected, [material]: rounded((session.collected[material] ?? 0) + additionalCollected) }, events: [event, ...session.events].slice(0, 1000) }
}

export function addSalvageMoney(session: SalvageSession, input: Omit<SalvageMoney, 'id' | 'recordedAt'>): SalvageSession {
  if (session.endedAt || !Number.isFinite(input.amount) || input.amount <= 0 || !input.note.trim() || session.money.length >= 1000 || input.ledgerId && session.money.some((entry) => entry.ledgerId === input.ledgerId)) return session
  return { ...session, money: [{ ...input, amount: rounded(input.amount), note: input.note.trim().slice(0, 500), id: id(), recordedAt: new Date().toISOString() }, ...session.money] }
}