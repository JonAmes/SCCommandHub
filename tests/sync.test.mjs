import assert from 'node:assert/strict'
import test from 'node:test'
import { previewSyncMerge, validateSyncSnapshot, persistSyncSnapshot } from '../src/appSync.ts'
import { createSyncHost } from '../electron/syncServer.cjs'
import { createTailscaleServe } from '../electron/tailscaleServe.cjs'

const createdAt = '2026-10-15T12:00:00.000Z'

function createSnapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    exportedAt: createdAt,
    data: {
      finance: { accounts: [], transactions: [] },
      hangar: { ships: [], activeShipId: null, cargoByShip: {} },
      crew: { members: [], roles: [] },
      routes: [],
      miningOps: { scans: [] },
      gameLog: { pendingTransactions: [], processedEventIds: [], resolvedEventIds: [] },
      marketPriceHistory: [],
      systemIndexSnapshot: null,
      preferences: { theme: 'field', gameChannel: 'LIVE', workspaceMode: null },
      ...overrides,
    },
  }
}

test('validates sync snapshots and rejects malformed records', () => {
  const valid = createSnapshot()
  assert.equal(validateSyncSnapshot(valid), true)
  assert.equal(validateSyncSnapshot({ ...valid, data: { ...valid.data, finance: { accounts: [null], transactions: [] } } }), false)
  assert.equal(validateSyncSnapshot({ ...valid, data: { ...valid.data, gameLog: { pendingTransactions: [], processedEventIds: [], resolvedEventIds: 'bad' } } }), false)
})

test('merges by stable IDs, preserves primary conflicts, and requeues client Game.log entries', () => {
  const primary = createSnapshot({
    finance: { accounts: [{ id: 'primary-account', name: 'Wallet', balance: 500, createdAt }], transactions: [] },
    hangar: {
      ships: [{ id: 'primary-ship', vehicleId: 'vehicle-1', name: 'C1', manufacturer: 'Crusader', cargoCapacity: 64, photoUrl: '', addedAt: createdAt }],
      activeShipId: 'primary-ship',
      cargoByShip: { 'primary-ship': {} },
    },
  })
  const incoming = createSnapshot({
    finance: {
      accounts: [{ id: 'client-account', name: 'wallet', balance: 450, createdAt }],
      transactions: [
        { id: 'client-buy', accountId: 'client-account', accountName: 'wallet', side: 'buy', commodity: 'Ore', terminal: 'Shop', quantity: 1, unitPrice: 50, total: 50, note: '', recordedAt: createdAt },
        { id: 'client-game-buy', sourceEventId: 'game-event-1', accountId: 'client-account', accountName: 'wallet', side: 'game_purchase', commodity: 'Helmet', terminal: 'Shop', quantity: 1, unitPrice: 40, total: 40, note: 'Game.log LIVE · guid-1', recordedAt: createdAt },
      ],
    },
    hangar: {
      ships: [{ id: 'client-ship', vehicleId: 'vehicle-1', name: 'C1', manufacturer: 'Crusader', cargoCapacity: 64, photoUrl: '', addedAt: createdAt }],
      activeShipId: 'client-ship',
      cargoByShip: { 'client-ship': { Ore: 2 } },
    },
    crew: { members: [{ id: 'crew-1', name: 'Crew', sharePercent: 10, payoutAccountId: 'client-account', createdAt }], roles: [] },
    gameLog: { pendingTransactions: [], processedEventIds: ['game-event-1'], resolvedEventIds: ['game-event-1'] },
    preferences: { theme: 'night', gameChannel: 'PTU', workspaceMode: null },
  })

  assert.equal(validateSyncSnapshot(primary), true)
  assert.equal(validateSyncSnapshot(incoming), true)
  const merged = previewSyncMerge(primary, incoming).snapshot
  assert.equal(merged.data.finance.accounts.length, 1)
  assert.equal(merged.data.finance.accounts[0].balance, 450)
  assert.equal(merged.data.finance.transactions[0].accountId, 'primary-account')
  assert.equal(merged.data.finance.transactions.some((entry) => entry.side === 'game_purchase'), false)
  assert.equal(merged.data.hangar.ships.length, 1)
  assert.equal(merged.data.hangar.activeShipId, 'primary-ship')
  assert.equal(merged.data.hangar.cargoByShip['primary-ship'].Ore, 2)
  assert.equal(merged.data.crew.members[0].payoutAccountId, 'primary-account')
  assert.equal(merged.data.gameLog.pendingTransactions.some((event) => event.id === 'game-event-1'), true)
  assert.equal(merged.data.preferences.theme, 'field')

  const retry = previewSyncMerge(merged, incoming).snapshot
  assert.equal(retry.data.finance.accounts[0].balance, 450)
  assert.equal(retry.data.finance.transactions.length, 1)
})

test('persists approved snapshots without copying credentials', () => {
  const originalWindow = globalThis.window
  const values = new Map([
    ['sc-command-hub.uex-token', 'local-secret'],
    ['sc-command-hub.sync-client-v1', 'local-pairing-token'],
  ])
  globalThis.window = { localStorage: {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  } }
  try {
    assert.equal(persistSyncSnapshot(createSnapshot()), true)
    assert.equal(values.get('sc-command-hub.uex-token'), 'local-secret')
    assert.equal(values.get('sc-command-hub.sync-client-v1'), 'local-pairing-token')
    assert.equal(values.has('sc-command-hub.finance-v1'), true)
  } finally {
    if (originalWindow === undefined) delete globalThis.window
    else globalThis.window = originalWindow
  }
})

test('pairs through an app-specific Tailscale HTTPS URL and rejects unauthenticated uploads', async () => {
  const proposals = []
  const pairingRequests = []
  const serveCalls = []
  const serve = createTailscaleServe({
    findCli: () => 'tailscale',
    run: (_cli, args) => {
      serveCalls.push(args)
      return args[0] === 'status' ? JSON.stringify({ Self: { DNSName: 'primary.tailnet.ts.net.' } }) : ''
    },
  })
  const host = createSyncHost({ port: 0, onProposal: (proposal) => proposals.push(proposal), onPairRequest: (request) => pairingRequests.push(request) })

  try {
    const listener = await host.start()
    assert.equal(listener.address, '127.0.0.1')
    const served = serve.start(listener.port)
    assert.equal(served.url, 'https://primary.tailnet.ts.net:8443/sc-command-hub-sync')
    const baseUrl = `http://127.0.0.1:${listener.port}/sc-command-hub-sync`
    const headers = { 'Content-Type': 'application/json' }
    const snapshot = createSnapshot()
    const pair = await fetch(`${baseUrl}/pair`, { method: 'POST', headers, body: JSON.stringify({ code: listener.code, clientName: 'Client A' }) })
    assert.equal(pair.status, 202)
    const requestId = pairingRequests[0].requestId
    assert.equal(host.approvePairing(requestId), true)
    const approval = await fetch(`${baseUrl}/pair-status`, { method: 'POST', headers, body: JSON.stringify({ requestId }) })
    const credentials = await approval.json()
    assert.equal(credentials.status, 'approved')

    const upload = await fetch(`${baseUrl}/sync`, { method: 'POST', headers: { ...headers, Authorization: `Bearer ${credentials.clientToken}` }, body: JSON.stringify({ snapshot }) })
    assert.equal(upload.status, 202)
    assert.equal(proposals.length, 1)

    const denied = await fetch(`${baseUrl}/sync`, { method: 'POST', headers: { ...headers, Authorization: 'Bearer invalid' }, body: JSON.stringify({ snapshot }) })
    assert.equal(denied.status, 401)
    assert.equal(host.revokeClient(credentials.clientId), true)
    const revoked = await fetch(`${baseUrl}/sync`, { method: 'POST', headers: { ...headers, Authorization: `Bearer ${credentials.clientToken}` }, body: JSON.stringify({ snapshot }) })
    assert.equal(revoked.status, 401)
    assert.equal(serve.stop(), true)
    assert.ok(serveCalls.at(-1).includes('off'))
  } finally {
    serve.stop()
    await host.stop()
  }
})

test('explains when Tailscale Serve is not enabled on the tailnet', () => {
  const serve = createTailscaleServe({
    findCli: () => 'tailscale',
    run: (_cli, args) => {
      if (args[0] !== 'serve' || args.includes('off')) return ''
      throw Object.assign(new Error('spawnSync tailscale ETIMEDOUT'), { stdout: '\nServe is not enabled on your tailnet.\nTo enable, visit:\n\n https://login.tailscale.com/f/serve?node=abc\n' })
    },
  })
  const result = serve.start(1234)
  assert.equal(result.status, 'serve-error')
  assert.match(result.detail, /not enabled on your tailnet.*https:\/\/login\.tailscale\.com\/f\/serve\?node=abc/)
})

test('shares Game.log status and player location only with paired clients', async () => {
  const pairingRequests = []
  const host = createSyncHost({ port: 0, onPairRequest: (request) => pairingRequests.push(request) })
  try {
    const listener = await host.start()
    const baseUrl = `http://127.0.0.1:${listener.port}/sc-command-hub-sync`
    const headers = { 'Content-Type': 'application/json' }
    const denied = await fetch(`${baseUrl}/status`, { method: 'POST', headers, body: '{}' })
    assert.equal(denied.status, 401)

    await fetch(`${baseUrl}/pair`, { method: 'POST', headers, body: JSON.stringify({ code: listener.code, clientName: 'Phone' }) })
    host.approvePairing(pairingRequests[0].requestId)
    const credentials = await (await fetch(`${baseUrl}/pair-status`, { method: 'POST', headers, body: JSON.stringify({ requestId: pairingRequests[0].requestId }) })).json()
    host.setGameStatus({ gameLogActive: true })
    host.setGameStatus({ locationCode: 'RR_ARC_L1', recordedAt: '2026-10-15T15:00:00.000Z' })
    const status = await fetch(`${baseUrl}/status`, { method: 'POST', headers: { ...headers, Authorization: `Bearer ${credentials.clientToken}` }, body: '{}' })
    assert.equal(status.status, 200)
    assert.deepEqual(await status.json(), { gameLogActive: true, locationCode: 'RR_ARC_L1', recordedAt: '2026-10-15T15:00:00.000Z' })
  } finally {
    await host.stop()
  }
})
