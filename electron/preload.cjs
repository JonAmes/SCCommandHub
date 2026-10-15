const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('starCitizenBridge', {
  detectInstallations: (customRoots) => ipcRenderer.invoke('star-citizen:detect', customRoots),
  chooseInstallRoot: () => ipcRenderer.invoke('star-citizen:choose-root'),
  watchGameLog: (channel, customRoots) => ipcRenderer.invoke('star-citizen:watch-log', { channel, customRoots }),
  stopGameLog: () => ipcRenderer.invoke('star-citizen:stop-log'),
  onGameLogEvent: (callback) => {
    const listener = (_event, gameEvent) => callback(gameEvent)
    ipcRenderer.on('star-citizen:game-log-event', listener)
    return () => ipcRenderer.removeListener('star-citizen:game-log-event', listener)
  },
  onGameLogStatus: (callback) => {
    const listener = (_event, status) => callback(status)
    ipcRenderer.on('star-citizen:game-log-status', listener)
    return () => ipcRenderer.removeListener('star-citizen:game-log-status', listener)
  },
})