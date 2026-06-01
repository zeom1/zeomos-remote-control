@echo off
title ZeomOS Server
color 0b

echo ==================================================
echo             ZEOMOS - ONE-CLICK LAUNCHER
echo ==================================================
echo.
echo [1/2] Switching to project directory...
cd /d "%~dp0"

echo [2/2] Launching Python FastAPI server...
echo.
.\venv\Scripts\python.exe server.py

if %errorlevel% neq 0 (
    echo.
    color 0c
    echo [ERROR] Server failed to start!
    echo Please make sure your virtual environment and server.py are in D:\projects\remote-control-app.
    echo.
    pause
)
