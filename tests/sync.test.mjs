import assert from 'node:assert/strict'
import test from 'node:test'
import { previewSyncMerge, validateSyncSnapshot, persistSyncSnapshot } from '../src/appSync.ts'
import { createSyncHost } from '../electron/syncServer.cjs'
import { createTailscaleServe } from '../electron/tailscaleServe.cjs'
import { tailnetCandidates, discoverTailscaleHosts, createHostAdvertisement, probeHost } from '../electron/syncDiscovery.cjs'
import { discoverNativeSyncHosts, validatedDiscoveredHosts } from '../src/syncDiscovery.ts'

const createdAt = '2026-10-15T12:00:00.000Z'

test('discovery probes require the protocol marker and bound response size', async () => {
  const candidate = { name: 'Host', url: 'https://host.tail.ts.net:8443/sc-command-hub-sync' }
  assert.equal(await probeHost(candidate, async (_url, options) => {
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers.Authorization, undefined)
    return new Response(JSON.stringify({ service: 'sc-command-hub', protocolVersion: 1 }))
  }), true)
  assert.equal(await probeHost(candidate, async () => new Response('{}')), false)
  assert.equal(await probeHost(candidate, async () => new Response('x'.repeat(4097))), false)
  assert.equal(await probeHost(candidate, async () => { throw new Error('unreachable') }), false)
})

test('host discovery UI selects verified hosts and falls back to manual URLs', { timeout: 60_000 }, async () => {
  const { chromium } = await import('playwright')
  const { createServer } = await import('vite')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
  let browser
  try {
    await server.listen()
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`
    browser = await chromium.launch()
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    await page.route('**/*', (route) => route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort())
    await page.addInitScript(() => {
      localStorage.setItem('sc-command-hub.setup-profile-v1', JSON.stringify({ skipped: true, completedAt: new Date().toISOString() }))
      window.discoveryTest = { mode: 'one', requests: [] }
      window.starCitizenBridge = {
        discoverSyncHosts: async () => {
          const host = { name: 'Desktop A', url: 'https://desktop-a.tail.ts.net:8443/sc-command-hub-sync' }
          if (window.discoveryTest.mode === 'error') throw new Error('Discovery failed')
          if (window.discoveryTest.mode === 'none') return { hosts: [], message: 'No hosts found. Enter the host URL.' }
          if (window.discoveryTest.mode === 'invalid') return { hosts: [{ name: 'Untrusted', url: 'http://untrusted.local' }], message: '' }
          return { hosts: [host, ...(window.discoveryTest.mode === 'multiple' ? [{ name: 'Desktop B', url: 'https://desktop-b.tail.ts.net:8443/sc-command-hub-sync' }] : [])], message: '' }
        },
        requestSync: async (url, data) => {
          window.discoveryTest.requests.push({ url, data })
          return { status: 400, data: { error: 'test-pairing-request' } }
        },
      }
    })
    await page.goto(origin)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const detect = page.getByRole('button', { name: 'Auto detect hosts', exact: true })
    await detect.click()
    const selector = page.getByLabel(/^DETECTED HOST/)
    await page.getByText('1 host found.', { exact: true }).waitFor()
    assert.equal(await selector.inputValue(), 'https://desktop-a.tail.ts.net:8443/sc-command-hub-sync')
    assert.equal(await page.getByLabel('HOST TAILSCALE HTTPS URL', { exact: true }).count(), 0)
    assert.equal(await page.evaluate(() => window.discoveryTest.requests.length), 0, 'Discovery must not pair or send data automatically')
    await page.getByLabel('PAIRING CODE', { exact: true }).fill('123456')
    await page.getByRole('button', { name: 'Request pairing', exact: true }).click()
    await page.getByText('test-pairing-request', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.discoveryTest.requests[0].url), 'https://desktop-a.tail.ts.net:8443/sc-command-hub-sync/pair')
    await page.evaluate(() => { window.discoveryTest.mode = 'multiple' })
    await detect.click()
    await page.getByText('2 hosts found.', { exact: true }).waitFor()
    await selector.selectOption('https://desktop-b.tail.ts.net:8443/sc-command-hub-sync')
    await page.getByRole('button', { name: 'Request pairing', exact: true }).click()
    await page.waitForFunction(() => window.discoveryTest.requests.length === 2)
    assert.equal(await page.evaluate(() => window.discoveryTest.requests[1].url), 'https://desktop-b.tail.ts.net:8443/sc-command-hub-sync/pair')
    await page.evaluate(() => { window.discoveryTest.mode = 'none' })
    await detect.click()
    const manual = page.getByLabel('HOST TAILSCALE HTTPS URL', { exact: true })
    await manual.waitFor()
    await manual.fill('https://manual.tail.ts.net:8443/sc-command-hub-sync')
    await page.getByRole('button', { name: 'Request pairing', exact: true }).click()
    await page.waitForFunction(() => window.discoveryTest.requests.length === 3)
    assert.equal(await page.evaluate(() => window.discoveryTest.requests[2].url), 'https://manual.tail.ts.net:8443/sc-command-hub-sync/pair')
    for (const mode of ['error', 'invalid']) {
      await page.evaluate((mode) => { window.discoveryTest.mode = mode }, mode)
      await detect.click()
      await manual.waitFor()
      assert.equal(await manual.inputValue(), 'https://manual.tail.ts.net:8443/sc-command-hub-sync', 'A discovery failure must preserve manual input')
    }
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport)
      await page.locator('.app-sync-section').filter({ has: page.getByRole('heading', { name: 'Client', exact: true }) }).screenshot({ path: join(tmpdir(), `sc-host-discovery-${viewport.width}.png`) })
    }
  } finally {
    await browser?.close()
    await server.close()
  }
})

test('mobile discovery validates advertisements, verifies hosts and stops browsing', async () => {
  const url = 'https://host.tail.ts.net:8443/sc-command-hub-sync'
  const verified = []
  let stopped = 0
  const plugin = { watch: (_type, _domain, success) => {
    for (const candidate of [url, url, 'http://untrusted.local', 'https://host.tail.ts.net/incorrect']) success({ action: 'resolved', service: { name: 'Desktop', txtRecord: { version: '1', url: candidate } } })
  }, unwatch: () => { stopped += 1 } }
  const result = await discoverNativeSyncHosts(plugin, new AbortController().signal, { scanMs: 1, verify: async (host) => { verified.push(host.url); return true } })
  assert.deepEqual(verified, [url])
  assert.deepEqual(result.hosts, [{ name: 'Desktop', url }])
  assert.equal(stopped, 1)
  assert.deepEqual(validatedDiscoveredHosts([{ name: 'unsafe', url: 'https://user:password@host.tail.ts.net/sc-command-hub-sync' }]), [])
})

test('mobile discovery handles denied permission and cancellation with cleanup', async () => {
  const denied = await discoverNativeSyncHosts({ watch: (_type, _domain, _success, failure) => failure(), unwatch() {} }, new AbortController().signal)
  assert.deepEqual(denied.hosts, [])
  assert.match(denied.message, /permission/)
  const controller = new AbortController()
  let stopped = false
  const pending = discoverNativeSyncHosts({ watch() {}, unwatch() { stopped = true } }, controller.signal)
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(stopped, true)
})

test('discovers only verified Tailscale hosts with bounded probes and no credentials', async () => {
  const status = { Self: { DNSName: 'self.tail.ts.net.' }, Peer: {
    active: { DNSName: 'host.tail.ts.net.', HostName: 'Host', Online: true },
    duplicate: { DNSName: 'host.tail.ts.net.' },
    offline: { DNSName: 'offline.tail.ts.net.', Online: false },
    invalid: { DNSName: 'host.tail.ts.net/evil' },
  } }
  assert.deepEqual(tailnetCandidates(status).map((host) => host.url), ['https://self.tail.ts.net:8443/sc-command-hub-sync', 'https://host.tail.ts.net:8443/sc-command-hub-sync'])
  const result = await discoverTailscaleHosts({ getStatus: async () => status, probe: async (candidate) => candidate.name === 'Host' })
  assert.deepEqual(result.hosts, [{ name: 'Host', url: 'https://host.tail.ts.net:8443/sc-command-hub-sync' }])
  assert.deepEqual((await discoverTailscaleHosts({ getStatus: async () => { throw new Error('unavailable') } })).hosts, [])
  let active = 0
  let peak = 0
  await discoverTailscaleHosts({ getStatus: async () => ({ Peer: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [index, { DNSName: `host${index}.tail.ts.net` }])) }), probe: async () => {
    active += 1
    peak = Math.max(peak, active)
    await Promise.resolve()
    active -= 1
    return false
  } })
  assert.ok(peak <= 4)
  assert.equal(tailnetCandidates({ Peer: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [index, { DNSName: `host${index}.tail.ts.net` }])) }).length, 32)
})

test('advertises only the host endpoint and stops local discovery when hosting ends', () => {
  const published = []
  let stopped = 0
  let destroyed = 0
  const advertisement = createHostAdvertisement({ name: 'Desktop', createBonjour: () => ({ publish: (options) => {
    published.push(options)
    return { on() {}, stop() { stopped += 1 } }
  }, destroy() { destroyed += 1 } }) })
  assert.equal(advertisement.start('https://host.tail.ts.net:8443/sc-command-hub-sync'), true)
  assert.deepEqual(published[0].txt, { url: 'https://host.tail.ts.net:8443/sc-command-hub-sync', version: '1' })
  assert.equal(published[0].type, 'sc-command-hub')
  advertisement.stop()
  advertisement.stop()
  assert.equal(stopped, 1)
  assert.equal(destroyed, 1)
})

test('discovery identifies an active host without revealing pairing or synchronized data', async () => {
  const host = createSyncHost({ port: 0 })
  try {
    const listener = await host.start()
    const base = `http://127.0.0.1:${listener.port}/sc-command-hub-sync`
    const response = await fetch(`${base}/discover`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { service: 'sc-command-hub', protocolVersion: 1 })
    assert.equal((await fetch(`${base}/discover`)).status, 405)
    assert.equal((await fetch(`${base}/discover`, { method: 'POST', headers: { Origin: 'https://untrusted.example' }, body: '{}' })).status, 403)
    assert.equal((await fetch(`${base}/status`, { method: 'POST', body: '{}' })).status, 401)
    assert.equal((await fetch(`${base}/pull`, { method: 'POST', body: '{}' })).status, 401)
  } finally {
    await host.stop()
  }
})

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

test('scanner and salvage records validate, merge, remap links and preserve old snapshot storage', async () => {
  const { startSalvageSession, salvageStorageKey } = await import('../src/salvagingOps.ts')
  const { scannerStorageKey } = await import('../src/scannerOps.ts')
  const session = startSalvageSession({ sessions: [] }, { shipId: 'client-ship', shipName: 'Vulture', target: 'Wreck', location: 'Yela' }).sessions[0]
  session.money.push({ id: 'money', kind: 'sale', amount: 100, note: 'Sale', ledgerId: 'client-sale', recordedAt: createdAt })
  const ship = (id) => ({ id, vehicleId: 'vulture', name: 'Vulture', manufacturer: 'Drake', cargoCapacity: 12, photoUrl: '', addedAt: createdAt })
  const trade = { id: 'host-sale', sourceEventId: 'sale-event', side: 'game_sale', accountId: 'wallet', accountName: 'Wallet', commodity: 'RMC', terminal: 'Shop', quantity: 1, unitPrice: 100, total: 100, note: 'Game.log LIVE', recordedAt: createdAt }
  const account = { id: 'wallet', name: 'Wallet', balance: 100, createdAt }
  const primary = createSnapshot({ hangar: { ships: [ship('host-ship')], activeShipId: 'host-ship', cargoByShip: {} }, finance: { accounts: [account], transactions: [trade] }, salvagingOps: { sessions: [] }, scannerOps: { observations: [] } })
  const incoming = createSnapshot({ hangar: { ships: [ship('client-ship')], activeShipId: 'client-ship', cargoByShip: {} }, finance: { accounts: [account], transactions: [{ ...trade, id: 'client-sale' }] }, salvagingOps: { sessions: [session] }, scannerOps: { observations: [{ id: 'scan', target: 'contacts', identity: 'CONTACT 1', values: {}, recordedAt: createdAt, location: 'Yela', source: 'ocr' }] } })
  assert.equal(validateSyncSnapshot(incoming), true)
  const merged = previewSyncMerge(primary, incoming)
  assert.equal(merged.snapshot.data.salvagingOps.sessions[0].shipId, 'host-ship')
  assert.equal(merged.snapshot.data.salvagingOps.sessions[0].money[0].ledgerId, 'host-sale')
  assert.equal(merged.stats['salvage sessions'].added, 1)
  assert.equal(merged.stats['scanner observations'].added, 1)
  const hostSession = { ...session, target: 'Host target' }
  assert.equal(previewSyncMerge(createSnapshot({ salvagingOps: { sessions: [hostSession] } }), incoming).snapshot.data.salvagingOps.sessions[0].target, 'Host target')
  assert.equal(validateSyncSnapshot(createSnapshot({ salvagingOps: { sessions: [{ ...session, current: { amount: -1 } }] } })), false)
  assert.equal(validateSyncSnapshot(createSnapshot({ scannerOps: { observations: [null] } })), false)
  const oldWindow = globalThis.window
  const storage = new Map([[salvageStorageKey, JSON.stringify(incoming.data.salvagingOps)], [scannerStorageKey, JSON.stringify(incoming.data.scannerOps)]])
  globalThis.window = { localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) } }
  try {
    assert.equal(persistSyncSnapshot(createSnapshot()), true)
    assert.deepEqual(JSON.parse(storage.get(salvageStorageKey)), incoming.data.salvagingOps)
    assert.equal(persistSyncSnapshot(merged.snapshot), true)
    assert.deepEqual(JSON.parse(storage.get(scannerStorageKey)), merged.snapshot.data.scannerOps)
  } finally { globalThis.window = oldWindow }
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

test('serves host data to paired clients and pauses updates while client changes await review', async () => {
  const pairingRequests = []
  const host = createSyncHost({ port: 0, onPairRequest: (request) => pairingRequests.push(request) })
  try {
    const listener = await host.start()
    const baseUrl = `http://127.0.0.1:${listener.port}/sc-command-hub-sync`
    const headers = { 'Content-Type': 'application/json' }
    await fetch(`${baseUrl}/pair`, { method: 'POST', headers, body: JSON.stringify({ code: listener.code, clientName: 'Phone' }) })
    host.approvePairing(pairingRequests[0].requestId)
    const credentials = await (await fetch(`${baseUrl}/pair-status`, { method: 'POST', headers, body: JSON.stringify({ requestId: pairingRequests[0].requestId }) })).json()
    const auth = { ...headers, Authorization: `Bearer ${credentials.clientToken}` }
    const pull = (since) => fetch(`${baseUrl}/pull`, { method: 'POST', headers: auth, body: JSON.stringify({ since }) })

    assert.equal((await fetch(`${baseUrl}/pull`, { method: 'POST', headers, body: '{}' })).status, 401)
    assert.equal((await pull(null)).status, 503)
    assert.equal(host.setHostSnapshot({ nope: true }), false)
    assert.equal(host.setHostSnapshot(createSnapshot()), true)

    await new Promise((resolve) => setTimeout(resolve, 1100))
    const first = await (await pull(null)).json()
    assert.equal(first.pendingReview, false)
    assert.equal(first.snapshot.schemaVersion, 1)

    await new Promise((resolve) => setTimeout(resolve, 1100))
    const unchanged = await (await pull(first.version)).json()
    assert.equal(unchanged.snapshot, undefined)

    await fetch(`${baseUrl}/sync`, { method: 'POST', headers: auth, body: JSON.stringify({ snapshot: createSnapshot() }) })
    await new Promise((resolve) => setTimeout(resolve, 1100))
    assert.equal((await (await pull(first.version)).json()).pendingReview, true)
    assert.equal(host.resolveClientReview(credentials.clientId), true)
    await new Promise((resolve) => setTimeout(resolve, 1100))
    assert.equal((await (await pull(first.version)).json()).pendingReview, false)
  } finally {
    await host.stop()
  }
})
