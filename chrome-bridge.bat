@echo off
REM Page Grabber - Chrome Debug Bridge
REM Launches Chrome with remote debugging and tunnels to VPS
REM Usage: Double-click this file or run from PowerShell

echo Starting Chrome with remote debugging on port 9333...
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9333

echo.
echo Chrome is running with debug port 9333.
echo Now tunneling to VPS...
echo (Keep this window open while you want Claude to have access)
echo.
echo Press Ctrl+C to disconnect.

ssh -R 9333:localhost:9333 kingdev@powertop.chakrakali.com
