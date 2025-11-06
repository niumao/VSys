const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const udev = require('udev');
const { execSync, spawn } = require('child_process');
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
let scrcpyProcesses = {}; // 存储 scrcpy 进程 { displayId: process }
let displayCheckInterval = null; // display 状态检查定时器
let currentDevice = null; // 当前选中的设备

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

  //checkenv();
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

// 检查 display 的 mHasContent 状态
async function checkDisplayContent(deviceId) {
  try {
    const result = await execAdbCommand(
      `adb -s ${deviceId} shell dumpsys display`, 
      { encoding: 'utf8' }
    );
    
    const displays = {};
    
    // 解析 display 信息
    const displayMatches = result.matchAll(/mDisplayId=(\d+)[\s\S]*?mHasContent=(true|false)/g);
    for (const match of displayMatches) {
      const displayId = match[1];
      const hasContent = match[2] === 'true';
      displays[displayId] = hasContent;
    }
    
    return displays;
  } catch (error) {
    console.error('检查 display 状态失败:', error.message);
    return {};
  }
}

// 启动 scrcpy 进程
function startScrcpy(deviceId, displayId, position = 'center') {
  // 如果已经在运行，先停止
  if (scrcpyProcesses[displayId]) {
    stopScrcpy(displayId);
  }
  
  // 获取主窗口位置和大小
  const mainBounds = mainWindow.getBounds();
  
  // 计算 main-content 区域的位置（左侧栏占1/9，即约133px）
  const sidebarWidth = Math.floor(mainBounds.width / 9);
  const mainContentX = mainBounds.x + sidebarWidth;
  const mainContentY = mainBounds.y;
  const mainContentWidth = mainBounds.width - sidebarWidth;
  const mainContentHeight = mainBounds.height - 50; // 减去底部栏高度
  
  let windowX, windowY, windowWidth, windowHeight;
  
  if (position === 'bottom') {
    // menubar (displayId=3) 在下方
    windowWidth = mainContentWidth;
    windowHeight = Math.floor(mainContentHeight / 6); // 下方占1/6高度
    windowX = mainContentX;
    windowY = mainBounds.y + mainContentHeight - windowHeight;
  } else {
    // center window (displayId=9 或 14) 在中间
    windowWidth = Math.floor(mainContentWidth * 0.8);
    windowHeight = Math.floor((mainContentHeight - Math.floor(mainContentHeight / 6)) * 0.9); // 减去 menubar 高度
    windowX = mainContentX + Math.floor((mainContentWidth - windowWidth) / 2);
    windowY = mainBounds.y + Math.floor((mainContentHeight - windowHeight - Math.floor(mainContentHeight / 6)) / 2);
  }
  
  const scrcpyArgs = [
    '--display-id=' + displayId,
    '--window-borderless',
    '--always-on-top',
    '--window-x=' + windowX,
    '--window-y=' + windowY,
    '--window-width=' + windowWidth,
    '--window-height=' + windowHeight,
    '--window-title=Display' + displayId,
    '-s', deviceId
  ];
  
  console.log('启动 scrcpy:', 'scrcpy', scrcpyArgs.join(' '));
  
  const scrcpyProcess = spawn('scrcpy', scrcpyArgs, {
    detached: false,
    stdio: 'ignore'
  });
  
  scrcpyProcess.on('error', (error) => {
    console.error(`scrcpy 启动失败 (displayId=${displayId}):`, error.message);
    mainWindow?.webContents.send('show-hint', `scrcpy 启动失败: ${error.message}`);
  });
  
  scrcpyProcess.on('exit', (code) => {
    console.log(`scrcpy 进程退出 (displayId=${displayId}), 退出码: ${code}`);
    delete scrcpyProcesses[displayId];
  });
  
  scrcpyProcesses[displayId] = scrcpyProcess;
  mainWindow?.webContents.send('show-hint', `已启动 display ${displayId}`);
}

// 停止 scrcpy 进程
function stopScrcpy(displayId) {
  const process = scrcpyProcesses[displayId];
  if (process) {
    try {
      process.kill();
      delete scrcpyProcesses[displayId];
      console.log(`已停止 scrcpy (displayId=${displayId})`);
    } catch (error) {
      console.error(`停止 scrcpy 失败 (displayId=${displayId}):`, error.message);
    }
  }
}

// 停止所有 scrcpy 进程
function stopAllScrcpy() {
  Object.keys(scrcpyProcesses).forEach(displayId => {
    stopScrcpy(displayId);
  });
  
  // 停止检查定时器
  if (displayCheckInterval) {
    clearInterval(displayCheckInterval);
    displayCheckInterval = null;
  }
}

// 启动 scrcpy 监控
async function startScrcpyMonitoring(deviceId) {
  currentDevice = deviceId;
  
  // 先停止之前的监控
  stopAllScrcpy();
  
  // 立即检查一次
  await updateDisplays();
  
  // 每1秒检查一次 display 状态
  displayCheckInterval = setInterval(async () => {
    await updateDisplays();
  }, 1000);
  
  mainWindow?.webContents.send('show-hint', `已开始监控设备 ${deviceId}`);
}

// 更新 display 显示状态
async function updateDisplays() {
  if (!currentDevice) return;
  
  const displays = await checkDisplayContent(currentDevice);
  
  // 检查 menubar (displayId=3) - 始终显示在下方
  if (displays['3']) {
    if (!scrcpyProcesses['3']) {
      startScrcpy(currentDevice, '3', 'bottom');
    }
  } else {
    if (scrcpyProcesses['3']) {
      stopScrcpy('3');
    }
  }
  
  // 检查 center window (displayId=9 或 14)
  // 优先显示 displayId=9，如果没有则显示 displayId=14
  let centerDisplayId = null;
  if (displays['9']) {
    centerDisplayId = '9';
  } else if (displays['14']) {
    centerDisplayId = '14';
  }
  
  // 启动或停止 center window
  if (centerDisplayId) {
    // 停止另一个 center display
    const otherCenterId = centerDisplayId === '9' ? '14' : '9';
    if (scrcpyProcesses[otherCenterId]) {
      stopScrcpy(otherCenterId);
    }
    
    // 启动当前 center display
    if (!scrcpyProcesses[centerDisplayId]) {
      startScrcpy(currentDevice, centerDisplayId, 'center');
    }
  } else {
    // 两个都不显示，停止所有 center displays
    if (scrcpyProcesses['9']) stopScrcpy('9');
    if (scrcpyProcesses['14']) stopScrcpy('14');
  }
}

// IPC 监听器
ipcMain.on('start-scrcpy', (event, deviceId) => {
  if (!deviceId) {
    mainWindow?.webContents.send('show-hint', '请先选择设备');
    return;
  }
  startScrcpyMonitoring(deviceId);
});

ipcMain.on('stop-scrcpy', () => {
  stopAllScrcpy();
  mainWindow?.webContents.send('show-hint', '已停止所有 scrcpy');
});

// 关闭应用和电脑
ipcMain.on('shutdown-app', async () => {
  try {
    mainWindow?.webContents.send('show-hint', '正在关闭所有设备...');
    
    // 1. 停止所有 scrcpy 进程
    stopAllScrcpy();
    
    // 2. 断开所有 WiFi 设备连接
    if (wifiDevices.length > 0) {
      for (const device of wifiDevices) {
        try {
          await execAdbCommand(`adb disconnect ${device}`, { stdio: 'pipe' });
          console.log(`已断开设备: ${device}`);
        } catch (error) {
          console.error(`断开设备失败 ${device}:`, error.message);
        }
      }
    }
    
    // 3. 停止 adb server
    try {
      await execAdbCommand('adb kill-server', { stdio: 'pipe' });
      console.log('ADB server 已关闭');
    } catch (error) {
      console.error('关闭 ADB server 失败:', error.message);
    }
    
    // 4. 关闭电脑
    mainWindow?.webContents.send('show-hint', '正在关闭电脑...');
    console.log('正在关闭电脑...');
    
    // 延迟1秒后关闭电脑
    setTimeout(() => {
      try {
        // Linux 系统关机命令
        execSync('shutdown now', { stdio: 'pipe' });
      } catch (error) {
        console.error('关闭电脑失败:', error.message);
        // 如果 shutdown 失败，尝试使用 poweroff
        try {
          execSync('poweroff', { stdio: 'pipe' });
        } catch (e) {
          console.error('poweroff 也失败:', e.message);
        }
      }
      
      // 退出应用
      app.quit();
    }, 1000);
    
  } catch (error) {
    console.error('关闭应用失败:', error.message);
    // 即使失败也尝试关闭电脑
    try {
      execSync('shutdown now', { stdio: 'pipe' });
    } catch (e) {
      console.error('关闭电脑失败:', e.message);
    }
    app.quit();
  }
});
