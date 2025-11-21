let deviceTimerStates = {}; 
let deviceScrcpyStates = {}; // scrcpy 状态存储 { deviceId: 'stopped' | 'running' }
let currentDevice = null; 
let timerInterval = null;

let timerBtn;
let devicesSelect;
let scrcpyBtn;

function initTimer() {
  devicesSelect.addEventListener('change', (e) => {
    const newDevice = e.target.value;
    if (newDevice === currentDevice || !newDevice) return;

    if (currentDevice) {
      // 保存旧设备的状态
      saveCurrentDeviceState();
      saveCurrentDeviceScrcpyState();
      
      // 停止旧设备的 scrcpy
      window.electronAPI.stopScrcpy();
    }

    currentDevice = newDevice;
    
    // 恢复新设备的状态
    loadDeviceState(currentDevice);
    loadDeviceScrcpyState(currentDevice);
    
    // 切换设备时更新电池监控
    if (newDevice) {
      window.electronAPI.startBatteryMonitoring(newDevice);
    } else {
      window.electronAPI.stopBatteryMonitoring();
    }
  });

  timerBtn.addEventListener('click', () => {
    if (!currentDevice) return;

    const currentState = deviceTimerStates[currentDevice]?.state || 'reset';
    switch (currentState) {
      case 'reset':
        // 重置状态 → 开始计时
        startTimer();
        break;
      case 'running':
        // 运行中 → 暂停计时
        pauseTimer();
        break;
      case 'paused':
        // 已暂停 → 重置
        resetCurrentDeviceTimer();
        break;
    }
  });
}

function saveCurrentDeviceState() {
  if (!currentDevice) return;

  const state = deviceTimerStates[currentDevice] || { timestamps: 0, state: 'reset' };
  deviceTimerStates[currentDevice] = {
    timestamps: state.state === 'running' ? getCurrentTimestamps() : state.timestamps,
    state: timerInterval ? 'running' : state.state 
  };
}

function loadDeviceState(deviceId) {
  clearInterval(timerInterval);
  timerInterval = null;

  if (!deviceTimerStates[deviceId]) {
    deviceTimerStates[deviceId] = {
      timestamps: 0,
      state: 'reset'
    };
  }

  const state = deviceTimerStates[deviceId];
  updateTimerDisplay(state.timestamps);
  updateTimerState(state.state);

  if (state.state === 'running') {
    startTimer(true); // 传入true表示从保存的时间戳继续
  }
}

function startTimer(isResume = false) {
  if (!currentDevice) return;

  const state = deviceTimerStates[currentDevice];
  if (!isResume) {
    // 从reset开始，记录开始时间戳
    state.timestamps = Date.now();
  } else {
    // 从paused恢复，调整开始时间戳以保留已经过的时间
    const elapsedMs = state.timestamps;
    state.timestamps = Date.now() - elapsedMs;
  }

  state.state = 'running';
  updateTimerState('running');
  
  timerInterval = setInterval(() => {
    const elapsedMs = Date.now() - state.timestamps;
    updateTimerDisplay(elapsedMs);
  }, 100);
}

function pauseTimer() {
  if (!currentDevice) return;

  const state = deviceTimerStates[currentDevice];
  clearInterval(timerInterval);
  timerInterval = null;
  
  // 保存已经过的毫秒数
  const elapsedMs = Date.now() - state.timestamps;
  state.timestamps = elapsedMs;
  state.state = 'paused';
  updateTimerState('paused');
  updateTimerDisplay(elapsedMs); 
}

function resetCurrentDeviceTimer() {
  if (!currentDevice) return;

  clearInterval(timerInterval);
  timerInterval = null;
  const state = deviceTimerStates[currentDevice];
  state.timestamps = 0;
  state.state = 'reset';
  updateTimerState('reset');
  updateTimerDisplay(0);
}

function getCurrentTimestamps() {
  const state = deviceTimerStates[currentDevice];
  if (!state) return 0;
  
  if (state.state === 'running') {
    return Date.now() - state.timestamps;
  }
  return state.timestamps;
}

function updateTimerDisplay(milliseconds) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600).toString().padStart(2, '0');
  const minutes = Math.floor((totalSeconds % 3600) / 60).toString().padStart(2, '0');
  const secs = (totalSeconds % 60).toString().padStart(2, '0');
  timerBtn.textContent = `${hours}:${minutes}:${secs}`;
}

function updateTimerState(state) {
  timerBtn.classList.remove('reset', 'running', 'paused');
  timerBtn.classList.add(state);
  timerBtn.disabled = false;
}

// scrcpy 状态管理函数
function saveCurrentDeviceScrcpyState() {
  if (!currentDevice) return;
  
  // 通过按钮状态判断是否正在运行
  const isRunning = scrcpyBtn && scrcpyBtn.classList.contains('running');
  deviceScrcpyStates[currentDevice] = isRunning ? 'running' : 'stopped';
  
  console.log(`保存设备 ${currentDevice} 的 scrcpy 状态: ${deviceScrcpyStates[currentDevice]}`);
}

function loadDeviceScrcpyState(deviceId) {
  if (!deviceId) return;
  
  // 如果设备没有状态记录，初始化为 stopped
  if (!deviceScrcpyStates[deviceId]) {
    deviceScrcpyStates[deviceId] = 'stopped';
  }
  
  const state = deviceScrcpyStates[deviceId];
  console.log(`加载设备 ${deviceId} 的 scrcpy 状态: ${state}`);
  
  // 更新 UI
  updateScrcpyButtonState(state);
  
  // 如果之前是运行状态，自动恢复
  if (state === 'running') {
    console.log(`自动恢复设备 ${deviceId} 的 scrcpy`);
    window.electronAPI.startScrcpy(deviceId);
  }
}

function updateScrcpyButtonState(state) {
  if (!scrcpyBtn) return;
  
  scrcpyBtn.classList.remove('stopped', 'running');
  scrcpyBtn.classList.add(state);
  
  // 更新按钮文本
  if (state === 'running') {
    scrcpyBtn.textContent = '投屏中';
  } else {
    scrcpyBtn.textContent = '启动投屏';
  }
}

function updateDevicesSelect(devices) {
  const prevDevices = Object.keys(deviceTimerStates); // 之前已存在的设备

  if (devices.length === 0) {
    devicesSelect.innerHTML = '<option value="">无设备</option>';
    devicesSelect.disabled = true;
    timerBtn.disabled = true;
    currentDevice = null;
    clearInterval(timerInterval);
    // 停止电池监控
    window.electronAPI.stopBatteryMonitoring();
    // 重置 scrcpy 按钮状态
    if (scrcpyBtn) {
      updateScrcpyButtonState('stopped');
    }
    return;
  }

  devicesSelect.innerHTML = '';
  devices.forEach(device => {
    const option = document.createElement('option');
    option.value = device;
    option.textContent = device;
    devicesSelect.appendChild(option);

    if (!prevDevices.includes(device)) {
      // 初始化新设备的 timer 状态
      deviceTimerStates[device] = {
        timestamps: 0,
        state: 'reset'
      };
      // 初始化新设备的 scrcpy 状态
      deviceScrcpyStates[device] = 'stopped';
    }
  });

  devicesSelect.disabled = false;
  
  if (!currentDevice || !devices.includes(currentDevice)) {
    currentDevice = devices[0];
    devicesSelect.value = currentDevice;
    loadDeviceState(currentDevice); // 加载默认设备的 timer 状态
    loadDeviceScrcpyState(currentDevice); // 加载默认设备的 scrcpy 状态
    // 启动电池监控
    window.electronAPI.startBatteryMonitoring(currentDevice);
  }
}

// 监听主进程消息
window.electronAPI.onAdbInitialized((isReady) => {
  if (isReady) {
    console.log('ADB已初始化');
  }
});

window.electronAPI.onWifiDevicesUpdate((devices) => {
  console.log('WiFi设备更新:', devices);
  updateDevicesSelect(devices);
});

window.electronAPI.onHint((message) => {
  console.log('提示消息:', message);
  const statusInfo = document.querySelector('.status-info');
  if (statusInfo) {
    statusInfo.textContent = message;
    // 5秒后恢复默认提示
    setTimeout(() => {
      statusInfo.textContent = '系统就绪';
    }, 5000);
  }
});

// 监听电池信息更新
window.electronAPI.onBatteryInfoUpdate((batteryInfo) => {
  console.log('电池信息更新:', batteryInfo);
  updateBatteryDisplay(batteryInfo);
});

// 更新电池信息显示
function updateBatteryDisplay(batteryInfo) {
  const levelEl = document.getElementById('battery-level');
  const statusEl = document.getElementById('battery-status');
  const healthEl = document.getElementById('battery-health');
  const scaleEl = document.getElementById('battery-scale');
  
  if (levelEl) levelEl.textContent = batteryInfo.level;
  if (statusEl) statusEl.textContent = batteryInfo.status;
  if (healthEl) healthEl.textContent = batteryInfo.health;
  if (scaleEl) scaleEl.textContent = batteryInfo.scale;
}

// 监听显示等待消息
window.electronAPI.onShowWaiting((message) => {
  console.log('显示等待消息:', message);
  showWaitingMessage(message);
});

// 监听隐藏等待消息
window.electronAPI.onHideWaiting(() => {
  console.log('隐藏等待消息');
  hideWaitingMessage();
});

// 监听 scrcpy 状态更新
window.electronAPI.onScrcpyStateChanged(({ deviceId, state }) => {
  console.log(`收到 scrcpy 状态更新: 设备=${deviceId}, 状态=${state}`);
  if (deviceScrcpyStates[deviceId] !== undefined) {
    deviceScrcpyStates[deviceId] = state;
    if (deviceId === currentDevice) {
      updateScrcpyButtonState(state);
    }
  }
});

// 显示等待消息
function showWaitingMessage(message) {
  const mainContent = document.querySelector('.main-content');
  if (!mainContent) return;
  
  // 检查是否已存在等待消息元素
  let waitingDiv = mainContent.querySelector('.waiting-message');
  
  if (!waitingDiv) {
    // 创建等待消息元素
    waitingDiv = document.createElement('div');
    waitingDiv.className = 'waiting-message';
    mainContent.appendChild(waitingDiv);
  }
  
  waitingDiv.textContent = message;
  waitingDiv.style.display = 'flex';
}

// 隐藏等待消息
function hideWaitingMessage() {
  const mainContent = document.querySelector('.main-content');
  if (!mainContent) return;
  
  const waitingDiv = mainContent.querySelector('.waiting-message');
  if (waitingDiv) {
    waitingDiv.style.display = 'none';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  // 初始化DOM元素引用
  timerBtn = document.getElementById('timer-btn');
  devicesSelect = document.getElementById('wifi-devices');
  scrcpyBtn = document.getElementById('scrcpy-btn');
  
  // 初始化 scrcpy 按钮默认状态
  if (scrcpyBtn) {
    updateScrcpyButtonState('stopped');
  }
  
  initTimer();
  initScrcpy();
});

// 初始化 scrcpy 按钮
function initScrcpy() {
  const scrcpyBtn = document.getElementById('scrcpy-btn');
  const stopScrcpyBtn = document.getElementById('stop-scrcpy-btn');
  const quitAppBtn = document.getElementById('quit-app-btn');
  const shutdownBtn = document.getElementById('shutdown-btn');
  
  if (scrcpyBtn) {
    scrcpyBtn.addEventListener('click', () => {
      if (!currentDevice) {
        console.log('请先选择设备');
        return;
      }
      // 启动 scrcpy 监控
      window.electronAPI.startScrcpy(currentDevice);
      // 更新状态
      deviceScrcpyStates[currentDevice] = 'running';
      updateScrcpyButtonState('running');
    });
  }
  
  if (stopScrcpyBtn) {
    stopScrcpyBtn.addEventListener('click', () => {
      // 停止所有 scrcpy
      window.electronAPI.stopScrcpy();
      // 更新状态
      if (currentDevice) {
        deviceScrcpyStates[currentDevice] = 'stopped';
        updateScrcpyButtonState('stopped');
      }
    });
  }
  
  if (quitAppBtn) {
    quitAppBtn.addEventListener('click', () => {
      if (!currentDevice) {
        console.log('请先选择设备');
        return;
      }
      // 强制停止当前应用
      window.electronAPI.quitCurrentApp(currentDevice);
    });
  }
  
  if (shutdownBtn) {
    shutdownBtn.addEventListener('click', () => {
      // 关闭所有设备并退出应用
      window.electronAPI.shutdown();
    });
  }
}
