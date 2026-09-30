const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // project files
  saveProject: (payload) => ipcRenderer.invoke('save-project', payload),
  openProject: () => ipcRenderer.invoke('open-project'),
  getInitialFile: () => ipcRenderer.invoke('initial-file'),
  exportPNG: (payload) => ipcRenderer.invoke('export-png', payload),
  // window
  minimize: () => ipcRenderer.send('win-minimize'),
  maximize: () => ipcRenderer.send('win-maximize'),
  close: () => ipcRenderer.send('win-close'),
  closeNow: () => ipcRenderer.send('close-now'),
  reloadNow: () => ipcRenderer.send('reload-now'),
  setTitle: (t) => ipcRenderer.send('set-title', t),
  isMaximized: () => ipcRenderer.invoke('win-is-maximized'),
  // events from main
  onMaximizedChange: (cb) => ipcRenderer.on('win-maximized', (e, v) => cb(v)),
  onCloseRequest: (cb) => ipcRenderer.on('request-close', () => { ipcRenderer.send('close-ack'); cb(); }),
  onReloadRequest: (cb) => ipcRenderer.on('request-reload', () => cb()),
  onError: (cb) => ipcRenderer.on('app-error', (e, v) => cb(v))
});
