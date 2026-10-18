import { normalizedIdentity, type OcrReading } from './ocrReadings.ts'

export const scannerStorageKey = 'sc-command-hub.scanner-ops-v1'
export type ScannerObservation = { id: string; target: 'shipTarget' | 'contacts'; identity: string; values: Record<string, number>; recordedAt: string; location: string; source: 'ocr' | 'manual' }
export type ScannerState = { observations: ScannerObservation[] }
export function validScannerState(value: unknown): value is ScannerState {
  if (!value || typeof value !== 'object') return false
  const state = value as ScannerState
  return Array.isArray(state.observations) && state.observations.length <= 2000 && state.observations.every((entry) => entry && typeof entry.id === 'string' && entry.id.length > 0 && entry.id.length <= 100 && ['shipTarget', 'contacts'].includes(entry.target) && typeof entry.identity === 'string' && entry.identity.length > 0 && entry.identity.length <= 200 && typeof entry.location === 'string' && entry.location.length <= 500 && Number.isFinite(Date.parse(entry.recordedAt)) && ['ocr', 'manual'].includes(entry.source) && entry.values && typeof entry.values === 'object' && !Array.isArray(entry.values) && Object.entries(entry.values).length <= 30 && Object.entries(entry.values).every(([key, amount]) => key.length <= 100 && typeof amount === 'number' && Number.isFinite(amount) && amount >= 0))
}
export function loadScannerState(): ScannerState {
  try { const value: unknown = JSON.parse(window.localStorage.getItem(scannerStorageKey) ?? 'null'); return validScannerState(value) ? value : { observations: [] } } catch { return { observations: [] } }
}
export function saveScannerState(state: ScannerState) {
  try { window.localStorage.setItem(scannerStorageKey, JSON.stringify(state)); return true } catch { return false }
}
export function saveScannerObservation(state: ScannerState, reading: OcrReading, location: string, source: 'ocr' | 'manual' = 'ocr'): ScannerState {
  if (!['shipTarget', 'contacts'].includes(reading.target)) return state
  const identity = normalizedIdentity(reading.identity)
  if (!identity || identity.length > 200) return state
  const existing = state.observations.find((entry) => entry.target === reading.target && entry.identity === identity && entry.location === location.trim())
  if (existing && JSON.stringify(existing.values) === JSON.stringify(reading.values)) return state
  const entry: ScannerObservation = { id: crypto.randomUUID(), target: reading.target as 'shipTarget' | 'contacts', identity, values: { ...reading.values }, recordedAt: new Date().toISOString(), location: location.trim().slice(0, 500), source }
  return { observations: [entry, ...state.observations].slice(0, 2000) }
}