@echo off
title Porthole WebRTC Runner
echo ========================================================
echo   PORTHOLE - P2P REMOTE DESKTOP
echo ========================================================
echo.
echo [1/3] Starting Host Agent (local input executor)...
start "Porthole Host Agent" python host_agent.py

timeout /t 1 >nul

echo [2/3] Starting Signaling and Web Server on port 8000...
start "Porthole Server" python server.py

timeout /t 2 >nul

echo [3/3] Launching Public HTTPS Tunnel via Pinggy...
echo ========================================================
echo Use the HTTPS link below to open Porthole from any device.
echo ========================================================
ssh -p 443 -o StrictHostKeyChecking=no -R0:localhost:8000 a.pinggy.io
pause
