import { useEffect, useState } from 'react'
import { fetchLatestRelease, isNewerVersion, type LatestRelease } from './updateCheck'

const checkIntervalMs = 6 * 60 * 60 * 1000

export function UpdateStatus({ currentVersion }: { currentVersion: string }) {
  const [release, setRelease] = useState<LatestRelease | null>(null)
  const [dismissedVersion, setDismissedVersion] = useState('')

  useEffect(() => {
    let active = true
    const check = () => {
      fetchLatestRelease().then((latest) => {
        if (active && latest && isNewerVersion(latest.version, currentVersion)) setRelease(latest)
      }).catch(() => undefined)
    }
    check()
    const timer = window.setInterval(check, checkIntervalMs)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [currentVersion])

  if (!release || dismissedVersion === release.version) return null
  return <div className="update-status" role="status">
    <span className="status-dot is-live" />
    <a href={release.url} target="_blank" rel="noopener noreferrer">Update available · v{release.version}</a>
    <button type="button" aria-label="Dismiss update notice" onClick={() => setDismissedVersion(release.version)}>×</button>
  </div>
}
