const path = require('node:path')
const { app, BrowserWindow } = require('electron')

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
  if (process.platform !== 'darwin') app.quit()
})