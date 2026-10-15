const path = require('node:path')
const { app, BrowserWindow, dialog, ipcMain } = require('electron')
const { detectGameInstallations, normalizeGameRoot } = require('./gameDetection.cjs')
const { startGameLogMonitor } = require('./gameLogMonitor.cjs')

let gameLogMonitor

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

function createWindow() {
  const window = new BrowserWindow({
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
    window.loadFile(path.join(__dirname, '../dist/index.html'))
  } else {
    window.loadURL('http://127.0.0.1:5173')
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
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', stopGameLogMonitor)