@echo off
rem One-click launcher (ASCII-only) for DESKTOP mode (trio: Airui/Qianxia/Nangong).
rem First run auto-installs dependencies.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install from https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo First run: installing dependencies, please wait 1-2 minutes...
  call npm install 2>nul
  if not exist "node_modules\electron\dist\electron.exe" (
    echo Downloading Electron runtime from npmmirror...
    set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
    node "node_modules\electron\install.js"
  )
  if not exist "node_modules\electron\dist\electron.exe" (
    echo [ERROR] Electron download failed. Check network and retry.
    pause
    exit /b 1
  )
)

if exist "shot.png" del /q "shot.png" >nul 2>nul

echo Dreaming Angels are coming...
set "QX_MODE=desktop"
rem uncomment the next line if you want them to stay behind other windows:
rem set "QX_NOTOP=1"
start "" "node_modules\electron\dist\electron.exe" .
endlocal
exit /b 0
