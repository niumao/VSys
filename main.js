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

let usbDevices = [];
let mainWindow;
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

ipcMain.on('get-usb-devices', () => {
  console.log('[DEBUG] IPC: 收到 get-usb-devices 请求');
  console.log('[DEBUG] IPC: 当前USB设备:', usbDevices);
  mainWindow?.webContents.send('update-usb-devices', usbDevices);
  console.log('[DEBUG] IPC: 已发送设备列表到渲染进程');
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
    execSync('which adb', { stdio: 'pipe' });
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
    execSync('which scrcpy', { stdio: 'pipe' });
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
  console.log('[DEBUG] 开始初始化ADB...');
  try {
    console.log('[DEBUG] 正在启动ADB服务器...');
    await execAdbCommand('adb start-server', { stdio: 'pipe' }, 3000);
    console.log('[DEBUG] ADB服务启动成功');
  } catch (error) {
    console.error('[ERROR] ADB初始化失败:', error.message);
    return false;
  }
  
  console.log('[DEBUG] 开始刷新USB设备列表...');
  refreshUsbDevices().then(() => {
    console.log('[DEBUG] ADB初始化成功,当前设备:', usbDevices);
  }).catch((error) => {
    console.error('[ERROR] 获取设备列表失败:', error.message);
  });
}

async function refreshUsbDevices() {
  console.log('[DEBUG] refreshUsbDevices: 开始获取设备列表...');
  try {
    const result = await execAdbCommand('adb devices', { encoding: 'utf8' });
    console.log('[DEBUG] refreshUsbDevices: adb devices 原始输出:', result.trim());
    
    const newDevices = [];
    const lines = result.split('\n').slice(1);
    console.log('[DEBUG] refreshUsbDevices: 处理', lines.length, '行输出');
    
    lines.forEach(line => {
      const match = line.match(/^(\S+)\s+device/);
      if (match) {
        const deviceId = match[1];
        console.log('[DEBUG] refreshUsbDevices: 发现设备:', deviceId);
        // 只添加USB设备（不包含冒号的）
        if (!deviceId.includes(':')) {
          console.log('[DEBUG] refreshUsbDevices: 添加USB设备:', deviceId);
          newDevices.push(deviceId);
        } else {
          console.log('[DEBUG] refreshUsbDevices: 跳过WiFi设备:', deviceId);
        }
      }
    });

    console.log('[DEBUG] refreshUsbDevices: 找到', newDevices.length, '个USB设备:', newDevices);
    usbDevices = newDevices;
    console.log('[DEBUG] refreshUsbDevices: 发送设备列表更新到渲染进程');
    mainWindow?.webContents.send('update-usb-devices', usbDevices);
  } catch (error) {
    console.error('[ERROR] refreshUsbDevices: 获取设备列表失败:', error.message);
  }
}

async function setupUsbDevice(usbDeviceId) {
  console.log('[DEBUG] setupUsbDevice: 开始设置设备:', usbDeviceId);
  try {
    // 清理不需要的后台进程
    console.log('[DEBUG] setupUsbDevice: 停止后台进程...');
    try {
      console.log('[DEBUG] setupUsbDevice: 停止 com.picovr.updatesystem...');
      await execAdbCommand(`adb -s ${usbDeviceId} shell am force-stop com.picovr.updatesystem`, { stdio: 'pipe' });
      console.log('[DEBUG] setupUsbDevice: 已停止 com.picovr.updatesystem');
    } catch (error) {
      console.error('[ERROR] setupUsbDevice: 停止 updatesystem 失败:', error.message);
    }
    
    try {
      console.log('[DEBUG] setupUsbDevice: 停止 com.pvr.home...');
      await execAdbCommand(`adb -s ${usbDeviceId} shell am force-stop com.pvr.home`, { stdio: 'pipe' });
      console.log('[DEBUG] setupUsbDevice: 已停止 com.pvr.home');
    } catch (error) {
      console.error('[ERROR] setupUsbDevice: 停止 pvr.home 失败:', error.message);
    }
    
    console.log('[DEBUG] setupUsbDevice: 1秒后刷新设备列表...');
    setTimeout(refreshUsbDevices, 1000);
    console.log('[DEBUG] setupUsbDevice: 设备设置完成');
  } catch (error) {
    console.error('[ERROR] setupUsbDevice: 设备设置失败:', error.message);
    mainWindow?.webContents.send('show-hint', `设备设置失败: ${error.message}`);
  }
}

function monitorUsbDevices() {
  console.log('[DEBUG] monitorUsbDevices: 开始监控USB设备...');
  const monitor = udev.monitor('usb');
  
  monitor.on('add', async (device) => {
    console.log('[DEBUG] monitorUsbDevices: 检测到USB事件');
    console.log('[DEBUG] monitorUsbDevices: 设备信息 - ID_BUS:', device.ID_BUS, 'ID_VENDOR_ID:', device.ID_VENDOR_ID, 'ID_MODEL:', device.ID_MODEL);
    
    if (device.ID_BUS === 'usb' && 
        (device.ID_VENDOR_ID === '2d40' ||  // Google厂商ID示例
         device.ID_MODEL?.includes('Android'))) {

        console.log('[DEBUG] monitorUsbDevices: 检测到Android USB设备插入事件');
        
        try {
          console.log('[DEBUG] monitorUsbDevices: 等待3秒让设备完全识别...');
          // 延迟3秒后获取设备列表（确保设备完全识别）
          const devicesResult = await execAdbCommand('adb devices', { encoding: 'utf8' }, 3000, true);
          console.log('[DEBUG] monitorUsbDevices: adb devices 输出:', devicesResult.trim());
          
          const usbDeviceId = devicesResult.match(/^(\S+)\s+device/m)?.[1];
          
          console.log('[DEBUG] monitorUsbDevices: 提取的USB设备ID:', usbDeviceId);
          if (usbDeviceId && !usbDeviceId.includes(':')) {
            console.log('[DEBUG] monitorUsbDevices: 确认为USB设备，开始设置...');
            mainWindow?.webContents.send('show-hint', `检测到新设备: ${usbDeviceId}`);
            await setupUsbDevice(usbDeviceId);
          } else {
            console.log('[DEBUG] monitorUsbDevices: 设备ID无效或为WiFi设备，跳过');
          }
        } catch (error) {
          console.error('[ERROR] monitorUsbDevices: 获取USB设备失败:', error.message);
        }
    } else {
      console.log('[DEBUG] monitorUsbDevices: 非Android USB设备，跳过');
    }
  });

  monitor.on('error', (err) => {
    console.error('[ERROR] monitorUsbDevices: udev监听错误:', err);
  });
  
  console.log('[DEBUG] monitorUsbDevices: USB设备监控已启动');
}

async function createWindow() {
  console.log('[DEBUG] createWindow: 创建主窗口...');
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    frame: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), }
  });

  console.log('[DEBUG] createWindow: 加载 index.html...');
  mainWindow.loadFile('index.html');
  //mainWindow.webContents.openDevTools();

  // 检查环境依赖
  console.log('[DEBUG] createWindow: 检查环境依赖...');
  const envOk = await handleEnvironmentCheck();
  if (!envOk) {
    console.log('[DEBUG] createWindow: 环境检查失败，跳过初始化');
    return;
  }
  
  console.log('[DEBUG] createWindow: 初始化ADB...');
  initAdb();
  console.log('[DEBUG] createWindow: 启动USB设备监控...');
  monitorUsbDevices();
  console.log('[DEBUG] createWindow: 窗口创建完成');
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
    
    const displays = [];
    
    // 使用正则表达式一次性匹配所有 display 块（只匹配 hasContent=true）
    const displayRegex = /mDisplayId=(\d+)[\s\S]*?mHasContent=true[\s\S]*?mPrimaryDisplayDevice=(.+)/g;
    const matches = result.matchAll(displayRegex);
    
    for (const match of matches) {
      displays.push({
        displayId: match[1],
        hasContent: true,  // 确定是 true，因为正则只匹配 true
        deviceName: match[2].trim()
      });
    }
    
    console.log('解析到的 display 信息:', displays);
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
  console.log('[DEBUG] startScrcpyMonitoring: 开始监控设备:', deviceId);
  currentDevice = deviceId;
  
  // 先停止之前的监控
  console.log('[DEBUG] startScrcpyMonitoring: 停止之前的scrcpy进程...');
  stopAllScrcpy();
  
  // 立即检查一次
  console.log('[DEBUG] startScrcpyMonitoring: 立即检查display状态...');
  await updateDisplays();
  
  // 每1秒检查一次 display 状态
  console.log('[DEBUG] startScrcpyMonitoring: 启动display状态定时检查(1秒间隔)...');
  displayCheckInterval = setInterval(async () => {
    await updateDisplays();
  }, 1000);
  
  console.log('[DEBUG] startScrcpyMonitoring: scrcpy监控已启动');
  mainWindow?.webContents.send('show-hint', `已开始监控设备 ${deviceId}`);
}

// 更新 display 显示状态
async function updateDisplays() {
  if (!currentDevice) return;
  
  const displays = await checkDisplayContent(currentDevice);
  
  // 查找 menubar (NS_WINDOW_short_cut) - 始终显示在下方
  // displays 中只包含 hasContent=true 的项，所以不需要再判断 hasContent
  const menubarDisplay = displays.find(d => 
    d.deviceName === 'NS_WINDOW_short_cut'
  );
  
  console.log('找到的 menubar:', menubarDisplay);
  
  if (menubarDisplay) {
    if (!scrcpyProcesses[menubarDisplay.displayId]) {
      console.log(`启动 menubar displayId=${menubarDisplay.displayId}`);
      startScrcpy(currentDevice, menubarDisplay.displayId, 'bottom');
    }
  } else {
    // 停止所有可能的 menubar 进程
    const runningMenubar = displays.find(d => 
      d.deviceName === 'NS_WINDOW_short_cut' && scrcpyProcesses[d.displayId]
    );
    if (runningMenubar) {
      console.log(`停止 menubar displayId=${runningMenubar.displayId}`);
      stopScrcpy(runningMenubar.displayId);
    }
  }
  
  // 查找 center window (NS_APP[...])
  // 优先显示 NS_APP[com.pvr.appmanager]，如果没有则显示 NS_APP[com.picovr.send.lbplayer]
  const centerDisplays = displays.filter(d => 
    d.deviceName === 'NS_APP[com.pvr.appmanager]' ||
    d.deviceName === 'NS_APP[com.picovr.send.lbplayer]'
  );
  
  let centerDisplay = null;
  // 优先选择 appmanager
  centerDisplay = centerDisplays.find(d => d.deviceName === 'NS_APP[com.pvr.appmanager]');
  // 如果没有，选择 lbplayer
  if (!centerDisplay) {
    centerDisplay = centerDisplays.find(d => d.deviceName === 'NS_APP[com.picovr.send.lbplayer]');
  }
  
  console.log('找到的 center display:', centerDisplay);
  
  // 启动或停止 center window
  if (centerDisplay) {
    // 停止其他所有 center displays
    const allCenterDisplays = displays.filter(d => 
      d.deviceName === 'NS_APP[com.pvr.appmanager]' ||
      d.deviceName === 'NS_APP[com.picovr.send.lbplayer]'
    );
    
    allCenterDisplays.forEach(d => {
      if (d.displayId !== centerDisplay.displayId && scrcpyProcesses[d.displayId]) {
        stopScrcpy(d.displayId);
      }
    });
    
    // 启动当前 center display
    if (!scrcpyProcesses[centerDisplay.displayId]) {
      console.log(`启动 center window displayId=${centerDisplay.displayId}, deviceName=${centerDisplay.deviceName}`);
      startScrcpy(currentDevice, centerDisplay.displayId, 'center');
    }
  } else {
    // 没有 center window，停止所有可能的 center displays
    console.log('没有找到活动的 center window');
    const allCenterDisplays = displays.filter(d => 
      d.deviceName === 'NS_APP[com.pvr.appmanager]' ||
      d.deviceName === 'NS_APP[com.picovr.send.lbplayer]'
    );
    
    allCenterDisplays.forEach(d => {
      if (scrcpyProcesses[d.displayId]) {
        stopScrcpy(d.displayId);
      }
    });
  }
}

// IPC 监听器
ipcMain.on('start-scrcpy', (event, deviceId) => {
  console.log('[DEBUG] IPC: 收到 start-scrcpy 请求, 设备:', deviceId);
  if (!deviceId) {
    console.log('[DEBUG] IPC: 没有选择设备');
    mainWindow?.webContents.send('show-hint', '请先选择设备');
    return;
  }
  startScrcpyMonitoring(deviceId);
});

ipcMain.on('stop-scrcpy', () => {
  console.log('[DEBUG] IPC: 收到 stop-scrcpy 请求');
  stopAllScrcpy();
  mainWindow?.webContents.send('show-hint', '已停止所有 scrcpy');
  console.log('[DEBUG] IPC: 所有 scrcpy 已停止');
});

// 关闭应用和电脑
ipcMain.on('shutdown-app', async () => {
  console.log('[DEBUG] shutdown-app: 开始关闭流程...');
  try {
    mainWindow?.webContents.send('show-hint', '正在关闭所有设备...');
    
    // 1. 停止所有 scrcpy 进程
    console.log('[DEBUG] shutdown-app: 步骤1 - 停止所有scrcpy进程...');
    stopAllScrcpy();
    
    // 2. 停止电池监控
    console.log('[DEBUG] shutdown-app: 步骤2 - 停止电池监控...');
    stopBatteryMonitoring();
    
    // 3. 关闭所有设备（使用 reboot -p 命令）
    console.log('[DEBUG] shutdown-app: 步骤3 - 关闭所有USB设备...');
    console.log('[DEBUG] shutdown-app: 当前USB设备数量:', usbDevices.length);
    if (usbDevices.length > 0) {
      for (const device of usbDevices) {
        try {
          console.log('[DEBUG] shutdown-app: 关闭设备:', device);
          // 先关闭设备电源
          await execAdbCommand(`adb -s ${device} shell reboot -p`, { stdio: 'pipe' });
          console.log('[DEBUG] shutdown-app: 设备已关闭:', device);
        } catch (error) {
          console.error('[ERROR] shutdown-app: 关闭设备失败', device, ':', error.message);
        }
      }
      
      // 等待设备完全关闭
      console.log('[DEBUG] shutdown-app: 等待设备完全关闭(3秒)...');
      mainWindow?.webContents.send('show-hint', '等待设备关闭...');
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    
    // 4. 停止 adb server
    console.log('[DEBUG] shutdown-app: 步骤4 - 停止ADB服务器...');
    try {
      await execAdbCommand('adb kill-server', { stdio: 'pipe' });
      console.log('[DEBUG] shutdown-app: ADB server 已关闭');
    } catch (error) {
      console.error('[ERROR] shutdown-app: 关闭 ADB server 失败:', error.message);
    }
    
    // 5. 关闭电脑
    console.log('[DEBUG] shutdown-app: 步骤5 - 关闭电脑...');
    mainWindow?.webContents.send('show-hint', '正在关闭电脑...');
    
    // 延迟3秒后关闭电脑
    setTimeout(() => {
      console.log('[DEBUG] shutdown-app: 执行关机命令...');
      try {
        // Linux 系统关机命令
        execSync('shutdown now', { stdio: 'pipe' });
        console.log('[DEBUG] shutdown-app: shutdown now 命令已执行');
      } catch (error) {
        console.error('[ERROR] shutdown-app: 关闭电脑失败:', error.message);
        // 如果 shutdown 失败，尝试使用 poweroff
        try {
          console.log('[DEBUG] shutdown-app: 尝试使用 poweroff...');
          execSync('poweroff', { stdio: 'pipe' });
          console.log('[DEBUG] shutdown-app: poweroff 命令已执行');
        } catch (e) {
          console.error('[ERROR] shutdown-app: poweroff 也失败:', e.message);
        }
      }
      
      // 退出应用
      console.log('[DEBUG] shutdown-app: 退出应用...');
      app.quit();
    }, 3000);
    
  } catch (error) {
    console.error('[ERROR] shutdown-app: 关闭应用失败:', error.message);
    // 即使失败也尝试关闭电脑
    try {
      console.log('[DEBUG] shutdown-app: 发生错误，尝试直接关机...');
      execSync('shutdown now', { stdio: 'pipe' });
    } catch (e) {
      console.error('[ERROR] shutdown-app: 最终关机尝试失败:', e.message);
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
  console.log('[DEBUG] startBatteryMonitoring: 开始监控设备电池:', deviceId);
  // 先停止之前的监控
  stopBatteryMonitoring();
  
  // 立即获取一次
  console.log('[DEBUG] startBatteryMonitoring: 立即获取电池信息...');
  updateBatteryInfo(deviceId);
  
  // 每5秒更新一次电池信息
  console.log('[DEBUG] startBatteryMonitoring: 启动电池信息定时检查(5秒间隔)...');
  batteryCheckInterval = setInterval(() => {
    updateBatteryInfo(deviceId);
  }, 5000);
  console.log('[DEBUG] startBatteryMonitoring: 电池监控已启动');
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
  console.log('[DEBUG] IPC: 收到 start-battery-monitoring 请求, 设备:', deviceId);
  if (!deviceId) {
    console.log('[DEBUG] IPC: 没有设备ID，跳过');
    return;
  }
  startBatteryMonitoring(deviceId);
});

// IPC 监听器 - 停止电池监控
ipcMain.on('stop-battery-monitoring', () => {
  console.log('[DEBUG] IPC: 收到 stop-battery-monitoring 请求');
  stopBatteryMonitoring();
  console.log('[DEBUG] IPC: 电池监控已停止');
});

// 获取当前焦点应用并强制停止
async function quitCurrentApp(deviceId) {
  console.log('[DEBUG] quitCurrentApp: 开始强制停止当前应用, 设备:', deviceId);
  try {
    // 获取当前焦点窗口
    console.log('[DEBUG] quitCurrentApp: 获取当前焦点窗口...');
    const result = await execAdbCommand(
      `adb -s ${deviceId} shell dumpsys window | grep mCurrentFocus`,
      { encoding: 'utf8' }
    );
    
    console.log('[DEBUG] quitCurrentApp: 当前焦点窗口:', result.trim());
    
    // 解析包名，格式: mCurrentFocus=Window{... u0 com.example.app/com.example.app.MainActivity}
    const match = result.match(/u\d+\s+([^\s\/]+)/);
    
    if (match && match[1]) {
      const packageName = match[1];
      console.log('[DEBUG] quitCurrentApp: 提取到的包名:', packageName);
      
      // 强制停止应用
      console.log('[DEBUG] quitCurrentApp: 执行 force-stop 命令...');
      await execAdbCommand(
        `adb -s ${deviceId} shell am force-stop ${packageName}`,
        { encoding: 'utf8' }
      );
      
      console.log('[DEBUG] quitCurrentApp: 已强制停止应用:', packageName);
      mainWindow?.webContents.send('show-hint', `已强制停止: ${packageName}`);
    } else {
      console.log('[DEBUG] quitCurrentApp: 无法解析包名，原始输出:', result);
      mainWindow?.webContents.send('show-hint', '未找到当前运行的应用');
    }
  } catch (error) {
    console.error('[ERROR] quitCurrentApp: 强制停止应用失败:', error.message);
    mainWindow?.webContents.send('show-hint', `停止应用失败: ${error.message}`);
  }
}

// IPC 监听器 - 强制停止当前应用
ipcMain.on('quit-current-app', (event, deviceId) => {
  console.log('[DEBUG] IPC: 收到 quit-current-app 请求, 设备:', deviceId);
  if (!deviceId) {
    console.log('[DEBUG] IPC: 没有选择设备');
    mainWindow?.webContents.send('show-hint', '请先选择设备');
    return;
  }
  quitCurrentApp(deviceId);
});
