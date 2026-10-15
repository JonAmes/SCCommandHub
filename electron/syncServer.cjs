const crypto = require('node:crypto')
const http = require('node:http')

const DEFAULT_PORT = 47832
const PAIRING_CODE_TTL_MS = 2 * 60 * 1000
const CLIENT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000
const MAX_BODY_BYTES = 64 * 1024 * 1024
const MAX_PENDING_PAIRINGS = 20
const MAX_PAIRED_CLIENTS = 100
const ALLOWED_BROWSER_ORIGINS = new Set([
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://127.0.0.1:5174',
  'http://localhost:5174',
  'https://localhost',
  'capacitor://localhost',
])

function isAllowedBrowserOrigin(origin) {
  if (ALLOWED_BROWSER_ORIGINS.has(origin)) return true
  try {
    const url = new URL(origin)
    return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
  } catch {
    return false
  }
}

function sendJson(response, status, value) {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(value))
}

function isSnapshotEnvelopeValid(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || snapshot.schemaVersion !== 1 || typeof snapshot.exportedAt !== 'string') return false
  if (!Number.isFinite(Date.parse(snapshot.exportedAt))) return false
  const data = snapshot.data
  if (!data || typeof data !== 'object') return false
  const arrayPaths = [
    data.finance?.accounts, data.finance?.transactions, data.hangar?.ships, data.crew?.members,
    data.crew?.roles, data.routes, data.miningOps?.scans, data.gameLog?.pendingTransactions,
    data.gameLog?.processedEventIds, data.marketPriceHistory,
  ]
  if (!arrayPaths.every(Array.isArray)) return false
  const arrays = arrayPaths.map((array) => array.length)
  const limits = [500, 10000, 1000, 1000, 500, 2000, 5000, 2000, 20000, 300]
  if (arrays.some((length, index) => length > limits[index])) return false
  if (data.marketPriceHistory.some((item) => !item || !Number.isFinite(item.capturedAt) || !Array.isArray(item.prices) || item.prices.length > 1000)) return false
  if (!data.hangar?.cargoByShip || typeof data.hangar.cargoByShip !== 'object') return false
  if (data.systemIndexSnapshot !== null && (!data.systemIndexSnapshot || !Array.isArray(data.systemIndexSnapshot.locationKeys) || !Array.isArray(data.systemIndexSnapshot.newLocationKeys) || data.systemIndexSnapshot.locationKeys.length > 20000 || data.systemIndexSnapshot.newLocationKeys.length > 20000)) return false
  if (!data.preferences || typeof data.preferences !== 'object' || !['field', 'amber', 'ice', 'night', 'redshift'].includes(data.preferences.theme) || (data.preferences.gameChannel !== 'LIVE' && data.preferences.gameChannel !== 'PTU') || ![null, 'personal', 'organization'].includes(data.preferences.workspaceMode)) return false
  return true
}

function createSyncHost({ onProposal = () => {}, onPairRequest = () => {}, onStatus = () => {}, port = DEFAULT_PORT } = {}) {
  let server
  let address
  let listeningPort = port
  let pairingCode
  let pairingCodeExpiresAt = 0
  const pairedClients = new Map()
  const pendingPairings = new Map()
  const pairingResults = new Map()
  let failedPairingAttempts = 0
  let failedPairingWindowStart = Date.now()
  const lastUploadAt = new Map()
  const lastStatusAt = new Map()
  const lastPullAt = new Map()
  const clientsAwaitingReview = new Set()
  let hostSnapshot = null
  let hostSnapshotVersion = null
  let gameStatus = { gameLogActive: false, locationCode: null, recordedAt: null }

  function pruneExpiredPairingState() {
    const now = Date.now()
    for (const [requestId, pending] of pendingPairings) {
      if (pending.expiresAt <= now) pendingPairings.delete(requestId)
    }
    for (const [requestId, result] of pairingResults) {
      if (result.expiresAt <= now) pairingResults.delete(requestId)
    }
    for (const [token, client] of pairedClients) {
      if (client.expiresAt <= now) pairedClients.delete(token)
    }
  }

  function rotatePairingCode() {
    pairingCode = String(crypto.randomInt(0, 1000000)).padStart(6, '0')
    pairingCodeExpiresAt = Date.now() + PAIRING_CODE_TTL_MS
    return { code: pairingCode, expiresAt: new Date(pairingCodeExpiresAt).toISOString() }
  }

  function isLoopbackRequest(request) {
    const address = (request.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
    return address === '127.0.0.1' || address === '::1'
  }

  function setHeaders(request, response) {
    const origin = request.headers.origin
    if (origin && isAllowedBrowserOrigin(origin)) {
      response.setHeader('Access-Control-Allow-Origin', origin)
      response.setHeader('Vary', 'Origin')
    }
    response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
    response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    response.setHeader('Access-Control-Allow-Private-Network', 'true')
    response.setHeader('Cache-Control', 'no-store')
  }

  function readJson(request) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      let tooLarge = false
      request.on('data', (chunk) => {
        if (tooLarge) return
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          tooLarge = true
          chunks.length = 0
          return
        }
        chunks.push(chunk)
      })
      request.on('end', () => {
        if (tooLarge) {
          reject(new Error('payload-too-large'))
          return
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch {
          reject(new Error('invalid-json'))
        }
      })
      request.on('error', reject)
    })
  }

  async function handleRequest(request, response) {
    pruneExpiredPairingState()
    setHeaders(request, response)
    if (request.method === 'OPTIONS') {
      if (request.headers.origin && !isAllowedBrowserOrigin(request.headers.origin)) {
        response.statusCode = 403
        response.end()
        return
      }
      response.statusCode = 204
      response.end()
      return
    }
    if (request.headers.origin && !isAllowedBrowserOrigin(request.headers.origin)) {
      sendJson(response, 403, { error: 'origin-not-allowed' })
      return
    }
    if (!isLoopbackRequest(request)) {
      sendJson(response, 403, { error: 'loopback-only' })
      return
    }
    const route = (request.url ?? '/').split('?')[0].replace(/^\/sc-command-hub-sync(?=\/|$)/, '') || '/'
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'method-not-allowed' })
      return
    }

    if (route === '/pair') {
      if (pendingPairings.size >= MAX_PENDING_PAIRINGS) {
        sendJson(response, 429, { error: 'too-many-pending-pairings' })
        return
      }
      if (Date.now() - failedPairingWindowStart >= 60000) {
        failedPairingAttempts = 0
        failedPairingWindowStart = Date.now()
      }
      if (failedPairingAttempts >= 8) {
        sendJson(response, 429, { error: 'pairing-rate-limited' })
        return
      }

      let body
      try { body = await readJson(request) } catch (error) {
        sendJson(response, error.message === 'payload-too-large' ? 413 : 400, { error: error.message })
        return
      }
      const submittedCode = typeof body?.code === 'string' ? body.code : ''
      const validCode = pairingCode && Date.now() < pairingCodeExpiresAt && submittedCode.length === pairingCode.length
        && crypto.timingSafeEqual(Buffer.from(submittedCode), Buffer.from(pairingCode))
      if (!validCode) {
        failedPairingAttempts += 1
        sendJson(response, 401, { error: 'invalid-or-expired-code' })
        return
      }

      pairingCode = undefined
      if (pairedClients.size >= MAX_PAIRED_CLIENTS) {
        sendJson(response, 429, { error: 'too-many-paired-clients' })
        return
      }
      const requestId = crypto.randomBytes(24).toString('base64url')
      const clientToken = crypto.randomBytes(32).toString('base64url')
      const expiresAt = Date.now() + PAIRING_CODE_TTL_MS
      const requestInfo = {
        requestId,
        clientToken,
        clientId: crypto.randomUUID(),
        clientName: typeof body.clientName === 'string' ? body.clientName.slice(0, 80) : 'SC Command Hub client',
        sourceAddress: 'Tailscale Serve client',
        expiresAt,
      }
      pendingPairings.set(requestId, requestInfo)
      onPairRequest({ requestId, clientName: requestInfo.clientName, sourceAddress: requestInfo.sourceAddress, expiresAt: new Date(expiresAt).toISOString() })
      failedPairingAttempts = 0
      sendJson(response, 202, { status: 'pending-approval', requestId, expiresAt: new Date(expiresAt).toISOString() })
      return
    }

    if (route === '/pair-status') {
      let body
      try { body = await readJson(request) } catch (error) {
        sendJson(response, error.message === 'payload-too-large' ? 413 : 400, { error: error.message })
        return
      }
      const requestId = typeof body?.requestId === 'string' ? body.requestId : ''
      const result = pairingResults.get(requestId)
      if (result && result.expiresAt > Date.now()) {
        sendJson(response, 200, result.response)
        return
      }
      pairingResults.delete(requestId)
      const pending = pendingPairings.get(requestId)
      if (pending && pending.expiresAt > Date.now()) {
        sendJson(response, 200, { status: 'pending-approval' })
        return
      }
      pendingPairings.delete(requestId)
      sendJson(response, 410, { error: 'pairing-expired-or-rejected' })
      return
    }

    if (route === '/disconnect') {
      const authorization = request.headers.authorization ?? ''
      const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
      const pairedClient = pairedClients.get(token)
      if (!pairedClient || pairedClient.expiresAt <= Date.now()) {
        pairedClients.delete(token)
        sendJson(response, 401, { error: 'client-not-paired' })
        return
      }
      pairedClients.delete(token)
      clientsAwaitingReview.delete(pairedClient.clientId)
      for (const [clientToken, client] of pairedClients) {
        if (client.clientId === pairedClient.clientId) pairedClients.delete(clientToken)
      }
      sendJson(response, 200, { disconnected: true })
      return
    }

    if (route === '/status') {
      const authorization = request.headers.authorization ?? ''
      const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
      const pairedClient = pairedClients.get(token)
      if (!pairedClient || pairedClient.expiresAt <= Date.now()) {
        pairedClients.delete(token)
        sendJson(response, 401, { error: 'client-not-paired' })
        return
      }
      if (Date.now() - (lastStatusAt.get(pairedClient.clientId) ?? 0) < 1000) {
        sendJson(response, 429, { error: 'status-rate-limited' })
        return
      }
      lastStatusAt.set(pairedClient.clientId, Date.now())
      sendJson(response, 200, gameStatus)
      return
    }

    if (route === '/pull') {
      const authorization = request.headers.authorization ?? ''
      const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
      const pairedClient = pairedClients.get(token)
      if (!pairedClient || pairedClient.expiresAt <= Date.now()) {
        pairedClients.delete(token)
        sendJson(response, 401, { error: 'client-not-paired' })
        return
      }
      if (Date.now() - (lastPullAt.get(pairedClient.clientId) ?? 0) < 1000) {
        sendJson(response, 429, { error: 'pull-rate-limited' })
        return
      }
      lastPullAt.set(pairedClient.clientId, Date.now())
      let body
      try { body = await readJson(request) } catch (error) {
        sendJson(response, error.message === 'payload-too-large' ? 413 : 400, { error: error.message })
        return
      }
      if (!hostSnapshot) {
        sendJson(response, 503, { error: 'host-data-unavailable' })
        return
      }
      const pendingReview = clientsAwaitingReview.has(pairedClient.clientId)
      const upToDate = typeof body?.since === 'string' && body.since === hostSnapshotVersion
      sendJson(response, 200, { version: hostSnapshotVersion, pendingReview, ...(upToDate ? {} : { snapshot: hostSnapshot }) })
      return
    }

    if (route === '/sync') {
      const authorization = request.headers.authorization ?? ''
      const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
      const pairedClient = pairedClients.get(token)
      if (!pairedClient || pairedClient.expiresAt <= Date.now()) {
        pairedClients.delete(token)
        sendJson(response, 401, { error: 'client-not-paired' })
        return
      }
      const lastUpload = lastUploadAt.get(pairedClient.clientId) ?? 0
      if (Date.now() - lastUpload < 1500) {
        sendJson(response, 429, { error: 'upload-rate-limited' })
        return
      }

      let body
      try { body = await readJson(request) } catch (error) {
        sendJson(response, error.message === 'payload-too-large' ? 413 : 400, { error: error.message })
        return
      }
      if (!isSnapshotEnvelopeValid(body?.snapshot)) {
        sendJson(response, 400, { error: 'invalid-snapshot' })
        return
      }

      lastUploadAt.set(pairedClient.clientId, Date.now())
      clientsAwaitingReview.add(pairedClient.clientId)
      onProposal({
        id: crypto.randomUUID(),
        clientId: pairedClient.clientId,
        clientName: pairedClient.clientName,
        receivedAt: new Date().toISOString(),
        snapshot: body.snapshot,
      })
      sendJson(response, 202, { accepted: true })
      return
    }

    sendJson(response, 404, { error: 'not-found' })
  }

  async function start() {
    if (server) return { status: 'listening', address: '127.0.0.1', port: listeningPort, ...rotatePairingCode() }
    address = '127.0.0.1'
    rotatePairingCode()
    server = http.createServer((request, response) => { void handleRequest(request, response) })
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, address, () => {
          server.removeListener('error', reject)
          listeningPort = server.address().port
          resolve()
        })
      })
    } catch (error) {
      server = undefined
      pairingCode = undefined
      return { status: error.code === 'EADDRINUSE' ? 'port-in-use' : 'start-error' }
    }
    onStatus({ status: 'listening', address, port })
    return { status: 'listening', address, port: listeningPort, code: pairingCode, expiresAt: new Date(pairingCodeExpiresAt).toISOString() }
  }

  function stop() {
    pairingCode = undefined
    pairingCodeExpiresAt = 0
    pairedClients.clear()
    pendingPairings.clear()
    pairingResults.clear()
    lastUploadAt.clear()
    lastStatusAt.clear()
    lastPullAt.clear()
    clientsAwaitingReview.clear()
    hostSnapshot = null
    hostSnapshotVersion = null
    failedPairingAttempts = 0
    failedPairingWindowStart = Date.now()
    const activeServer = server
    server = undefined
    listeningPort = port
    if (!activeServer) return Promise.resolve(true)
    return new Promise((resolve) => activeServer.close(() => resolve(true)))
  }

  function approvePairing(requestId) {
    const pending = pendingPairings.get(requestId)
    if (!pending || pending.expiresAt <= Date.now()) return false
    pendingPairings.delete(requestId)
    pairedClients.set(pending.clientToken, { clientId: pending.clientId, clientName: pending.clientName, sourceAddress: pending.sourceAddress, expiresAt: Date.now() + CLIENT_TOKEN_TTL_MS })
    pairingResults.set(requestId, {
      expiresAt: Date.now() + PAIRING_CODE_TTL_MS,
      sourceAddress: pending.sourceAddress,
      response: { status: 'approved', clientId: pending.clientId, clientToken: pending.clientToken, expiresAt: new Date(Date.now() + CLIENT_TOKEN_TTL_MS).toISOString() },
    })
    return true
  }

  function rejectPairing(requestId) {
    const pending = pendingPairings.get(requestId)
    if (!pending) return false
    pendingPairings.delete(requestId)
    pairingResults.set(requestId, { expiresAt: Date.now() + PAIRING_CODE_TTL_MS, sourceAddress: pending.sourceAddress, response: { status: 'rejected' } })
    return true
  }

  function getPairedClients() {
    pruneExpiredPairingState()
    return [...new Map([...pairedClients.values()].map((client) => [client.clientId, {
      clientId: client.clientId,
      clientName: client.clientName,
      sourceAddress: client.sourceAddress,
      expiresAt: new Date(client.expiresAt).toISOString(),
    }])).values()]
  }

  function revokeClient(clientId) {
    let removed = false
    clientsAwaitingReview.delete(clientId)
    for (const [token, client] of pairedClients) {
      if (client.clientId !== clientId) continue
      pairedClients.delete(token)
      removed = true
    }
    return removed
  }

  function setGameStatus(update) {
    gameStatus = {
      gameLogActive: typeof update?.gameLogActive === 'boolean' ? update.gameLogActive : gameStatus.gameLogActive,
      locationCode: typeof update?.locationCode === 'string' ? update.locationCode.slice(0, 80) : gameStatus.locationCode,
      recordedAt: typeof update?.recordedAt === 'string' ? update.recordedAt.slice(0, 40) : gameStatus.recordedAt,
    }
  }

  function setHostSnapshot(snapshot) {
    if (!isSnapshotEnvelopeValid(snapshot)) return false
    hostSnapshot = snapshot
    hostSnapshotVersion = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
    return true
  }

  function resolveClientReview(clientId) {
    return clientsAwaitingReview.delete(clientId)
  }

  return {
    start,
    stop,
    setHostSnapshot,
    resolveClientReview,
    setGameStatus,
    rotatePairingCode,
    approvePairing,
    rejectPairing,
    getPairedClients,
    revokeClient,
    isRunning: () => Boolean(server),
  }
}

module.exports = { createSyncHost, isSnapshotEnvelopeValid }
