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
  listScreenSources: () => ipcRenderer.invoke('screen-reader:list-sources'),
  selectScreenSource: (sourceId) => ipcRenderer.invoke('screen-reader:select-source', sourceId),
  startSyncHost: () => ipcRenderer.invoke('sync:host-start'),
  discoverSyncHosts: () => ipcRenderer.invoke('sync:discover-hosts'),
  rotateSyncPairingCode: () => ipcRenderer.invoke('sync:host-rotate-code'),
  publishSyncSnapshot: (snapshot) => ipcRenderer.invoke('sync:publish-snapshot', snapshot),
  resolveSyncReview: (clientId) => ipcRenderer.invoke('sync:resolve-review', clientId),
  stopSyncHost: () => ipcRenderer.invoke('sync:host-stop'),
  listSyncClients: () => ipcRenderer.invoke('sync:list-clients'),
  revokeSyncClient: (clientId) => ipcRenderer.invoke('sync:revoke-client', clientId),
  requestSync: (url, data, token) => ipcRenderer.invoke('sync:client-request', { url, data, token }),
  approveSyncPairing: (requestId) => ipcRenderer.invoke('sync:approve-pair', requestId),
  rejectSyncPairing: (requestId) => ipcRenderer.invoke('sync:reject-pair', requestId),
  onSyncPairRequest: (callback) => {
    const listener = (_event, request) => callback(request)
    ipcRenderer.on('sync:pair-request', listener)
    return () => ipcRenderer.removeListener('sync:pair-request', listener)
  },
  onSyncProposal: (callback) => {
    const listener = (_event, proposal) => callback(proposal)
    ipcRenderer.on('sync:proposal', listener)
    return () => ipcRenderer.removeListener('sync:proposal', listener)
  },
})