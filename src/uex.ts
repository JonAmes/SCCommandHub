const API_ROOT = 'https://api.uexcorp.uk/2.0'
const CACHE_MS = 60_000

export type UexRow = Record<string, unknown>

type Envelope<T> = {
  status?: string
  http_code?: number
  data?: T
  message?: string
}

type CacheEntry = {
  expiresAt: number
  data: unknown
}

const cache = new Map<string, CacheEntry>()
const pending = new Map<string, Promise<unknown>>()

export async function getUexData<T extends UexRow[]>(
  resource: string,
  token: string,
  parameters: Record<string, string | number> = {},
): Promise<T> {
  const queryParameters = new URLSearchParams()
  Object.entries(parameters).forEach(([name, value]) => queryParameters.set(name, String(value)))
  const query = queryParameters.toString()
  const key = `${resource}?${query}:${token}`
  const cached = cache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.data as T

  const inFlight = pending.get(key)
  if (inFlight) return inFlight as Promise<T>

  const request = fetch(`${API_ROOT}/${resource}/${query ? `?${query}` : ''}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
    .then(async (response) => {
      const body = (await response.json()) as Envelope<T>
      if (!response.ok || body.status !== 'ok' || !Array.isArray(body.data)) {
        throw new Error(body.message || `UEX returned HTTP ${response.status}`)
      }
      cache.set(key, { data: body.data, expiresAt: Date.now() + CACHE_MS })
      return body.data
    })
    .finally(() => pending.delete(key))

  pending.set(key, request)
  return request
}

export function clearUexCache() {
  cache.clear()
}

export function readText(row: UexRow, ...keys: string[]): string {
  for (const key of keys) {
    const value = row[key]
    if (typeof value === 'string' || typeof value === 'number') {
      return String(value)
    }
  }
  return ''
}

export function readNumber(row: UexRow, ...keys: string[]): number {
  for (const key of keys) {
    const value = Number(row[key])
    if (Number.isFinite(value)) return value
  }
  return 0
}