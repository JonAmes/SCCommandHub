export const releasesRepo = 'JonAmes/SCCommandHub'

export type LatestRelease = { version: string; url: string; name: string }

function parseVersion(value: string) {
  const match = value.trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/)
  return match ? match.slice(1, 4).map(Number) : null
}

export function isNewerVersion(candidate: string, current: string) {
  const next = parseVersion(candidate)
  const now = parseVersion(current)
  if (!next || !now) return false
  for (let index = 0; index < 3; index += 1) {
    if (next[index] !== now[index]) return next[index] > now[index]
  }
  return false
}

export async function fetchLatestRelease(fetcher: typeof fetch = fetch): Promise<LatestRelease | null> {
  const response = await fetcher(`https://api.github.com/repos/${releasesRepo}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } })
  if (!response.ok) return null
  const release: unknown = await response.json()
  if (!release || typeof release !== 'object') return null
  const { tag_name: tag, html_url: url, name } = release as { tag_name?: unknown; html_url?: unknown; name?: unknown }
  if (typeof tag !== 'string' || typeof url !== 'string' || !url.startsWith(`https://github.com/${releasesRepo}/releases/`)) return null
  return { version: tag.replace(/^v/i, ''), url, name: typeof name === 'string' && name ? name : tag }
}
