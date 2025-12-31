// Single device state management
let currentDevice = null; 
let timerInterval = null;
let timerState = {
  timestamps: 0,
  startTime: 0, // Store original start time
  state: 'reset', // 'reset' | 'running' | 'paused'
  pausedDisplay: 'elapsed' // 'elapsed' | 'start' - toggle in paused state
};
let scrcpyState = 'stopped'; // 'stopped' | 'running'
let lastClickTime = 0; // For double-click detection

let timerBtn;
let deviceStatusEl;
let scrcpyBtn;

function initTimer() {
  timerBtn.addEventListener('click', () => {
    if (!currentDevice) return;

    const now = Date.now();
    const timeSinceLastClick = now - lastClickTime;
    
    switch (timerState.state) {
      case 'reset':
        // 重置状态 → 开始计时
        startTimer();
        lastClickTime = now;
        break;
      case 'running':
        // 运行中 → 暂停计时
        pauseTimer();
        lastClickTime = now;
        break;
      case 'paused':
        // 已暂停 → 双击重置 or 单击切换显示
        if (timeSinceLastClick < 500) {
          // 双击检测：500ms内两次点击
          resetTimer();
        } else {
          // 单击：切换显示 (elapsed ↔ start)
          togglePausedDisplay();
        }
        lastClickTime = now;
        break;
    }
  });
}

function startTimer() {
  if (!currentDevice) return;

  // 记录开始时间戳
  timerState.timestamps = Date.now();
  timerState.startTime = Date.now(); // Save original start time
  timerState.state = 'running';
  updateTimerState('running');
  
  // 显示开始时间
  updateTimerDisplay(timerState.timestamps, 'start');
  
  timerInterval = setInterval(() => {
    // Keep showing start time
    updateTimerDisplay(timerState.startTime, 'start');
  }, 1000);
}

function pauseTimer() {
  if (!currentDevice) return;

  clearInterval(timerInterval);
  timerInterval = null;
  
  // 计算已经过的毫秒数
  const elapsedMs = Date.now() - timerState.timestamps;
  timerState.timestamps = elapsedMs;
  timerState.state = 'paused';
  timerState.pausedDisplay = 'elapsed'; // Default to showing elapsed time
  updateTimerState('paused');
  
  // 显示经过的时间
  updateTimerDisplay(elapsedMs, 'elapsed'); 
}

function resetTimer() {
  if (!currentDevice) return;

  clearInterval(timerInterval);
  timerInterval = null;
  timerState.timestamps = 0;
  timerState.startTime = 0;
  timerState.state = 'reset';
  timerState.pausedDisplay = 'elapsed';
  updateTimerState('reset');
  updateTimerDisplay(0, 'reset');
}

function togglePausedDisplay() {
  if (timerState.state !== 'paused') return;
  
  // Toggle between elapsed and start
  if (timerState.pausedDisplay === 'elapsed') {
    timerState.pausedDisplay = 'start';
    updateTimerDisplay(timerState.startTime, 'start');
  } else {
    timerState.pausedDisplay = 'elapsed';
    updateTimerDisplay(timerState.timestamps, 'elapsed');
  }
}

function updateTimerDisplay(value, mode) {
  if (mode === 'reset') {
    timerBtn.textContent = '00:00:00';
  } else if (mode === 'start') {
    // Display start time (timestamp)
    const startDate = new Date(value);
    const hours = startDate.getHours().toString().padStart(2, '0');
    const minutes = startDate.getMinutes().toString().padStart(2, '0');
    const seconds = startDate.getSeconds().toString().padStart(2, '0');
    timerBtn.textContent = `Start: ${hours}:${minutes}:${seconds}`;
  } else if (mode === 'elapsed') {
    // Display elapsed time (milliseconds)
    const totalSeconds = Math.floor(value / 1000);
    const hours = Math.floor(totalSeconds / 3600).toString().padStart(2, '0');
    const minutes = Math.floor((totalSeconds % 3600) / 60).toString().padStart(2, '0');
    const secs = (totalSeconds % 60).toString().padStart(2, '0');
    timerBtn.textContent = `Time: ${hours}:${minutes}:${secs}`;
  }
}

function updateTimerState(state) {
  timerBtn.classList.remove('reset', 'running', 'paused');
  timerBtn.classList.add(state);
  timerBtn.disabled = false;
}

function updateScrcpyButtonState(state) {
  if (!scrcpyBtn) return;
  
  scrcpyState = state;
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
  if (devices.length === 0) {
    deviceStatusEl.textContent = '无设备连接';
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

  // Single device mode - use the first (and only) device
  const device = devices[0];
  deviceStatusEl.textContent = `已连接: ${device}`;
  
  // If this is a new device connection
  if (!currentDevice || currentDevice !== device) {
    currentDevice = device;
    timerBtn.disabled = false;
    
    // Initialize timer state
    if (timerState.state === 'reset') {
      updateTimerDisplay(0, 'reset');
      updateTimerState('reset');
    }
    
    // Initialize scrcpy state
    updateScrcpyButtonState('stopped');
    
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
  
  // 只有当更新的是当前设备时，才同步状态
  if (deviceId === currentDevice) {
    updateScrcpyButtonState(state);
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
  deviceStatusEl = document.getElementById('device-status');
  scrcpyBtn = document.getElementById('scrcpy-btn');
  
  // 初始化 scrcpy 按钮默认状态
  if (scrcpyBtn) {
    updateScrcpyButtonState('stopped');
  }
  
  // 初始化 timer 显示
  updateTimerDisplay(0, 'reset');
  
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
      updateScrcpyButtonState('running');
    });
  }
  
  if (stopScrcpyBtn) {
    stopScrcpyBtn.addEventListener('click', () => {
      // 停止所有 scrcpy
      window.electronAPI.stopScrcpy();
      // 更新状态
      updateScrcpyButtonState('stopped');
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

// window.testTimerRunning30Min = () => {
//   currentDevice = 'test-device';
//   const startTime = Date.now() - (30 * 60 * 1000); // 30 minutes ago
//   timerState.timestamps = startTime;
//   timerState.startTime = startTime;
//   timerState.state = 'running';
//   updateTimerState('running');
//   updateTimerDisplay(startTime, 'start');
  
//   if (timerInterval) clearInterval(timerInterval);
//   timerInterval = setInterval(() => {
//     updateTimerDisplay(timerState.startTime, 'start');
//   }, 1000);
  
//   console.log('✓ Timer set to RUNNING state (started 30 minutes ago)');
//   console.log(`  Start time: ${new Date(startTime).toLocaleTimeString()}`);
// };

// console.log('Test function loaded: testTimerRunning30Min()');