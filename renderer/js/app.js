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
  console.log('[DEBUG] updateDevicesSelect: 更新设备列表, 设备数量:', devices.length, '设备:', devices);
  const prevDevices = Object.keys(deviceTimerStates); // 之前已存在的设备
  console.log('[DEBUG] updateDevicesSelect: 之前的设备:', prevDevices);

  if (devices.length === 0) {
    console.log('[DEBUG] updateDevicesSelect: 没有设备，清空列表');
    devicesSelect.innerHTML = '<option value="">无设备</option>';
    devicesSelect.disabled = true;
    timerBtn.disabled = true;
    currentDevice = null;
    clearInterval(timerInterval);
    // 停止电池监控
    console.log('[DEBUG] updateDevicesSelect: 停止电池监控');
    window.electronAPI.stopBatteryMonitoring();
    return;
  }

  console.log('[DEBUG] updateDevicesSelect: 填充设备选择器...');
  devicesSelect.innerHTML = '';
  devices.forEach(device => {
    const option = document.createElement('option');
    option.value = device;
    option.textContent = device;
    devicesSelect.appendChild(option);
    console.log('[DEBUG] updateDevicesSelect: 添加设备选项:', device);

    if (!prevDevices.includes(device)) {
      console.log('[DEBUG] updateDevicesSelect: 新设备，初始化计时器状态:', device);
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
    console.log('[DEBUG] updateDevicesSelect: 设置当前设备为:', currentDevice);
    loadDeviceState(currentDevice); // 加载默认设备状态
    // 启动电池监控
    console.log('[DEBUG] updateDevicesSelect: 启动电池监控...');
    window.electronAPI.startBatteryMonitoring(currentDevice);
  }
  console.log('[DEBUG] updateDevicesSelect: 设备列表更新完成');
}

// 监听主进程消息
window.electronAPI.onAdbInitialized((isReady) => {
  console.log('[DEBUG] onAdbInitialized: ADB初始化状态:', isReady);
  if (isReady) {
    console.log('[DEBUG] onAdbInitialized: ADB已初始化');
  }
});

window.electronAPI.onUsbDevicesUpdate((devices) => {
  console.log('[DEBUG] onUsbDevicesUpdate: 收到USB设备更新:', devices);
  updateDevicesSelect(devices);
});

window.electronAPI.onHint((message) => {
  console.log('[DEBUG] onHint: 收到提示消息:', message);
  const statusInfo = document.querySelector('.status-info');
  if (statusInfo) {
    statusInfo.textContent = `状态提示：${message}`;
    console.log('[DEBUG] onHint: 状态栏已更新');
    // 5秒后恢复默认提示
    setTimeout(() => {
      statusInfo.textContent = '状态提示：准备就绪';
      console.log('[DEBUG] onHint: 状态栏恢复默认');
    }, 5000);
  }
});

// 监听电池信息更新
window.electronAPI.onBatteryInfoUpdate((batteryInfo) => {
  console.log('[DEBUG] onBatteryInfoUpdate: 收到电池信息更新:', batteryInfo);
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
  console.log('[DEBUG] DOMContentLoaded: DOM加载完成，开始初始化...');
  // 初始化DOM元素引用
  timerBtn = document.getElementById('timer-btn');
  devicesSelect = document.getElementById('usb-devices');
  console.log('[DEBUG] DOMContentLoaded: DOM元素已获取');
  
  console.log('[DEBUG] DOMContentLoaded: 初始化计时器...');
  initTimer();
  console.log('[DEBUG] DOMContentLoaded: 初始化scrcpy...');
  initScrcpy();
  console.log('[DEBUG] DOMContentLoaded: 初始化完成');
});

// 初始化 scrcpy 按钮
function initScrcpy() {
  console.log('[DEBUG] initScrcpy: 初始化scrcpy按钮...');
  const scrcpyBtn = document.getElementById('scrcpy-btn');
  const stopScrcpyBtn = document.getElementById('stop-scrcpy-btn');
  const quitAppBtn = document.getElementById('quit-app-btn');
  const shutdownBtn = document.getElementById('shutdown-btn');
  
  if (scrcpyBtn) {
    scrcpyBtn.addEventListener('click', () => {
      console.log('[DEBUG] scrcpy-btn: 点击启动scrcpy按钮');
      if (!currentDevice) {
        console.log('[DEBUG] scrcpy-btn: 没有选择设备');
        return;
      }
      console.log('[DEBUG] scrcpy-btn: 启动scrcpy监控, 设备:', currentDevice);
      // 启动 scrcpy 监控
      window.electronAPI.startScrcpy(currentDevice);
    });
    console.log('[DEBUG] initScrcpy: scrcpy按钮事件已绑定');
  }
  
  if (stopScrcpyBtn) {
    stopScrcpyBtn.addEventListener('click', () => {
      console.log('[DEBUG] stop-scrcpy-btn: 点击停止scrcpy按钮');
      // 停止所有 scrcpy
      window.electronAPI.stopScrcpy();
    });
    console.log('[DEBUG] initScrcpy: stop-scrcpy按钮事件已绑定');
  }
  
  if (quitAppBtn) {
    quitAppBtn.addEventListener('click', () => {
      console.log('[DEBUG] quit-app-btn: 点击强制停止应用按钮');
      if (!currentDevice) {
        console.log('[DEBUG] quit-app-btn: 没有选择设备');
        return;
      }
      console.log('[DEBUG] quit-app-btn: 强制停止当前应用, 设备:', currentDevice);
      // 强制停止当前应用
      window.electronAPI.quitCurrentApp(currentDevice);
    });
    console.log('[DEBUG] initScrcpy: quit-app按钮事件已绑定');
  }
  
  if (shutdownBtn) {
    shutdownBtn.addEventListener('click', () => {
      console.log('[DEBUG] shutdown-btn: 点击关机按钮');
      console.log('[DEBUG] shutdown-btn: 开始关闭流程...');
      // 关闭所有设备并退出应用
      window.electronAPI.shutdown();
    });
    console.log('[DEBUG] initScrcpy: shutdown按钮事件已绑定');
  }
  
  console.log('[DEBUG] initScrcpy: 所有按钮初始化完成');
}
