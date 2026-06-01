import os
import sys
import time
import socket
import asyncio
import random
import logging
import subprocess
from io import BytesIO
from typing import Set

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse
from PIL import ImageGrab, Image
import pyautogui
import psutil
import qrcode

# Configure logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger("RemoteControlServer")

# PyAutoGUI Optimizations for low latency
pyautogui.PAUSE = 0
pyautogui.FAILSAFE = False

app = FastAPI(title="Remote Control Server")

# Global Security & State Settings
PIN = "".join([str(random.randint(0, 9)) for _ in range(4)])
authenticated_clients: Set[str] = set()
active_connections: Set[WebSocket] = set()

# Hardware Control States
wifi_state = False
bluetooth_state = False

# Shutdown Timer State
shutdown_task: asyncio.Task = None
shutdown_seconds = 30

# Discover the active local network IP address
def get_local_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
    except Exception:
        ip = "127.0.0.1"
    finally:
        s.close()
    return ip

LOCAL_IP = get_local_ip()
PORT = 8000

# Helper to capture and compress screen
def capture_screen(quality: int = 60, scale_factor: float = 0.5) -> bytes:
    try:
        screenshot = ImageGrab.grab()
        if scale_factor < 1.0:
            new_size = (int(screenshot.width * scale_factor), int(screenshot.height * scale_factor))
            screenshot = screenshot.resize(new_size, Image.Resampling.LANCZOS if hasattr(Image, "Resampling") else 1)
        buffer = BytesIO()
        screenshot.save(buffer, format="WebP", quality=quality)
        return buffer.getvalue()
    except Exception as e:
        logger.error(f"Error capturing screen: {e}")
        return b""

# Hardware Toggles logic
def get_wifi_status() -> bool:
    try:
        script_path = os.path.join(os.path.dirname(__file__), "scripts", "get_radios.ps1")
        output = subprocess.check_output(
            f'powershell -ExecutionPolicy Bypass -File "{script_path}"',
            shell=True,
            text=True,
            errors="ignore"
        )
        for line in output.split('\n'):
            if "WiFi" in line and "On" in line:
                return True
        return False
    except Exception:
        return False

def get_bluetooth_status() -> bool:
    try:
        script_path = os.path.join(os.path.dirname(__file__), "scripts", "get_radios.ps1")
        output = subprocess.check_output(
            f'powershell -ExecutionPolicy Bypass -File "{script_path}"',
            shell=True,
            text=True,
            errors="ignore"
        )
        for line in output.split('\n'):
            if "Bluetooth" in line and "On" in line:
                return True
        return False
    except Exception:
        return False

async def toggle_wifi(enable: bool):
    state_str = "On" if enable else "Off"
    script_path = os.path.join(os.path.dirname(__file__), "scripts", "toggle_radio.ps1")
    cmd = f'powershell -ExecutionPolicy Bypass -File "{script_path}" -RadioKind WiFi -State {state_str}'
    try:
        res = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        if res.returncode != 0 or "Success" not in res.stdout:
            # Fallback to elevated popping if needed
            elevated_cmd = f'powershell -Command "Start-Process powershell -ArgumentList \\"-ExecutionPolicy Bypass -File \\\\\\\'{script_path}\\\\\\\' -RadioKind WiFi -State {state_str}\\" -Verb RunAs -WindowStyle Hidden"'
            res_elevated = subprocess.run(elevated_cmd, shell=True, capture_output=True, text=True)
            if res_elevated.returncode != 0:
                raise PermissionError("UAC / Administrator privileges required to change Wi-Fi state.")
    except Exception as e:
        raise PermissionError(f"Failed to toggle Wi-Fi: {e}")

async def toggle_bluetooth(enable: bool):
    state_str = "On" if enable else "Off"
    script_path = os.path.join(os.path.dirname(__file__), "scripts", "toggle_radio.ps1")
    cmd = f'powershell -ExecutionPolicy Bypass -File "{script_path}" -RadioKind Bluetooth -State {state_str}'
    try:
        res = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        if res.returncode != 0 or "Success" not in res.stdout:
            # Fallback to elevated popping if needed
            elevated_cmd = f'powershell -Command "Start-Process powershell -ArgumentList \\"-ExecutionPolicy Bypass -File \\\\\\\'{script_path}\\\\\\\' -RadioKind Bluetooth -State {state_str}\\" -Verb RunAs -WindowStyle Hidden"'
            res_elevated = subprocess.run(elevated_cmd, shell=True, capture_output=True, text=True)
            if res_elevated.returncode != 0:
                raise PermissionError("UAC / Administrator privileges required to change Bluetooth state.")
    except Exception as e:
        raise PermissionError(f"Failed to toggle Bluetooth: {e}")

# Shutdown Countdown Task
async def shutdown_countdown_loop():
    global shutdown_seconds, shutdown_task
    try:
        while shutdown_seconds > 0:
            payload = {
                "type": "shutdown_tick",
                "seconds": shutdown_seconds
            }
            tasks = [connection.send_json(payload) for connection in active_connections]
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
                
            await asyncio.sleep(1)
            shutdown_seconds -= 1
            
        # Reached 0 - Execute immediate shutdown
        logger.info("Shutdown timer reached 0! Shutting down system...")
        os.system("shutdown /s /t 0")
    except asyncio.CancelledError:
        logger.info("Shutdown countdown aborted.")
        payload = {"type": "shutdown_cancelled"}
        tasks = [connection.send_json(payload) for connection in active_connections]
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
    finally:
        shutdown_task = None

@app.websocket("/ws/control")
async def websocket_control_endpoint(websocket: WebSocket):
    global PIN, shutdown_task, shutdown_seconds
    await websocket.accept()
    client_id = f"{websocket.client.host}:{websocket.client.port}"
    logger.info(f"Client connected to control WS: {client_id}")
    
    is_authenticated = False
    
    try:
        while True:
            data = await websocket.receive_json()
            action = data.get("action")
            
            # Authentication check
            if not is_authenticated:
                if action == "auth":
                    client_pin = data.get("pin")
                    if client_pin == PIN:
                        is_authenticated = True
                        authenticated_clients.add(client_id)
                        active_connections.add(websocket)
                        await websocket.send_json({
                            "type": "auth_status", 
                            "status": "success", 
                            "hostname": socket.gethostname(),
                            "wifi": get_wifi_status(),
                            "bluetooth": get_bluetooth_status()
                        })
                        logger.info(f"Client {client_id} successfully authenticated.")
                    else:
                        await websocket.send_json({"type": "auth_status", "status": "fail", "message": "Incorrect PIN"})
                        logger.warning(f"Failed authentication attempt from {client_id} with PIN {client_pin}")
                        await websocket.close()
                        break
                continue
                
            try:
                # Perform controls once authenticated
                if action == "mouse_move":
                    dx = int(data.get("dx", 0))
                    dy = int(data.get("dy", 0))
                    pyautogui.move(dx, dy)
                    
                elif action == "mouse_click":
                    button = data.get("button", "left")
                    pyautogui.click(button=button)
                    
                elif action == "mouse_double_click":
                    pyautogui.doubleClick()
                    
                elif action == "mouse_down":
                    button = data.get("button", "left")
                    pyautogui.mouseDown(button=button)
                    
                elif action == "mouse_up":
                    button = data.get("button", "left")
                    pyautogui.mouseUp(button=button)
                    
                elif action == "mouse_scroll":
                    amount = int(data.get("amount", 0))
                    pyautogui.scroll(amount)
                    
                elif action == "key_press":
                    key = data.get("key")
                    if key:
                        pyautogui.press(key)
                        
                elif action == "type_text":
                    text = data.get("text")
                    if text:
                        pyautogui.write(text)
                        
                elif action == "hotkey":
                    keys = data.get("keys", [])
                    if keys:
                        pyautogui.hotkey(*keys)
                        
                elif action == "system_command":
                    cmd = data.get("command")
                    if cmd == "volume_up":
                        pyautogui.press("volumeup")
                    elif cmd == "volume_down":
                        pyautogui.press("volumedown")
                    elif cmd == "volume_mute":
                        pyautogui.press("volumemute")
                    elif cmd == "play_pause":
                        pyautogui.press("playpause")
                    elif cmd == "next_track":
                        pyautogui.press("nexttrack")
                    elif cmd == "prev_track":
                        pyautogui.press("prevtrack")
                    elif cmd == "lock_screen":
                        os.system("rundll32.exe user32.dll,LockWorkStation")
                    elif cmd == "sleep":
                        os.system("rundll32.exe powrprof.dll,SetSuspendState 0,1,0")
                    elif cmd == "shutdown":
                        if not shutdown_task:
                            shutdown_seconds = 30
                            shutdown_task = asyncio.create_task(shutdown_countdown_loop())
                            logger.info("Shutdown countdown initiated (30s).")
                    elif cmd == "restart_shutdown_timer":
                        if shutdown_task:
                            shutdown_seconds = 30
                            logger.info("Shutdown countdown reset to 30s.")
                            await websocket.send_json({"type": "shutdown_tick", "seconds": 30})
                    elif cmd == "cancel_shutdown":
                        if shutdown_task:
                            shutdown_task.cancel()
                            shutdown_task = None
                            logger.info("Shutdown countdown aborted.")
                            
                elif action == "hardware_status":
                    await websocket.send_json({
                        "type": "hardware_status",
                        "wifi": get_wifi_status(),
                        "bluetooth": get_bluetooth_status()
                    })
                    
                elif action == "toggle_hardware":
                    device = data.get("device")
                    enable = bool(data.get("state"))
                    
                    # Notify loading
                    await websocket.send_json({
                        "type": "hardware_toggle_loading",
                        "device": device
                    })
                    
                    try:
                        if device == "wifi":
                            await toggle_wifi(enable)
                        elif device == "bluetooth":
                            await toggle_bluetooth(enable)
                            
                        # Return success
                        await websocket.send_json({
                            "type": "hardware_status",
                            "wifi": get_wifi_status(),
                            "bluetooth": get_bluetooth_status(),
                            "success_message": f"Successfully toggled {device.upper()}."
                        })
                    except PermissionError as pe:
                        await websocket.send_json({
                            "type": "hardware_error",
                            "device": device,
                            "wifi": get_wifi_status(),
                            "bluetooth": get_bluetooth_status(),
                            "message": str(pe)
                        })
                    except Exception as e:
                        await websocket.send_json({
                            "type": "hardware_error",
                            "device": device,
                            "wifi": get_wifi_status(),
                            "bluetooth": get_bluetooth_status(),
                            "message": f"Toggle error: {e}"
                        })
                        
                elif action == "launch_app":
                    app_name = data.get("app")
                    if app_name == "operagx":
                        # Try standard Opera GX path first
                        gx_path = os.path.expandvars(r"%LOCALAPPDATA%\Programs\Opera GX\launcher.exe")
                        if os.path.exists(gx_path):
                            subprocess.Popen(f'"{gx_path}"')
                        else:
                            subprocess.Popen("start operagx", shell=True)
                    elif app_name == "spotify":
                        subprocess.Popen("start spotify:", shell=True)
                    elif app_name == "explorer":
                        subprocess.Popen("explorer.exe")
                    elif app_name == "settings":
                        subprocess.Popen("start ms-settings:", shell=True)
                    elif app_name == "cmd":
                        subprocess.Popen("start cmd.exe", shell=True)
                        
            except Exception as e:
                logger.error(f"Error executing remote control action '{action}': {e}")
                    
    except WebSocketDisconnect:
        logger.info(f"Client disconnected from control WS: {client_id}")
    except Exception as e:
        logger.error(f"Error in control WebSocket connection: {e}")
    finally:
        authenticated_clients.discard(client_id)
        active_connections.discard(websocket)
        
        # Security: Rotate PIN when last client disconnects or reloads the page
        if not active_connections:
            PIN = "".join([str(random.randint(0, 9)) for _ in range(4)])
            logger.info("*"*50)
            logger.info(" *** CLIENT DISCONNECTED - SECURITY PIN ROTATED *** ")
            logger.info(f" NEW SECURITY PIN: [ {PIN} ]")
            logger.info("*"*50)

@app.websocket("/ws/screencast")
async def websocket_screencast_endpoint(websocket: WebSocket):
    await websocket.accept()
    client_id = f"{websocket.client.host}:{websocket.client.port}"
    logger.info(f"Client connected to screencast WS: {client_id}")
    
    try:
        while True:
            msg = await websocket.receive_json()
            client_ip = websocket.client.host
            is_client_auth = any(auth_client.startswith(client_ip) for auth_client in authenticated_clients)
            
            if not is_client_auth:
                await websocket.send_json({"type": "error", "message": "Unauthorized. Authenticate via main panel first."})
                await asyncio.sleep(1)
                continue
                
            quality = msg.get("quality", 50)
            scale = msg.get("scale", 0.5)
            
            frame_bytes = await asyncio.to_thread(capture_screen, quality, scale)
            if frame_bytes:
                await websocket.send_bytes(frame_bytes)
            else:
                await websocket.send_json({"type": "error", "message": "Screenshot failed"})
                
    except WebSocketDisconnect:
        logger.info(f"Client disconnected from screencast WS: {client_id}")
    except Exception as e:
        logger.error(f"Error in screencast WebSocket connection: {e}")

# Broadcast system metrics in a background task
async def system_metrics_broadcaster():
    while True:
        try:
            if active_connections:
                # Gather metrics
                cpu = psutil.cpu_percent()
                ram = psutil.virtual_memory().percent
                
                # Disk metric
                disk = psutil.disk_usage('/')
                disk_pct = disk.percent
                
                # Network metrics
                net = psutil.net_io_counters()
                net_sent = net.bytes_sent
                net_recv = net.bytes_recv
                
                # Uptime metric
                uptime = int(time.time() - psutil.boot_time())
                
                battery = psutil.sensors_battery()
                battery_pct = 100
                power_plugged = True
                if battery:
                    battery_pct = battery.percent
                    power_plugged = battery.power_plugged
                    
                active_window = "Unknown Window"
                try:
                    active_window = pyautogui.getActiveWindowTitle() or "Desktop / System"
                except Exception:
                    pass
                    
                payload = {
                    "type": "metrics",
                    "cpu": cpu,
                    "ram": ram,
                    "disk": disk_pct,
                    "net_sent": net_sent,
                    "net_recv": net_recv,
                    "uptime": uptime,
                    "battery": battery_pct,
                    "power_plugged": power_plugged,
                    "active_window": active_window
                }
                
                tasks = [connection.send_json(payload) for connection in active_connections]
                if tasks:
                    await asyncio.gather(*tasks, return_exceptions=True)
        except Exception as e:
            logger.error(f"Error gathering metrics: {e}")
            
        await asyncio.sleep(3)

# Hook up startup events
@app.on_event("startup")
async def startup_event():
    logger.info("*"*50)
    logger.info("          *** ZEOMOS SERVER STARTED ***         ")
    logger.info("*"*50)
    logger.info(f"CONNECTION URL: http://{LOCAL_IP}:{PORT}")
    logger.info(f"SECURITY PIN: [ {PIN} ]")
    logger.info("*"*50)
    
    try:
        qr = qrcode.QRCode(version=1, box_size=10, border=4)
        qr.add_data(f"http://{LOCAL_IP}:{PORT}")
        qr.make(fit=True)
        qr_img = qr.make_image(fill_color="black", back_color="white")
        
        static_qr_path = os.path.join(static_dir, "qrcode.png")
        qr_img.save(static_qr_path)
        logger.info(f"Saved connection QR Code image to: {static_qr_path}")
    except Exception as e:
        logger.error(f"Failed to generate/save QR Code image: {e}")
        
    app.state.metrics_task = asyncio.create_task(system_metrics_broadcaster())

# Serve static frontend files
static_dir = os.path.join(os.path.dirname(__file__), "static")
if not os.path.exists(static_dir):
    os.makedirs(static_dir)

app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=PORT, reload=False)
