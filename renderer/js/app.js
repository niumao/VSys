let deviceTimerStates = {}; 
let currentDevice = null; 
let timerInterval = null;

let timerBtn;
let devicesSelect;

function initTimer() {
  devicesSelect.addEventListener('change', (e) => {
    const newDevice = e.target.value;
    if (newDevice === currentDevice || !newDevice) return;

    if (currentDevice) {
      saveCurrentDeviceState();
    }

    currentDevice = newDevice;
    loadDeviceState(currentDevice);
    
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
    return;
  }

  devicesSelect.innerHTML = '';
  devices.forEach(device => {
    const option = document.createElement('option');
    option.value = device;
    option.textContent = device;
    devicesSelect.appendChild(option);

    if (!prevDevices.includes(device)) {
      deviceTimerStates[device] = {
        timestamps: 0,
        state: 'reset'
      };
    }
  });

  devicesSelect.disabled = false;
  
  if (!currentDevice || !devices.includes(currentDevice)) {
    currentDevice = devices[0];
    devicesSelect.value = currentDevice;
    loadDeviceState(currentDevice); // 加载默认设备状态
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
    statusInfo.textContent = `状态提示：${message}`;
    // 5秒后恢复默认提示
    setTimeout(() => {
      statusInfo.textContent = '状态提示：准备就绪';
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

document.addEventListener('DOMContentLoaded', () => {
  // 初始化DOM元素引用
  timerBtn = document.getElementById('timer-btn');
  devicesSelect = document.getElementById('wifi-devices');
  
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
    });
  }
  
  if (stopScrcpyBtn) {
    stopScrcpyBtn.addEventListener('click', () => {
      // 停止所有 scrcpy
      window.electronAPI.stopScrcpy();
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
