const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const udev = require('udev');
const { execSync } = require('child_process');
const electronReload = require('electron-reload');

if (process.env.NODE_ENV !== 'production') {
  electronReload(__dirname, {
    electron: path.join(__dirname, 'node_modules', '.bin', 'electron'),
    delay: 1000
  });
}

let wifiDevices = [];
let mainWindow;
let processingDevices = new Set(); // 正在处理的设备集合

// 通用 ADB 命令执行函数
// delayBefore: true = 延迟后执行（delay and run），false = 执行后延迟（run and delay）
function execAdbCommand(command, options = {}, delayMs = 100, delayBefore = false) {
  return new Promise((resolve, reject) => {
    if (delayBefore) {
      // 延迟后执行（delay and run）
      setTimeout(() => {
        try {
          const result = execSync(command, options);
          resolve(result);
        } catch (error) {
          reject(error);
        }
      }, delayMs);
    } else {
      // 执行后延迟（run and delay）
      try {
        const result = execSync(command, options);
        
        setTimeout(() => {
          resolve(result);
        }, delayMs);
      } catch (error) {
        reject(error);
      }
    }
  });
}

ipcMain.on('get-wifi-devices', () => {
  console.log('收到设备列表请求，当前设备:', wifiDevices);
  mainWindow?.webContents.send('update-wifi-devices', wifiDevices);
});

async function initAdb() {
  try {
    await execAdbCommand('adb start-server', { stdio: 'pipe' }, 3000);
    console.log('ADB服务启动成功');
  } catch (error) {
    console.error('ADB初始化失败:', error.message);
    return false;
  }
  
  refreshWifiDevices().then(() => {
    console.log('ADB初始化成功,当前设备:', wifiDevices);
  }).catch((error) => {
    console.error('获取设备列表失败:', error.message);
  });
}

async function refreshWifiDevices() {
  try {
    const result = await execAdbCommand('adb devices', { encoding: 'utf8' });
    
    const newDevices = [];
    const lines = result.split('\n').slice(1);
    lines.forEach(line => {
      const match = line.match(/^(\S+)\s+device/);
      if (match) {
        const deviceId = match[1];
        if (deviceId.includes(':')) {
          newDevices.push(deviceId);
        }
      }
    });

    wifiDevices = newDevices;
    mainWindow?.webContents.send('update-wifi-devices', wifiDevices);
  } catch (error) {
    console.error('获取设备列表失败:', error.message);
  }
}

async function connectDeviceViaWifi(usbDeviceId) {
  try {
    await execAdbCommand(`adb -s ${usbDeviceId} tcpip 5555`, { encoding: 'utf8' }, 3000, true);
    
    const ipResult = await execAdbCommand(`adb -s ${usbDeviceId} shell ip route get 1`, { encoding: 'utf8' }, 3000, true);
    const ipMatch = ipResult.match(/src\s+(\d+\.\d+\.\d+\.\d+)/);
    if (!ipMatch) {
      mainWindow?.webContents.send('show-hint', `设备${usbDeviceId}获取IP失败`);
      return;
    }
    const deviceIp = ipMatch[1];
    
    await execAdbCommand(`adb connect ${deviceIp}:5555`, { stdio: 'pipe' }, 1800);
    mainWindow?.webContents.send('show-hint', `已通过WiFi连接设备: ${deviceIp}:5555`);
    setTimeout(refreshWifiDevices, 1000);
  } catch (error) {
    console.error('WiFi连接失败:', error.message);
    mainWindow?.webContents.send('show-hint', `WiFi连接失败: ${error.message}`);
  }
}

function monitorUsbDevices() {
  const monitor = udev.monitor('usb');
  
  monitor.on('add', async (device) => {
    if (device.ID_BUS === 'usb' && 
        (device.ID_VENDOR_ID === '2d40' ||  // Google厂商ID示例
         device.ID_MODEL?.includes('Android'))) {

        console.log('检测到USB设备插入事件');
        
        // 先快速检查是否有设备正在处理（避免浪费3秒延迟）
        try {
          // 立即获取设备列表（不延迟）
          const quickCheck = await execAdbCommand('adb devices', { encoding: 'utf8' }, 0);
          const quickDeviceId = quickCheck.match(/^(\S+)\s+device/m)?.[1];
          
          if (quickDeviceId && !quickDeviceId.includes(':') && processingDevices.has(quickDeviceId)) {
            console.log('设备已在处理队列中，忽略此次事件:', quickDeviceId);
            return;
          }
        } catch (error) {
          // 快速检查失败，继续正常流程
        }
        
        try {
          // 延迟3秒后再次获取设备列表（确保设备完全识别）
          const devicesResult = await execAdbCommand('adb devices', { encoding: 'utf8' }, 3000, true);
          const usbDeviceId = devicesResult.match(/^(\S+)\s+device/m)?.[1];
          
          console.log('USB设备ID:', usbDeviceId);
          if (usbDeviceId && !usbDeviceId.includes(':')) {
            // 再次检查是否正在处理该设备
            if (processingDevices.has(usbDeviceId)) {
              console.log('设备正在处理中，跳过:', usbDeviceId);
              return;
            }
            
            // 标记为正在处理
            processingDevices.add(usbDeviceId);
            console.log('开始处理设备:', usbDeviceId);
            
            try {
              mainWindow?.webContents.send('show-hint', `检测到新设备: ${usbDeviceId}`);
              await connectDeviceViaWifi(usbDeviceId);
            } finally {
              // 处理完成后，延迟移除标记（防止短时间内重复触发）
              setTimeout(() => {
                processingDevices.delete(usbDeviceId);
                console.log('设备处理完成，可重新处理:', usbDeviceId);
              }, 10000); // 10秒后允许重新处理
            }
          }
        } catch (error) {
          console.error('获取USB设备失败:', error.message);
        }
    }
  });

  monitor.on('error', (err) => {
    console.error('udev监听错误:', err);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    frame: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), }
  });

  mainWindow.loadFile('index.html');
  //mainWindow.webContents.openDevTools();

  initAdb();
  monitorUsbDevices();
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
