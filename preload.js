const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onHint: (callback) => ipcRenderer.on('show-hint', (_, message) => callback(message)),
  onAdbInitialized: (callback) => ipcRenderer.on('adb-initialized', (_, isReady) => callback(isReady)),
  onWifiDevicesUpdate: (callback) => ipcRenderer.on('update-wifi-devices', (_, devices) => callback(devices)),
  getWifiDevices: () => ipcRenderer.send('get-wifi-devices'),
  startScrcpy: (deviceId) => ipcRenderer.send('start-scrcpy', deviceId),
  stopScrcpy: () => ipcRenderer.send('stop-scrcpy')
});
