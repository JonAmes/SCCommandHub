const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const servePath = '/sc-command-hub-sync'
const httpsPort = 8443

function findTailscaleCli() {
  const candidates = process.platform === 'win32'
    ? [path.join(process.env.ProgramFiles || '', 'Tailscale', 'tailscale.exe'), path.join(process.env['ProgramFiles(x86)'] || '', 'Tailscale', 'tailscale.exe')]
    : ['/usr/bin/tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  try {
    const resolver = process.platform === 'win32' ? 'where.exe' : 'which'
    const located = execFileSync(resolver, ['tailscale'], { encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    const firstPath = located.split(/\r?\n/).map((item) => item.trim()).find(Boolean)
    if (firstPath) return firstPath
  } catch {}
  return null
}

function runTailscale(cli, args) {
  return execFileSync(cli, args, { encoding: 'utf8', timeout: 15000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function createTailscaleServe({ findCli = findTailscaleCli, run = runTailscale } = {}) {
  let activeCli
  let activeUrl

  function start(localPort) {
    const cli = findCli()
    if (!cli) return { status: 'tailscale-cli-not-found' }

    try {
      run(cli, ['serve', '--bg', '--yes', `--https=${httpsPort}`, `--set-path=${servePath}`, `http://127.0.0.1:${localPort}`])
      activeCli = cli
      const status = JSON.parse(run(cli, ['status', '--json']))
      const dnsName = typeof status.Self?.DNSName === 'string' ? status.Self.DNSName.replace(/\.$/, '') : ''
      if (!dnsName) {
        stop()
        return { status: 'tailscale-dns-unavailable' }
      }
      activeUrl = `https://${dnsName}:${httpsPort}${servePath}`
      return { status: 'ready', url: activeUrl, path: servePath, httpsPort }
    } catch (error) {
      stop()
      const detail = [error.stderr, error.message].filter(Boolean).join(' ').slice(0, 400)
      return { status: 'serve-error', detail }
    }
  }

  function stop() {
    if (!activeCli) return true
    try {
      run(activeCli, ['serve', '--https=' + httpsPort, `--set-path=${servePath}`, 'off', '--yes'])
    } catch {}
    activeCli = undefined
    activeUrl = undefined
    return true
  }

  return { start, stop, getUrl: () => activeUrl }
}

module.exports = { createTailscaleServe, findTailscaleCli, httpsPort, servePath }
