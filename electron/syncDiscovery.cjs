const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { hostname } = require('node:os')
const { Bonjour } = require('bonjour-service')
const { findTailscaleCli, httpsPort, servePath } = require('./tailscaleServe.cjs')

const serviceType = 'sc-command-hub'
const execute = promisify(execFile)

function tailnetCandidates(status) {
  const seen = new Set()
  return [status?.Self, ...Object.values(status?.Peer ?? {})].flatMap((peer) => {
    if (!peer || peer.Online === false || typeof peer.DNSName !== 'string') return []
    const dnsName = peer.DNSName.replace(/\.$/, '').toLowerCase()
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net$/.test(dnsName)) return []
    const url = `https://${dnsName}:${httpsPort}${servePath}`
    if (seen.has(url)) return []
    seen.add(url)
    return [{ name: typeof peer.HostName === 'string' ? peer.HostName.slice(0, 80) : dnsName, url }]
  }).slice(0, 32)
}

async function readTailnetStatus() {
  const cli = findTailscaleCli()
  if (!cli) throw new Error('Tailscale is not installed. Enter the host URL instead.')
  const { stdout } = await execute(cli, ['status', '--json'], { encoding: 'utf8', timeout: 4000, maxBuffer: 4 * 1024 * 1024, windowsHide: true })
  const status = JSON.parse(stdout)
  if (status.BackendState && status.BackendState !== 'Running') throw new Error('Sign in to Tailscale, or enter the host URL instead.')
  return status
}

async function probeHost(candidate, request = fetch) {
  try {
    const response = await request(`${candidate.url}/discover`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', redirect: 'error', signal: AbortSignal.timeout(1200) })
    if (!response.ok || Number(response.headers.get('content-length') || 0) > 4096) return false
    const reader = response.body?.getReader()
    if (!reader) return false
    const chunks = []
    let size = 0
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > 4096) { await reader.cancel(); return false }
      chunks.push(value)
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return data?.service === serviceType && data.protocolVersion === 1
  } catch { return false }
}

async function discoverTailscaleHosts({ getStatus = readTailnetStatus, probe = probeHost } = {}) {
  try {
    const queue = tailnetCandidates(await getStatus())
    const hosts = []
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length) {
        const candidate = queue.shift()
        try { if (await probe(candidate)) hosts.push(candidate) } catch {}
      }
    }))
    hosts.sort((left, right) => left.name.localeCompare(right.name))
    return { hosts, message: hosts.length ? '' : 'No active hosts found. Check that the host and Tailscale are running, or enter its URL.' }
  } catch {
    return { hosts: [], message: 'Host detection could not access Tailscale. Enter the host URL instead.' }
  }
}

function createHostAdvertisement({ createBonjour = (onError) => new Bonjour(undefined, onError), name = hostname() } = {}) {
  let instance
  let service
  function stop() {
    try { service?.stop() } catch {}
    try { instance?.destroy() } catch {}
    service = undefined
    instance = undefined
  }
  function start(url) {
    stop()
    try {
      instance = createBonjour(() => {})
      service = instance.publish({ name: `SC Command Hub (${name})`.slice(0, 63), type: serviceType, protocol: 'tcp', port: httpsPort, txt: { url, version: '1' } })
      service.on('error', () => {})
      return true
    } catch {
      stop()
      return false
    }
  }
  return { start, stop }
}

module.exports = { tailnetCandidates, discoverTailscaleHosts, createHostAdvertisement, probeHost }