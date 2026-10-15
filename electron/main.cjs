const path = require('node:path')
const { app, BrowserWindow, dialog, ipcMain } = require('electron')
const { detectGameInstallations, normalizeGameRoot } = require('./gameDetection.cjs')
const { startGameLogMonitor } = require('./gameLogMonitor.cjs')
const { createSyncHost } = require('./syncServer.cjs')
const { createTailscaleServe } = require('./tailscaleServe.cjs')

let gameLogMonitor
let mainWindow
const syncHost = createSyncHost({
  port: 0,
  onPairRequest: (request) => {
    if (mainWindow && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send('sync:pair-request', request)
  },
  onProposal: (proposal) => {
    if (mainWindow && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send('sync:proposal', proposal)
  },
})
const tailscaleServe = createTailscaleServe()

function stopGameLogMonitor() {
  gameLogMonitor?.stop()
  gameLogMonitor = undefined
}

ipcMain.handle('star-citizen:detect', (_event, customRoots) => detectGameInstallations(Array.isArray(customRoots) ? customRoots.slice(0, 20) : []))
ipcMain.handle('star-citizen:choose-root', async (event) => {
  const parent = BrowserWindow.fromWebContents(event.sender)
  const result = await dialog.showOpenDialog(parent, { title: 'Select Star Citizen install folder', properties: ['openDirectory'] })
  return result.canceled ? null : normalizeGameRoot(result.filePaths[0])
})
ipcMain.handle('star-citizen:watch-log', (event, request) => {
  stopGameLogMonitor()
  const channel = request?.channel
  if (channel !== 'LIVE' && channel !== 'PTU') return { status: 'invalid-channel' }

  const customRoots = Array.isArray(request?.customRoots) ? request.customRoots.slice(0, 20) : []
  const installation = detectGameInstallations(customRoots).find((item) => item.channel === channel)
  if (!installation) return { status: 'installation-not-found' }

  const logPath = path.join(installation.path, 'Game.log')
  gameLogMonitor = startGameLogMonitor(logPath, channel, (gameEvent) => {
    if (!event.sender.isDestroyed()) event.sender.send('star-citizen:game-log-event', gameEvent)
  }, (status) => {
    if (!event.sender.isDestroyed()) event.sender.send('star-citizen:game-log-status', status)
  })
  return { status: require('node:fs').existsSync(logPath) ? 'watching' : 'waiting-for-log' }
})
ipcMain.handle('star-citizen:stop-log', () => {
  stopGameLogMonitor()
  return true
})
ipcMain.handle('sync:host-start', async () => {
  const host = await syncHost.start()
  if (host.status !== 'listening') return host
  const served = tailscaleServe.start(host.port)
  if (served.status !== 'ready') {
    tailscaleServe.stop()
    await syncHost.stop()
    return { status: served.status === 'tailscale-cli-not-found' || served.status === 'tailscale-dns-unavailable' ? served.status : 'serve-error', detail: served.detail }
  }
  return { ...host, address: served.url, publicUrl: served.url }
})
ipcMain.handle('sync:host-rotate-code', () => syncHost.isRunning() ? syncHost.rotatePairingCode() : null)
ipcMain.handle('sync:host-stop', async () => {
  tailscaleServe.stop()
  return syncHost.stop()
})
ipcMain.handle('sync:list-clients', () => syncHost.getPairedClients())
ipcMain.handle('sync:revoke-client', (_event, clientId) => syncHost.revokeClient(clientId))
ipcMain.handle('sync:approve-pair', (_event, requestId) => syncHost.approvePairing(requestId))
ipcMain.handle('sync:reject-pair', (_event, requestId) => syncHost.rejectPairing(requestId))
ipcMain.handle('sync:client-request', async (event, request) => {
  if (BrowserWindow.fromWebContents(event.sender) === null || event.senderFrame !== event.sender.mainFrame) return { status: 403, data: { error: 'untrusted-renderer' } }
  let url
  try { url = new URL(request?.url) } catch { return { status: 400, data: { error: 'invalid-sync-url' } } }
  if (url.protocol !== 'https:' || !url.hostname.toLocaleLowerCase().endsWith('.ts.net') || url.username || url.password || url.search || url.hash) {
    return { status: 400, data: { error: 'invalid-sync-url' } }
  }
  if (!['/pair', '/pair-status', '/sync', '/disconnect'].includes(url.pathname.replace(/^\/sc-command-hub-sync/, ''))) {
    return { status: 404, data: { error: 'invalid-sync-path' } }
  }
  const body = JSON.stringify(request?.data ?? {})
  if (Buffer.byteLength(body, 'utf8') > 64 * 1024 * 1024) return { status: 413, data: { error: 'payload-too-large' } }
  const headers = { 'Content-Type': 'application/json' }
  if (typeof request?.token === 'string' && request.token.length < 512) headers.Authorization = `Bearer ${request.token}`
  const response = await fetch(url, { method: 'POST', headers, body, redirect: 'error' })
  const data = await response.json().catch(() => null)
  return { status: response.status, data }
})

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 360,
    minHeight: 600,
    backgroundColor: '#f4f5f0',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  })

  if (app.isPackaged) {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  } else {
    mainWindow.loadURL('http://127.0.0.1:5173')
  }
}

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  stopGameLogMonitor()
  tailscaleServe.stop()
  void syncHost.stop()
  mainWindow = undefined
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  stopGameLogMonitor()
  tailscaleServe.stop()
  void syncHost.stop()
})