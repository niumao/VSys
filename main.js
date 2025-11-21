const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const udev = require('udev');
const { execSync, spawn } = require('child_process');

// 根据是否打包设置环境变量
if (app.isPackaged && !process.env.NODE_ENV) {
  process.env.NODE_ENV = 'production';
}

// 只在开发环境中加载 electron-reload
if (!app.isPackaged) {
  try {
    const electronReload = require('electron-reload');
    electronReload(__dirname, {
      electron: path.join(__dirname, 'node_modules', '.bin', 'electron'),
      delay: 1000
    });
  } catch (error) {
    console.log('electron-reload 未安装或不可用');
  }
}

let wifiDevices = [];
let mainWindow;
let processingDevices = new Set(); // 正在处理的设备集合
let scrcpyProcesses = {}; // 存储 scrcpy 进程 { displayId: process }
let displayCheckInterval = null; // display 状态检查定时器
let currentDevice = null; // 当前选中的设备
let batteryCheckInterval = null; // 电池状态检查定时器

// 通用 ADB 命令执行函数
// delayBefore: true = 延迟后执行（delay and run），false = 执行后延迟（run and delay）
function execAdbCommand(command, options = {}, delayMs = 100, delayBefore = false) {
  return new Promise((resolve, reject) => {
    if (delayBefore) {
      // 延迟后执行（delay and run）
      setTimeout(() => {
        try {
          console.log('[CMD]', command);
          const result = execSync(command, options);
          resolve(result);
        } catch (error) {
          reject(error);
        }
      }, delayMs);
    } else {
      // 执行后延迟（run and delay）
      try {
        console.log('[CMD]', command);
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

// 检查环境依赖
async function checkEnvironment() {
  const status = {
    adb: { available: false, message: '' },
    scrcpy: { available: false, message: '' },
    libudev: { available: false, message: '' }
  };
  
  // 检查 adb
  try {
    console.log('[CMD] which adb');
    execSync('which adb', { stdio: 'pipe' });
    console.log('[CMD] adb --version');
    const version = execSync('adb --version', { encoding: 'utf8' });
    status.adb.available = true;
    status.adb.message = `ADB 可用: ${version.split('\n')[0]}`;
    console.log('✓', status.adb.message);
  } catch (error) {
    status.adb.message = 'ADB 未安装或不在 PATH 中';
    console.error('✗', status.adb.message);
  }
  
  // 检查 scrcpy
  try {
    console.log('[CMD] which scrcpy');
    execSync('which scrcpy', { stdio: 'pipe' });
    console.log('[CMD] scrcpy --version');
    const version = execSync('scrcpy --version', { encoding: 'utf8' });
    status.scrcpy.available = true;
    status.scrcpy.message = `scrcpy 可用: ${version.split('\n')[0]}`;
    console.log('✓', status.scrcpy.message);
  } catch (error) {
    status.scrcpy.message = 'scrcpy 未安装或不在 PATH 中';
    console.error('✗', status.scrcpy.message);
  }
  
  // 检查 libudev
  try {
    // 尝试通过 ldconfig 检查 libudev
    const ldconfig = execSync('ldconfig -p | grep libudev', { encoding: 'utf8' });
    if (ldconfig.includes('libudev.so')) {
      status.libudev.available = true;
      status.libudev.message = 'libudev 可用';
      console.log('✓', status.libudev.message);
    } else {
      status.libudev.message = 'libudev 未找到';
      console.error('✗', status.libudev.message);
    }
  } catch (error) {
    // 如果 ldconfig 失败，尝试直接检查常见路径
    try {
      const fs = require('fs');
      const commonPaths = [
        '/lib/x86_64-linux-gnu/libudev.so.1',
        '/usr/lib/x86_64-linux-gnu/libudev.so.1',
        '/lib64/libudev.so.1',
        '/usr/lib64/libudev.so.1'
      ];
      
      const found = commonPaths.some(p => {
        try {
          return fs.existsSync(p);
        } catch (e) {
          return false;
        }
      });
      
      if (found) {
        status.libudev.available = true;
        status.libudev.message = 'libudev 可用';
        console.log('✓', status.libudev.message);
      } else {
        status.libudev.message = 'libudev 未找到，请安装 libudev-dev';
        console.error('✗', status.libudev.message);
      }
    } catch (e) {
      status.libudev.message = 'libudev 检查失败';
      console.error('✗', status.libudev.message);
    }
  }
  
  return status;
}

// 处理环境检查结果
async function handleEnvironmentCheck() {
  console.log('正在检查环境依赖...');
  const envStatus = await checkEnvironment();
  
  // 检查是否所有依赖都可用
  const missingDeps = [];
  if (!envStatus.adb.available) missingDeps.push(envStatus.adb.message);
  if (!envStatus.scrcpy.available) missingDeps.push(envStatus.scrcpy.message);
  if (!envStatus.libudev.available) missingDeps.push(envStatus.libudev.message);
  
  if (missingDeps.length > 0) {
    const errorMsg = '环境检查失败:\n' + missingDeps.join('\n');
    console.error(errorMsg);
    
    // 等待窗口加载后显示提示
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow?.webContents.send('show-hint', errorMsg);
    });
    
    // 如果 adb 不可用，返回 false
    if (!envStatus.adb.available) {
      console.error('ADB 不可用，跳过初始化');
      return false;
    }
  } else {
    console.log('✓ 所有环境依赖检查通过');
  }
  
  return true;
}

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
    
    // 清理不需要的后台进程
    const wifiDeviceId = `${deviceIp}:5555`;
    try {
      await execAdbCommand(`adb -s ${wifiDeviceId} shell am force-stop com.picovr.updatesystem`, { stdio: 'pipe' });
      console.log('已停止 com.picovr.updatesystem');
    } catch (error) {
      console.error('停止 updatesystem 失败:', error.message);
    }
    
    try {
      await execAdbCommand(`adb -s ${wifiDeviceId} shell am force-stop com.pvr.home`, { stdio: 'pipe' });
      console.log('已停止 com.pvr.home');
    } catch (error) {
      console.error('停止 pvr.home 失败:', error.message);
    }
    
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

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    frame: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), }
  });

  mainWindow.loadFile('index.html');
  //mainWindow.webContents.openDevTools();

  // 检查环境依赖
  const envOk = await handleEnvironmentCheck();
  if (!envOk) return;
  
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
      `adb -s ${deviceId} shell "dumpsys display | grep -E 'mDisplayId=|mHasContent=|mPrimaryDisplayDevice='"`, 
      { encoding: 'utf8' }
    );
    
    console.log('====== dumpsys display 原始输出 ======');
    console.log(result);
    console.log('====================================');
    
    const displays = [];
    const lines = result.split('\n');
    
    // 按顺序循环解析，确保 mDisplayId、mHasContent、mPrimaryDisplayDevice 按顺序匹配
    let currentDisplay = null;
    
    for (const line of lines) {
      const displayIdMatch = line.match(/mDisplayId=(\d+)/);
      if (displayIdMatch) {
        // 如果之前有未完成的 display，先保存它（保存所有有 deviceName 的）
        if (currentDisplay && currentDisplay.deviceName) {
          console.log(`✓ 保存 display: id=${currentDisplay.displayId}, hasContent=${currentDisplay.hasContent}, device=${currentDisplay.deviceName}`);
          displays.push({
            displayId: currentDisplay.displayId,
            hasContent: currentDisplay.hasContent,
            deviceName: currentDisplay.deviceName
          });
        } else if (currentDisplay) {
          console.log(`✗ 跳过 display: id=${currentDisplay.displayId}, hasContent=${currentDisplay.hasContent}, device=${currentDisplay.deviceName} (无deviceName)`);
        }
        // 开始新的 display
        currentDisplay = {
          displayId: displayIdMatch[1],
          hasContent: false,
          deviceName: null
        };
        console.log(`[解析] 找到 mDisplayId=${displayIdMatch[1]}`);
        continue;
      }
      
      if (currentDisplay) {
        const hasContentMatch = line.match(/mHasContent=(true|false)/);
        if (hasContentMatch) {
          currentDisplay.hasContent = hasContentMatch[1] === 'true';
          console.log(`[解析] displayId=${currentDisplay.displayId} 的 mHasContent=${hasContentMatch[1]}`);
          continue;
        }
        
        const deviceNameMatch = line.match(/mPrimaryDisplayDevice=(.+)/);
        if (deviceNameMatch) {
          currentDisplay.deviceName = deviceNameMatch[1].trim();
          console.log(`[解析] displayId=${currentDisplay.displayId} 的 mPrimaryDisplayDevice=${currentDisplay.deviceName}`);
          continue;
        }
      }
    }
    
    // 保存最后一个 display（保存所有有 deviceName 的）
    if (currentDisplay && currentDisplay.deviceName) {
      console.log(`✓ 保存最后的 display: id=${currentDisplay.displayId}, hasContent=${currentDisplay.hasContent}, device=${currentDisplay.deviceName}`);
      displays.push({
        displayId: currentDisplay.displayId,
        hasContent: currentDisplay.hasContent,
        deviceName: currentDisplay.deviceName
      });
    } else if (currentDisplay) {
      console.log(`✗ 跳过最后的 display: id=${currentDisplay.displayId}, hasContent=${currentDisplay.hasContent}, device=${currentDisplay.deviceName} (无deviceName)`);
    }
    
    console.log('====== 最终解析结果 ======');
    console.log('解析到的 display 信息:', displays);
    console.log('========================');
    return displays;
  } catch (error) {
    console.error('检查 display 状态失败:', error.message);
    return [];
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
    // menubar (NS_WINDOW_short_cut) 在下方
    windowWidth = mainContentWidth;
    windowHeight = Math.floor(mainContentHeight / 6); // 下方占1/6高度
    windowX = mainContentX;
    windowY = mainBounds.y + mainContentHeight - windowHeight;
  } else {
    // center window (NS_APP[...]) 在中间
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
  
  console.log('[CMD] scrcpy', scrcpyArgs.join(' '));
  
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
  
  // 定义允许的 display 类型
  const allowedDisplayTypes = [
    'NS_APP[com.picovr.send.lbplayer]',
    'NS_APP[com.pvr.appmanager]',
    'NS_WINDOW_short_cut'
  ];
  
  // 停止所有不允许的或 hasContent=false 的 scrcpy 进程
  Object.keys(scrcpyProcesses).forEach(displayId => {
    const display = displays.find(d => d.displayId === displayId);
    if (display) {
      const isAllowed = allowedDisplayTypes.includes(display.deviceName);
      
      // 停止条件：不在允许列表中，或者 hasContent=false
      if (!isAllowed) {
        console.log(`停止 displayId=${displayId} (不在允许列表中, deviceName=${display.deviceName})`);
        stopScrcpy(displayId);
      } else if (!display.hasContent) {
        console.log(`停止 displayId=${displayId} (hasContent=false, deviceName=${display.deviceName})`);
        stopScrcpy(displayId);
      }
    }
  });
  
  // 查找 menubar (NS_WINDOW_short_cut) - 只有 hasContent=true 时才显示
  const menubarDisplay = displays.find(d => 
    d.deviceName === 'NS_WINDOW_short_cut' && d.hasContent
  );
  
  console.log('找到的 menubar (hasContent=true):', menubarDisplay);
  
  // 处理 menubar - 只有 hasContent=true 时才启动
  if (menubarDisplay && !scrcpyProcesses[menubarDisplay.displayId]) {
    console.log(`启动 menubar displayId=${menubarDisplay.displayId}`);
    startScrcpy(currentDevice, menubarDisplay.displayId, 'bottom');
  }
  
  // 查找 center window (NS_APP[...]) - 只从 hasContent=true 的列表中选择
  const centerDisplays = displays.filter(d => 
    d.hasContent && (
      d.deviceName === 'NS_APP[com.pvr.appmanager]' ||
      d.deviceName === 'NS_APP[com.picovr.send.lbplayer]'
    )
  );
  
  let centerDisplay = null;
  // 优先选择 appmanager
  centerDisplay = centerDisplays.find(d => d.deviceName === 'NS_APP[com.pvr.appmanager]');
  // 如果没有，选择 lbplayer
  if (!centerDisplay) {
    centerDisplay = centerDisplays.find(d => d.deviceName === 'NS_APP[com.picovr.send.lbplayer]');
  }
  
  console.log('找到的 center display (hasContent=true):', centerDisplay);
  
  // 获取所有 center window 类型的 display
  const allCenterDisplays = displays.filter(d => 
    d.deviceName === 'NS_APP[com.pvr.appmanager]' ||
    d.deviceName === 'NS_APP[com.picovr.send.lbplayer]'
  );
  
  // 停止所有不是当前选中的 center displays
  allCenterDisplays.forEach(d => {
    if ((!centerDisplay || d.displayId !== centerDisplay.displayId) && scrcpyProcesses[d.displayId]) {
      console.log(`停止 center display displayId=${d.displayId}, deviceName=${d.deviceName} (不是当前选中的)`);
      stopScrcpy(d.displayId);
    }
  });
  
  // 启动当前选中的 center display
  if (centerDisplay && !scrcpyProcesses[centerDisplay.displayId]) {
    console.log(`启动 center window displayId=${centerDisplay.displayId}, deviceName=${centerDisplay.deviceName}`);
    startScrcpy(currentDevice, centerDisplay.displayId, 'center');
  }
  
  // 检查所有允许的 display 类型是否都是 hasContent=false
  const allowedDisplays = displays.filter(d => allowedDisplayTypes.includes(d.deviceName));
  const allHasContentFalse = allowedDisplays.length > 0 && allowedDisplays.every(d => !d.hasContent);
  
  if (allHasContentFalse) {
    console.log('所有允许的 displays 都是 hasContent=false，显示等待提示');
    mainWindow?.webContents.send('show-waiting', 'Running now, wait plz...');
  } else {
    console.log('至少有一个 display 的 hasContent=true，隐藏等待提示');
    mainWindow?.webContents.send('hide-waiting');
  }
}

// IPC 监听器
ipcMain.on('start-scrcpy', async (event, deviceId) => {
  if (!deviceId) {
    mainWindow?.webContents.send('show-hint', '请先选择设备');
    return;
  }
  startScrcpyMonitoring(deviceId);
  
  // 设置 persist.pvr.sleep_by_static 为 0
  try {
    await execAdbCommand(`adb -s ${deviceId} shell setprop persist.pvr.sleep_by_static 0`, { stdio: 'pipe' });
    console.log('已设置 persist.pvr.sleep_by_static = 0');
  } catch (error) {
    console.error('设置 persist.pvr.sleep_by_static 失败:', error.message);
  }
});

ipcMain.on('stop-scrcpy', async () => {
  stopAllScrcpy();
  
  // 设置 persist.pvr.sleep_by_static 为 1
  if (currentDevice) {
    try {
      await execAdbCommand(`adb -s ${currentDevice} shell setprop persist.pvr.sleep_by_static 1`, { stdio: 'pipe' });
      console.log('已设置 persist.pvr.sleep_by_static = 1');
    } catch (error) {
      console.error('设置 persist.pvr.sleep_by_static 失败:', error.message);
    }
  }
  
  mainWindow?.webContents.send('show-hint', '已停止所有 scrcpy');
});

// 关闭应用和电脑
ipcMain.on('shutdown-app', async () => {
  try {
    mainWindow?.webContents.send('show-hint', '正在关闭所有设备...');
    
    // 1. 停止所有 scrcpy 进程
    stopAllScrcpy();
    
    // 2. 停止电池监控
    stopBatteryMonitoring();
    
    // 3. 关闭所有设备（使用 reboot -p 命令）
    if (wifiDevices.length > 0) {
      for (const device of wifiDevices) {
        try {
          // 先关闭设备电源
          await execAdbCommand(`adb -s ${device} shell reboot -p`, { stdio: 'pipe' });
          console.log(`已关闭设备: ${device}`);
        } catch (error) {
          console.error(`关闭设备失败 ${device}:`, error.message);
        }
      }
      
      // 等待设备完全关闭
      mainWindow?.webContents.send('show-hint', '等待设备关闭...');
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    
    // 4. 断开所有 WiFi 设备连接
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
    
    // 5. 停止 adb server
    try {
      await execAdbCommand('adb kill-server', { stdio: 'pipe' });
      console.log('ADB server 已关闭');
    } catch (error) {
      console.error('关闭 ADB server 失败:', error.message);
    }
    
    // 6. 关闭电脑
    mainWindow?.webContents.send('show-hint', '正在关闭电脑...');
    console.log('正在关闭电脑...');
    
    // 延迟1秒后关闭电脑
    setTimeout(() => {
      try {
        // Linux 系统关机命令
        console.log('[CMD] shutdown now');
        execSync('shutdown now', { stdio: 'pipe' });
      } catch (error) {
        console.error('关闭电脑失败:', error.message);
        // 如果 shutdown 失败，尝试使用 poweroff
        try {
          console.log('[CMD] poweroff');
          execSync('poweroff', { stdio: 'pipe' });
        } catch (e) {
          console.error('poweroff 也失败:', e.message);
        }
      }
      
      // 退出应用
      app.quit();
    }, 3000);
    
  } catch (error) {
    console.error('关闭应用失败:', error.message);
    // 即使失败也尝试关闭电脑
    try {
      console.log('[CMD] shutdown now');
      execSync('shutdown now', { stdio: 'pipe' });
    } catch (e) {
      console.error('关闭电脑失败:', e.message);
    }
    app.quit();
  }
});

// 获取电池信息
async function getBatteryInfo(deviceId) {
  try {
    const result = await execAdbCommand(
      `adb -s ${deviceId} shell dumpsys battery`, 
      { encoding: 'utf8' }
    );
    
    const batteryInfo = {
      level: '--',
      status: '--',
      health: '--',
      scale: '--'
    };
    
    // 解析电池信息
    const levelMatch = result.match(/level:\s*(\d+)/);
    const statusMatch = result.match(/status:\s*(\d+)/);
    const healthMatch = result.match(/health:\s*(\d+)/);
    const scaleMatch = result.match(/scale:\s*(\d+)/);
    
    if (levelMatch) batteryInfo.level = levelMatch[1];
    if (statusMatch) {
      // 状态码转换为文字
      const statusCode = parseInt(statusMatch[1]);
      const statusMap = {
        1: '未知',
        2: '充电中',
        3: '放电中',
        4: '未充电',
        5: '已充满'
      };
      batteryInfo.status = statusMap[statusCode] || statusMatch[1];
    }
    if (healthMatch) {
      // 健康状态码转换为文字
      const healthCode = parseInt(healthMatch[1]);
      const healthMap = {
        1: '未知',
        2: '良好',
        3: '过热',
        4: '损坏',
        5: '过压',
        6: '故障',
        7: '低温'
      };
      batteryInfo.health = healthMap[healthCode] || healthMatch[1];
    }
    if (scaleMatch) batteryInfo.scale = scaleMatch[1];
    
    return batteryInfo;
  } catch (error) {
    console.error('获取电池信息失败:', error.message);
    return {
      level: '--',
      status: '--',
      health: '--',
      scale: '--'
    };
  }
}

// 启动电池信息监控
function startBatteryMonitoring(deviceId) {
  // 先停止之前的监控
  stopBatteryMonitoring();
  
  // 立即获取一次
  updateBatteryInfo(deviceId);
  
  // 每5秒更新一次电池信息
  batteryCheckInterval = setInterval(() => {
    updateBatteryInfo(deviceId);
  }, 5000);
}

// 更新电池信息
async function updateBatteryInfo(deviceId) {
  if (!deviceId) return;
  
  const batteryInfo = await getBatteryInfo(deviceId);
  mainWindow?.webContents.send('update-battery-info', batteryInfo);
}

// 停止电池信息监控
function stopBatteryMonitoring() {
  if (batteryCheckInterval) {
    clearInterval(batteryCheckInterval);
    batteryCheckInterval = null;
  }
  
  // 重置显示
  mainWindow?.webContents.send('update-battery-info', {
    level: '--',
    status: '--',
    health: '--',
    scale: '--'
  });
}

// IPC 监听器 - 启动电池监控
ipcMain.on('start-battery-monitoring', (event, deviceId) => {
  if (!deviceId) return;
  startBatteryMonitoring(deviceId);
});

// IPC 监听器 - 停止电池监控
ipcMain.on('stop-battery-monitoring', () => {
  stopBatteryMonitoring();
});

// 获取当前焦点应用并强制停止
async function quitCurrentApp(deviceId) {
  try {
    // 获取当前焦点窗口
    const result = await execAdbCommand(
      `adb -s ${deviceId} shell dumpsys window | grep mCurrentFocus`,
      { encoding: 'utf8' }
    );
    
    console.log('当前焦点窗口:', result.trim());
    
    // 解析包名，格式: mCurrentFocus=Window{... u0 com.example.app/com.example.app.MainActivity}
    const match = result.match(/u\d+\s+([^\s\/]+)/);
    
    if (match && match[1]) {
      const packageName = match[1];
      console.log('提取到的包名:', packageName);
      
      // 强制停止应用
      await execAdbCommand(
        `adb -s ${deviceId} shell am force-stop ${packageName}`,
        { encoding: 'utf8' }
      );
      
      mainWindow?.webContents.send('show-hint', `已强制停止: ${packageName}`);
      console.log(`已强制停止应用: ${packageName}`);
    } else {
      mainWindow?.webContents.send('show-hint', '未找到当前运行的应用');
      console.log('无法解析包名，原始输出:', result);
    }
  } catch (error) {
    console.error('强制停止应用失败:', error.message);
    mainWindow?.webContents.send('show-hint', `停止应用失败: ${error.message}`);
  }
}

// IPC 监听器 - 强制停止当前应用
ipcMain.on('quit-current-app', (event, deviceId) => {
  if (!deviceId) {
    mainWindow?.webContents.send('show-hint', '请先选择设备');
    return;
  }
  quitCurrentApp(deviceId);
});
                                              