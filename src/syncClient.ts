import { Capacitor, CapacitorHttp } from '@capacitor/core'
import type { SyncSnapshot } from './appSync'

const pairingStorageKey = 'sc-command-hub.sync-client-v1'
let activePairing: SyncClientPairing | null = null

export type SyncClientPairing = {
  primaryUrl: string
  clientId: string
  clientToken: string
  expiresAt: string
}

function normalizePrimaryUrl(value: string) {
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error('Enter the host Tailscale HTTPS URL.') }
  if (url.protocol !== 'https:' || !url.hostname.toLocaleLowerCase().endsWith('.ts.net')) throw new Error('Use the host HTTPS MagicDNS address ending in .ts.net.')
  if (url.username || url.password || url.search || url.hash) throw new Error('The host URL must not contain credentials, query, or fragment data.')
  const pathname = url.pathname.replace(/\/$/, '')
  if (pathname !== '/sc-command-hub-sync') throw new Error('The URL must end in /sc-command-hub-sync.')
  return `${url.origin}${pathname}`
}

function readPairing(): SyncClientPairing | null {
  if (!activePairing) {
    try {
      const value: unknown = JSON.parse(window.localStorage.getItem(pairingStorageKey) || 'null')
      if (!value || typeof value !== 'object') return null
      const pairing = value as Partial<SyncClientPairing>
      if (typeof pairing.primaryUrl !== 'string' || typeof pairing.clientId !== 'string' || typeof pairing.clientToken !== 'string' || typeof pairing.expiresAt !== 'string') return null
      if (normalizePrimaryUrl(pairing.primaryUrl) !== pairing.primaryUrl) return null
      activePairing = pairing as SyncClientPairing
    } catch {
      return null
    }
  }
  if (Date.parse(activePairing.expiresAt) <= Date.now()) {
    try { window.localStorage.removeItem(pairingStorageKey) } catch {}
    activePairing = null
    return null
  }
  return activePairing
}

function savePairing(pairing: SyncClientPairing) {
  try {
    window.localStorage.setItem(pairingStorageKey, JSON.stringify(pairing))
    activePairing = pairing
    return true
  } catch {
    activePairing = null
    return false
  }
}

async function sendJson(url: string, data: unknown, token?: string) {
  const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  const desktopRequest = window.starCitizenBridge?.requestSync
  if (desktopRequest) {
    const response = await desktopRequest(url, data, token)
    if (response.status < 200 || response.status >= 300) {
      const message = response.data && typeof response.data === 'object' && 'error' in response.data ? String(response.data.error) : `Sync request failed (${response.status}).`
      throw new Error(message)
    }
    return response.data
  }
  if (Capacitor.isNativePlatform()) {
    const response = await CapacitorHttp.post({ url, data, headers })
    if (response.status < 200 || response.status >= 300) throw new Error(response.data?.error || `Sync request failed (${response.status}).`)
    return response.data
  }
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(data) })
  const result: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message = result && typeof result === 'object' && 'error' in result ? String(result.error) : `Sync request failed (${response.status}).`
    throw new Error(message)
  }
  return result
}

export async function pairSyncClient(primaryUrl: string, code: string, clientName: string): Promise<SyncClientPairing> {
  const baseUrl = normalizePrimaryUrl(primaryUrl)
  if (!/^\d{6}$/.test(code.trim())) throw new Error('Enter the 6-digit pairing code shown by the host.')

    const pairingRequest = await sendJson(`${baseUrl}/pair`, { code: code.trim(), clientName: clientName.trim() || 'SC Command Hub client' }) as { status?: string; requestId?: string; expiresAt?: string }
    if (pairingRequest.status !== 'pending-approval' || typeof pairingRequest.requestId !== 'string' || typeof pairingRequest.expiresAt !== 'string') {
      throw new Error('The host returned an invalid pairing response.')
    }

    let result: Partial<SyncClientPairing> | null = null
    while (Date.now() < Date.parse(pairingRequest.expiresAt)) {
      const status = await sendJson(`${baseUrl}/pair-status`, { requestId: pairingRequest.requestId }) as { status?: string } & Partial<SyncClientPairing>
      if (status.status === 'approved') {
        result = status
        break
      }
      if (status.status === 'rejected') throw new Error('The host rejected this pairing request.')
      await new Promise((resolve) => window.setTimeout(resolve, 1000))
    }
    if (!result) throw new Error('Host approval timed out. Ask it to generate a new pairing code.')
    if (typeof result.clientId !== 'string' || typeof result.clientToken !== 'string' || typeof result.expiresAt !== 'string') {
      throw new Error('The host returned an invalid pairing approval.')
    }
  const pairing: SyncClientPairing = { primaryUrl: baseUrl, clientId: result.clientId, clientToken: result.clientToken, expiresAt: result.expiresAt }
  if (!savePairing(pairing)) throw new Error('Paired, but this device could not save its local sync credentials.')
  return pairing
}

export async function uploadSyncSnapshot(snapshot: SyncSnapshot, pairing = readPairing()) {
  if (!pairing) throw new Error('Pair this device with a host first.')
  if (Date.parse(pairing.expiresAt) <= Date.now()) {
    activePairing = null
    try { window.localStorage.removeItem(pairingStorageKey) } catch {}
    throw new Error('Pairing expired. Pair with the host again.')
  }
  try {
    return await sendJson(`${pairing.primaryUrl}/sync`, { snapshot }, pairing.clientToken)
  } catch (error) {
    if (error instanceof Error && error.message.includes('client-not-paired')) {
      activePairing = null
      try { window.localStorage.removeItem(pairingStorageKey) } catch {}
    }
    throw error
  }
}

export type HostSnapshotPull = { version: string; pendingReview: boolean; snapshot?: SyncSnapshot }

// Pass the last applied version to skip re-downloading unchanged host data.
export async function pullHostSnapshot(since: string | null, pairing = readPairing()): Promise<HostSnapshotPull> {
  if (!pairing) throw new Error('Pair this device with a host first.')
  const result = await sendJson(`${pairing.primaryUrl}/pull`, { since }, pairing.clientToken) as Partial<HostSnapshotPull> | null
  if (!result || typeof result.version !== 'string') throw new Error('The host returned an invalid sync response.')
  return { version: result.version, pendingReview: result.pendingReview === true, ...(result.snapshot ? { snapshot: result.snapshot } : {}) }
}

export type HostGameStatus = { gameLogActive: boolean; locationCode: string | null; recordedAt: string | null }

export async function fetchHostGameStatus(pairing = readPairing()): Promise<HostGameStatus | null> {
  if (!pairing) return null
  const status = await sendJson(`${pairing.primaryUrl}/status`, {}, pairing.clientToken) as Partial<HostGameStatus> | null
  if (!status || typeof status !== 'object') return null
  return {
    gameLogActive: status.gameLogActive === true,
    locationCode: typeof status.locationCode === 'string' ? status.locationCode.slice(0, 80) : null,
    recordedAt: typeof status.recordedAt === 'string' ? status.recordedAt : null,
  }
}

export async function disconnectSyncClient(pairing = readPairing()) {
  if (pairing) {
    try { await sendJson(`${pairing.primaryUrl}/disconnect`, {}, pairing.clientToken) } catch {}
  }
  try { window.localStorage.removeItem(pairingStorageKey) } catch {}
  activePairing = null
}

export function getSyncClientPairing() {
  return readPairing()
}
