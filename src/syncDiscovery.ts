import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { normalizePrimaryUrl } from './syncClient.ts'

export type DiscoveredSyncHost = { name: string; url: string }
export type SyncDiscoveryResult = { hosts: DiscoveredSyncHost[]; message: string }
type ServiceEvent = { action: string; service?: { name?: string; txtRecord?: Record<string, string> } }
export type NativeHostDiscovery = {
  watch: (type: string, domain: string, success: (event: ServiceEvent) => void, failure: () => void) => void
  unwatch: (type: string, domain: string, success: () => void, failure: () => void) => void
}

export function validatedDiscoveredHosts(value: unknown): DiscoveredSyncHost[] {
  if (!Array.isArray(value)) return []
  const hosts = new Map<string, DiscoveredSyncHost>()
  for (const entry of value.slice(0, 32)) {
    if (!entry || typeof entry !== 'object' || typeof entry.url !== 'string' || entry.url.length > 300) continue
    try {
      const url = normalizePrimaryUrl(entry.url)
      hosts.set(url, { name: typeof entry.name === 'string' ? entry.name.slice(0, 80) : new URL(url).hostname, url })
    } catch {}
  }
  return [...hosts.values()].sort((left, right) => left.name.localeCompare(right.name))
}

async function verifyNativeHost(host: DiscoveredSyncHost) {
  try {
    const response = await CapacitorHttp.post({ url: `${host.url}/discover`, data: {}, headers: { 'Content-Type': 'application/json' }, connectTimeout: 1500, readTimeout: 1500, disableRedirects: true })
    const data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data
    return response.status === 200 && data?.service === 'sc-command-hub' && data.protocolVersion === 1
  } catch { return false }
}

export async function discoverNativeSyncHosts(plugin: NativeHostDiscovery, signal: AbortSignal, { scanMs = 4000, verify = verifyNativeHost } = {}): Promise<SyncDiscoveryResult> {
  const type = '_sc-command-hub._tcp.'
  const found = new Map<string, DiscoveredSyncHost>()
  let failed = false
  await new Promise<void>((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      try { plugin.unwatch(type, 'local.', () => {}, () => {}) } catch {}
      resolve()
    }
    const timer = setTimeout(finish, scanMs)
    signal.addEventListener('abort', finish, { once: true })
    if (signal.aborted) { finish(); return }
    try {
      plugin.watch(type, 'local.', (event) => {
        if (done || event.service?.txtRecord?.version !== '1') return
        const [host] = validatedDiscoveredHosts([{ name: event.service.name, url: event.service.txtRecord.url }])
        if (!host) return
        if (event.action === 'removed') found.delete(host.url)
        else if (event.action === 'resolved' && found.size < 16) found.set(host.url, host)
      }, () => { failed = true; finish() })
    } catch { failed = true; finish() }
  })
  const queue = [...found.values()]
  const hosts: DiscoveredSyncHost[] = []
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length && !signal.aborted) {
      const host = queue.shift()!
      try { if (await verify(host) && !signal.aborted) hosts.push(host) } catch {}
    }
  }))
  signal.throwIfAborted()
  return { hosts: validatedDiscoveredHosts(hosts), message: hosts.length ? '' : failed ? 'Local-network discovery is unavailable or permission was denied. Enter the host URL instead.' : 'No reachable hosts found on this network. Enter the URL for a remote host or check local-network permissions.' }
}

export async function discoverSyncHosts(signal: AbortSignal): Promise<SyncDiscoveryResult> {
  if (window.starCitizenBridge?.discoverSyncHosts) {
    const result = await window.starCitizenBridge.discoverSyncHosts()
    signal.throwIfAborted()
    const hosts = validatedDiscoveredHosts(result.hosts)
    return { hosts, message: hosts.length ? '' : result.message || 'No hosts found. Enter the host URL instead.' }
  }
  if (Capacitor.isNativePlatform()) {
    const plugin = (window as Window & { cordova?: { plugins?: { zeroconf?: NativeHostDiscovery } } }).cordova?.plugins?.zeroconf
    if (plugin) return discoverNativeSyncHosts(plugin, signal)
    return { hosts: [], message: 'Host discovery is not available in this mobile build. Enter the URL or rebuild with the discovery plugin.' }
  }
  return { hosts: [], message: 'Automatic host discovery is available in the desktop and mobile apps. Enter the host URL in this browser.' }
}