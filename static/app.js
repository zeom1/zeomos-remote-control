// WebSocket URLs
const wsProto = window.location.protocol === "https:" ? "wss:" : "ws:";
const controlWsUrl = `${wsProto}//${window.location.host}/ws/control`;
const screencastWsUrl = `${wsProto}//${window.location.host}/ws/screencast`;

let controlSocket = null;
let screencastSocket = null;
let isAuthenticated = false;

// Screencast settings
let isStreaming = false;
let castScale = 0.5;
let castQuality = 50;

// Trackpad variables
let lastTouchX = 0;
let lastTouchY = 0;
let isTouchMoving = false;
let touchStartTime = 0;
let touchStartPos = { x: 0, y: 0 };
let tapTimer = null;
let lastTapTime = 0;
let isTwoFingerScroll = false;
let startScrollY = 0;
let sensitivity = 1.3;

// DOM Elements
const authOverlay = document.getElementById("auth-overlay");
const appContainer = document.getElementById("app-container");
const pinInputs = document.querySelectorAll(".pin-digit");
const btnConnect = document.getElementById("btn-connect");
const authError = document.getElementById("auth-error");
const connStatus = document.getElementById("conn-status");
const connStatusMobile = document.getElementById("conn-status-mobile");
const deviceName = document.getElementById("device-name");
const hwAlert = document.getElementById("hw-alert");
const hwAlertMsg = document.getElementById("hw-alert-msg");
const hwAlertClose = document.getElementById("hw-alert-close");
const shutdownOverlay = document.getElementById("shutdown-overlay");
const countdownVal = document.getElementById("countdown-val");

/* --- INITIALIZATION --- */

document.addEventListener("DOMContentLoaded", () => {
    // Force delete old PIN cache for strict reload security
    localStorage.removeItem("zos_remote_pin");
    
    initializeTheme();
    setupTabNavigation();
    setupPinInputs();
    setupTouchTrackpad();
    setupControlActions();
    setupScreencastControls();
    setupHardwareControls();
});

/* --- PREMIUM THEME TOGGLE & PERSISTENCE --- */

function initializeTheme() {
    const btnThemeToggle = document.getElementById("btn-theme-toggle");
    const btnThemeToggleMobile = document.getElementById("btn-theme-toggle-mobile");
    
    // Load saved theme or default to dark-mode
    const savedTheme = localStorage.getItem("zos_theme") || "dark-mode";
    document.body.className = savedTheme;
    
    const toggleFunc = () => {
        if (document.body.classList.contains("dark-mode")) {
            document.body.className = "light-mode";
            localStorage.setItem("zos_theme", "light-mode");
        } else {
            document.body.className = "dark-mode";
            localStorage.setItem("zos_theme", "dark-mode");
        }
    };
    
    btnThemeToggle.addEventListener("click", toggleFunc);
    btnThemeToggleMobile.addEventListener("click", toggleFunc);
}

/* --- TAB ROUTING COORDINATION (DESKTOP & MOBILE) --- */

function setupTabNavigation() {
    const desktopTabs = document.querySelectorAll(".sidebar-nav .nav-tab");
    const mobileTabs = document.querySelectorAll(".mobile-nav .mobile-nav-tab");
    const contents = document.querySelectorAll(".grid-content .grid-card-wrapper");
    
    const switchTab = (tabId) => {
        // Sync active states on desktop sidebar
        desktopTabs.forEach(t => {
            if (t.dataset.tab === tabId) t.classList.add("active");
            else t.classList.remove("active");
        });
        
        // Sync active states on mobile nav bar
        mobileTabs.forEach(t => {
            if (t.dataset.tab === tabId) t.classList.add("active");
            else t.classList.remove("active");
        });
        
        // Sync visibility on mobile contents (desktop CSS ignores grid-card-wrapper hidden)
        contents.forEach(c => {
            if (c.id === tabId) c.classList.add("active");
            else c.classList.remove("active");
        });
        
        // Auto-stop screencast if switching away from screen tab
        if (tabId !== "screen-tab" && isStreaming) {
            toggleScreencast(false);
        }
    };
    
    desktopTabs.forEach(tab => {
        tab.addEventListener("click", () => switchTab(tab.dataset.tab));
    });
    
    mobileTabs.forEach(tab => {
        tab.addEventListener("click", () => switchTab(tab.dataset.tab));
    });
}

/* --- SECURE PIN CODE INPUT HANDLERS --- */

function setupPinInputs() {
    pinInputs.forEach((input, index) => {
        input.addEventListener("input", () => {
            if (input.value.length === 1 && index < pinInputs.length - 1) {
                pinInputs[index + 1].focus();
            }
        });
        
        input.addEventListener("keydown", (e) => {
            if (e.key === "Backspace" && input.value.length === 0 && index > 0) {
                pinInputs[index - 1].focus();
            }
        });
        
        input.addEventListener("keypress", (e) => {
            if (e.key === "Enter" && index === pinInputs.length - 1) {
                btnConnect.click();
            }
        });
    });
    
    btnConnect.addEventListener("click", () => {
        let pin = "";
        pinInputs.forEach(input => pin += input.value);
        
        if (pin.length === 4) {
            connectToControlServer(pin);
        } else {
            showAuthError("Please fill all 4 digits.");
        }
    });
}

function showAuthError(msg) {
    authError.innerText = msg;
    authError.style.display = "block";
    const card = document.querySelector(".auth-card");
    card.style.transform = "scale(0.96)";
    setTimeout(() => card.style.transform = "scale(1.02)", 75);
    setTimeout(() => card.style.transform = "scale(0.98)", 150);
    setTimeout(() => card.style.transform = "scale(1)", 220);
}

/* --- SOCKET COMMUNICATIONS --- */

function connectToControlServer(pin) {
    try {
        controlSocket = new WebSocket(controlWsUrl);
        
        controlSocket.onopen = () => {
            controlSocket.send(JSON.stringify({
                action: "auth",
                pin: pin
            }));
        };
        
        controlSocket.onmessage = (event) => {
            const data = JSON.parse(event.data);
            
            if (data.type === "auth_status") {
                if (data.status === "success") {
                    isAuthenticated = true;
                    deviceName.innerText = data.hostname || "LAPTOP";
                    
                    // Update connection DOM indicators
                    connStatus.classList.remove("offline");
                    connStatus.classList.add("online");
                    connStatus.querySelector(".status-label").innerText = "CONNECTED";
                    connStatusMobile.classList.remove("offline");
                    connStatusMobile.classList.add("online");
                    
                    // Hide auth overlay and show app dashboard
                    authOverlay.classList.add("hidden");
                    appContainer.classList.remove("hidden");
                    
                    // Sync hardware toggles to initial server states
                    syncHardwareUI(data.wifi, data.bluetooth);
                } else {
                    showAuthError(data.message || "Failed Authentication.");
                }
            } else if (data.type === "metrics") {
                updateDashboardTelemetry(data);
            } else if (data.type === "hardware_status") {
                syncHardwareUI(data.wifi, data.bluetooth);
                if (data.success_message) {
                    showHardwareSuccess(data.success_message);
                }
            } else if (data.type === "hardware_toggle_loading") {
                showHardwareLoading(data.device);
            } else if (data.type === "hardware_error") {
                syncHardwareUI(data.wifi, data.bluetooth);
                showHardwareError(data.message);
            } else if (data.type === "shutdown_tick") {
                showShutdownCountdown(data.seconds);
            } else if (data.type === "shutdown_cancelled") {
                hideShutdownCountdown();
            }
        };
        
        controlSocket.onclose = () => {
            handleDisconnect();
        };
        
        controlSocket.onerror = (err) => {
            console.error("Control socket error", err);
        };
        
    } catch (e) {
        console.error("Socket error", e);
    }
}

function handleDisconnect() {
    isAuthenticated = false;
    
    // Status styles to offline
    connStatus.classList.remove("online");
    connStatus.classList.add("offline");
    connStatus.querySelector(".status-label").innerText = "DISCONNECTED";
    connStatusMobile.classList.remove("online");
    connStatusMobile.classList.add("offline");
    
    // Show auth overlay
    authOverlay.classList.remove("hidden");
    appContainer.classList.add("hidden");
    
    // Reset inputs
    pinInputs.forEach(i => i.value = "");
    pinInputs[0].focus();
    
    if (isStreaming) {
        toggleScreencast(false);
    }
}

function sendControlMessage(msg) {
    if (controlSocket && controlSocket.readyState === WebSocket.OPEN && isAuthenticated) {
        controlSocket.send(JSON.stringify(msg));
    }
}

/* --- HARDWARE SWITCHES CONTROLS PANEL --- */

function setupHardwareControls() {
    const wifiToggle = document.getElementById("wifi-toggle");
    const btToggle = document.getElementById("bt-toggle");
    
    wifiToggle.addEventListener("change", () => {
        sendControlMessage({
            action: "toggle_hardware",
            device: "wifi",
            state: wifiToggle.checked
        });
    });
    
    btToggle.addEventListener("change", () => {
        sendControlMessage({
            action: "toggle_hardware",
            device: "bluetooth",
            state: btToggle.checked
        });
    });
    
    hwAlertClose.addEventListener("click", () => {
        hwAlert.classList.add("hidden");
    });
}

function syncHardwareUI(wifi, bluetooth) {
    const wifiToggle = document.getElementById("wifi-toggle");
    const btToggle = document.getElementById("bt-toggle");
    const wifiStatus = document.getElementById("wifi-status");
    const btStatus = document.getElementById("bt-status");
    const wifiIcon = document.getElementById("wifi-icon");
    const btIcon = document.getElementById("bt-icon");
    const wifiSpinner = document.getElementById("wifi-spinner");
    const btSpinner = document.getElementById("bt-spinner");
    
    // Hide spinners
    wifiSpinner.classList.add("hidden");
    btSpinner.classList.add("hidden");
    
    // Set checked states
    wifiToggle.checked = wifi;
    btToggle.checked = bluetooth;
    
    // Update labels and colors
    wifiStatus.innerText = wifi ? "Connected" : "Disabled";
    wifiStatus.style.color = wifi ? "var(--success)" : "var(--text-muted)";
    if (wifi) wifiIcon.classList.add("active");
    else wifiIcon.classList.remove("active");
    
    btStatus.innerText = bluetooth ? "Active" : "Inactive";
    btStatus.style.color = bluetooth ? "var(--success)" : "var(--text-muted)";
    if (bluetooth) btIcon.classList.add("active");
    else btIcon.classList.remove("active");
}

function showHardwareLoading(device) {
    if (device === "wifi") {
        document.getElementById("wifi-spinner").classList.remove("hidden");
    } else if (device === "bluetooth") {
        document.getElementById("bt-spinner").classList.remove("hidden");
    }
}

function showHardwareSuccess(msg) {
    // Optional ambient notification could log success, but usually visual toggle is enough.
    console.info("Hardware event success: ", msg);
}

function showHardwareError(msg) {
    hwAlertMsg.innerText = msg;
    hwAlert.classList.remove("hidden");
    
    // Auto fade error alert toast after 6 seconds
    setTimeout(() => {
        hwAlert.classList.add("hidden");
    }, 6000);
}

/* --- 30s COUNTDOWN TIMER CONTROLLER --- */

function showShutdownCountdown(seconds) {
    shutdownOverlay.classList.remove("hidden");
    countdownVal.innerText = seconds;
}

function hideShutdownCountdown() {
    shutdownOverlay.classList.add("hidden");
}

/* --- EXPANDED METRICS DISPLAY --- */

function updateDashboardTelemetry(data) {
    // Progress tele bars updates
    updateProgressWidget("tele-cpu-progress", "tele-cpu-val", Math.round(data.cpu));
    updateProgressWidget("tele-ram-progress", "tele-ram-val", Math.round(data.ram));
    updateProgressWidget("tele-disk-progress", "tele-disk-val", Math.round(data.disk));
    updateProgressWidget("tele-bat-progress", "tele-bat-val", Math.round(data.battery));
    
    // Battery charging icons
    const batLabel = document.getElementById("tele-bat-label");
    if (data.power_plugged) {
        batLabel.innerHTML = `<i class="fa-solid fa-bolt" style="color: var(--success);"></i> Charging`;
    } else {
        batLabel.innerHTML = `<i class="fa-solid fa-battery-three-quarters"></i> Battery`;
    }
    
    // Active Focused window
    document.getElementById("active-window-title").innerText = data.active_window;
    
    // Detailed stats uptime formatting
    const uptimeSeconds = data.uptime || 0;
    const hours = Math.floor(uptimeSeconds / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);
    document.getElementById("detail-uptime").innerText = `${hours}h ${minutes}m`;
    
    // Detailed network telemetry (bytes to megabytes)
    const txMB = (data.net_sent / (1024 * 1024)).toFixed(1);
    const rxMB = (data.net_recv / (1024 * 1024)).toFixed(1);
    document.getElementById("detail-network").innerText = `${txMB} MB ↑ | ${rxMB} MB ↓`;
}

function updateProgressWidget(barId, valId, pct) {
    const bar = document.getElementById(barId);
    const textVal = document.getElementById(valId);
    if (!bar || !textVal) return;
    
    bar.style.width = `${pct}%`;
    textVal.innerText = `${pct}%`;
}

/* --- INTERACTIVE TOUCH TRACKPAD gestures ENGINE --- */

function setupTouchTrackpad() {
    const trackpad = document.getElementById("trackpad");
    const cursorFeedback = document.getElementById("trackpad-cursor");
    
    trackpad.addEventListener("touchstart", (e) => {
        isTouchMoving = false;
        isTwoFingerScroll = false;
        touchStartTime = Date.now();
        
        const touches = e.touches;
        
        if (touches.length === 1) {
            lastTouchX = touches[0].clientX;
            lastTouchY = touches[0].clientY;
            touchStartPos.x = touches[0].clientX;
            touchStartPos.y = touches[0].clientY;
            
            // Show tactile ring feedback
            cursorFeedback.style.left = `${touches[0].clientX - trackpad.getBoundingClientRect().left}px`;
            cursorFeedback.style.top = `${touches[0].clientY - trackpad.getBoundingClientRect().top}px`;
            cursorFeedback.style.transform = "translate(-50%, -50%) scale(1)";
            cursorFeedback.style.opacity = "1";
        } else if (touches.length === 2) {
            isTwoFingerScroll = true;
            startScrollY = (touches[0].clientY + touches[1].clientY) / 2;
        }
    });
    
    trackpad.addEventListener("touchmove", (e) => {
        const touches = e.touches;
        
        if (touches.length === 1 && !isTwoFingerScroll) {
            const currentX = touches[0].clientX;
            const currentY = touches[0].clientY;
            
            let dx = currentX - lastTouchX;
            let dy = currentY - lastTouchY;
            
            const displacement = Math.sqrt(
                Math.pow(currentX - touchStartPos.x, 2) + 
                Math.pow(currentY - touchStartPos.y, 2)
            );
            
            if (displacement > 4) {
                isTouchMoving = true;
            }
            
            // Speed dynamic acceleration
            const distance = Math.sqrt(dx * dx + dy * dy);
            let accel = 1.0;
            if (distance > 8) accel = 1.3;
            if (distance > 18) accel = 1.8;
            
            sendControlMessage({
                action: "mouse_move",
                dx: Math.round(dx * sensitivity * accel),
                dy: Math.round(dy * sensitivity * accel)
            });
            
            lastTouchX = currentX;
            lastTouchY = currentY;
            
            cursorFeedback.style.left = `${currentX - trackpad.getBoundingClientRect().left}px`;
            cursorFeedback.style.top = `${currentY - trackpad.getBoundingClientRect().top}px`;
        } else if (touches.length === 2 && isTwoFingerScroll) {
            const currentScrollY = (touches[0].clientY + touches[1].clientY) / 2;
            const scrollDiff = currentScrollY - startScrollY;
            
            if (Math.abs(scrollDiff) > 8) {
                const scrollAmount = scrollDiff > 0 ? 120 : -120;
                sendControlMessage({
                    action: "mouse_scroll",
                    amount: scrollAmount
                });
                startScrollY = currentScrollY;
            }
        }
    });
    
    trackpad.addEventListener("touchend", (e) => {
        cursorFeedback.style.transform = "translate(-50%, -50%) scale(0)";
        cursorFeedback.style.opacity = "0";
        
        if (!isTouchMoving && !isTwoFingerScroll) {
            const tapDuration = Date.now() - touchStartTime;
            
            if (tapDuration < 250) {
                const currentTime = Date.now();
                const timeDiff = currentTime - lastTapTime;
                
                if (timeDiff < 300) {
                    clearTimeout(tapTimer);
                    sendControlMessage({ action: "mouse_double_click" });
                    lastTapTime = 0;
                } else {
                    lastTapTime = currentTime;
                    tapTimer = setTimeout(() => {
                        sendControlMessage({ action: "mouse_click", button: "left" });
                    }, 180);
                }
            }
        }
    });
    
    // Explicit clicks
    document.getElementById("btn-left-click").addEventListener("click", () => {
        sendControlMessage({ action: "mouse_click", button: "left" });
    });
    
    document.getElementById("btn-right-click").addEventListener("click", () => {
        sendControlMessage({ action: "mouse_click", button: "right" });
    });
}

/* --- KEYBOARD PANEL ACTIONS --- */

function setupControlActions() {
    const textInput = document.getElementById("text-input");
    const btnSendText = document.getElementById("btn-send-text");
    
    btnSendText.addEventListener("click", () => {
        const text = textInput.value;
        if (text) {
            sendControlMessage({ action: "type_text", text: text });
            textInput.value = "";
        }
    });
    
    textInput.addEventListener("keypress", (e) => {
        if (e.key === "Enter") {
            btnSendText.click();
        }
    });
    
    const keyButtons = document.querySelectorAll(".key-btn");
    keyButtons.forEach(btn => {
        btn.addEventListener("click", () => {
            sendControlMessage({
                action: "key_press",
                key: btn.dataset.key
            });
        });
    });
    
    // Volume adjustments
    document.getElementById("vol-up").addEventListener("click", () => {
        sendControlMessage({ action: "system_command", command: "volume_up" });
    });
    
    document.getElementById("vol-down").addEventListener("click", () => {
        sendControlMessage({ action: "system_command", command: "volume_down" });
    });
    
    document.getElementById("vol-mute").addEventListener("click", () => {
        sendControlMessage({ action: "system_command", command: "volume_mute" });
    });
    
    // Playbacks deck
    document.getElementById("media-play").addEventListener("click", (e) => {
        sendControlMessage({ action: "system_command", command: "play_pause" });
        const icon = e.currentTarget.querySelector("i");
        icon.classList.toggle("fa-play");
        icon.classList.toggle("fa-pause");
    });
    
    document.getElementById("media-prev").addEventListener("click", () => {
        sendControlMessage({ action: "system_command", command: "prev_track" });
    });
    
    document.getElementById("media-next").addEventListener("click", () => {
        sendControlMessage({ action: "system_command", command: "next_track" });
    });
    
    // App Launchers click bindings
    const appBtns = document.querySelectorAll(".launch-btn");
    appBtns.forEach(btn => {
        btn.addEventListener("click", () => {
            sendControlMessage({
                action: "launch_app",
                app: btn.dataset.app
            });
        });
    });
    
    // Reworked Power Management Click Bindings
    document.getElementById("power-lock").addEventListener("click", () => {
        sendControlMessage({ action: "system_command", command: "lock_screen" });
    });
    
    document.getElementById("power-sleep").addEventListener("click", () => {
        sendControlMessage({ action: "system_command", command: "sleep" });
    });
    
    document.getElementById("power-shutdown").addEventListener("click", () => {
        sendControlMessage({ action: "system_command", command: "shutdown" });
    });
    
    // Countdown Timer Action Bindings (Reset, Cancel)
    document.getElementById("btn-restart-timer").addEventListener("click", () => {
        sendControlMessage({ action: "system_command", command: "restart_shutdown_timer" });
    });
    
    document.getElementById("btn-abort-shutdown").addEventListener("click", () => {
        sendControlMessage({ action: "system_command", command: "cancel_shutdown" });
    });
}

/* --- SCREEN CAST TIMELAPSE STREAM ENGINE --- */

function setupScreencastControls() {
    const btnToggleCast = document.getElementById("btn-toggle-cast");
    const castScaleInput = document.getElementById("cast-scale");
    const castQualityInput = document.getElementById("cast-quality");
    const scaleValue = document.getElementById("scale-value");
    const qualityValue = document.getElementById("quality-value");
    
    castScaleInput.addEventListener("input", () => {
        castScale = parseFloat(castScaleInput.value);
        scaleValue.innerText = `${Math.round(castScale * 100)}%`;
    });
    
    castQualityInput.addEventListener("input", () => {
        castQuality = parseInt(castQualityInput.value);
        qualityValue.innerText = `${castQuality}%`;
    });
    
    btnToggleCast.addEventListener("click", () => {
        toggleScreencast(!isStreaming);
    });
}

function toggleScreencast(active) {
    const btnToggleCast = document.getElementById("btn-toggle-cast");
    const loader = document.getElementById("screen-loader");
    
    isStreaming = active;
    
    if (active) {
        btnToggleCast.classList.add("btn-danger");
        btnToggleCast.classList.remove("btn-primary");
        btnToggleCast.querySelector("i").className = "fa-solid fa-stop";
        btnToggleCast.querySelector("span").innerText = "Stop Stream";
        loader.classList.remove("hidden");
        
        initializeScreencastSocket();
    } else {
        btnToggleCast.classList.remove("btn-danger");
        btnToggleCast.classList.add("btn-primary");
        btnToggleCast.querySelector("i").className = "fa-solid fa-play";
        btnToggleCast.querySelector("span").innerText = "Start Stream";
        loader.classList.add("hidden");
        
        if (screencastSocket) {
            screencastSocket.close();
            screencastSocket = null;
        }
        
        const canvas = document.getElementById("screen-canvas");
        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
}

function initializeScreencastSocket() {
    if (screencastSocket) return;
    
    screencastSocket = new WebSocket(screencastWsUrl);
    screencastSocket.binaryType = "blob";
    
    const canvas = document.getElementById("screen-canvas");
    const ctx = canvas.getContext("2d");
    const loader = document.getElementById("screen-loader");
    
    screencastSocket.onopen = () => {
        loader.classList.add("hidden");
        requestNextFrame();
    };
    
    screencastSocket.onmessage = (event) => {
        if (!isStreaming) return;
        
        if (event.data instanceof Blob) {
            const url = URL.createObjectURL(event.data);
            const img = new Image();
            
            img.onload = () => {
                canvas.width = img.width;
                canvas.height = img.height;
                ctx.drawImage(img, 0, 0);
                URL.revokeObjectURL(url);
                
                if (isStreaming) requestNextFrame();
            };
            
            img.onerror = () => {
                URL.revokeObjectURL(url);
                if (isStreaming) requestNextFrame();
            };
            
            img.src = url;
        } else {
            const data = JSON.parse(event.data);
            if (data.type === "error") {
                console.error("Screencast error: ", data.message);
                if (isStreaming) setTimeout(requestNextFrame, 1000);
            }
        }
    };
    
    screencastSocket.onclose = () => {
        if (isStreaming) {
            setTimeout(() => {
                if (isStreaming) {
                    screencastSocket = null;
                    initializeScreencastSocket();
                }
            }, 1000);
        }
    };
    
    screencastSocket.onerror = (err) => {
        console.error("Screencast socket error: ", err);
    };
}

function requestNextFrame() {
    if (screencastSocket && screencastSocket.readyState === WebSocket.OPEN && isStreaming) {
        screencastSocket.send(JSON.stringify({
            quality: castQuality,
            scale: castScale
        }));
    }
}
