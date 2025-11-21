const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onHint: (callback) => ipcRenderer.on('show-hint', (_, message) => callback(message)),
  onAdbInitialized: (callback) => ipcRenderer.on('adb-initialized', (_, isReady) => callback(isReady)),
  onWifiDevicesUpdate: (callback) => ipcRenderer.on('update-wifi-devices', (_, devices) => callback(devices)),
  onBatteryInfoUpdate: (callback) => ipcRenderer.on('update-battery-info', (_, batteryInfo) => callback(batteryInfo)),
  onShowWaiting: (callback) => ipcRenderer.on('show-waiting', (_, message) => callback(message)),
  onHideWaiting: (callback) => ipcRenderer.on('hide-waiting', () => callback()),
  onScrcpyStateChanged: (callback) => ipcRenderer.on('scrcpy-state-changed', (_, data) => callback(data)),
  getWifiDevices: () => ipcRenderer.send('get-wifi-devices'),
  startBatteryMonitoring: (deviceId) => ipcRenderer.send('start-battery-monitoring', deviceId),
  stopBatteryMonitoring: () => ipcRenderer.send('stop-battery-monitoring'),
  startScrcpy: (deviceId) => ipcRenderer.send('start-scrcpy', deviceId),
  stopScrcpy: () => ipcRenderer.send('stop-scrcpy'),
  quitCurrentApp: (deviceId) => ipcRenderer.send('quit-current-app', deviceId),
  shutdown: () => ipcRenderer.send('shutdown-app')
});
