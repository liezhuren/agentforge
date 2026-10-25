@echo off
setlocal
cd /d "%~dp0"
title AgentForge console

echo ============================================================
echo  AgentForge - console
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found on PATH.
  echo         Install Node.js 24 or newer:  https://nodejs.org/
  echo.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -v') do set NODEVER=%%v
echo [OK] Node %NODEVER%
echo.

if not exist "apps\web\dist\index.html" (
  echo [INFO] Frontend bundle is missing - building now ^(needs network once^)...
  pushd apps\web
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed. No network? Copy the whole folder from the
    echo         machine where it already works ^(it must include apps\web\dist^).
    popd
    pause
    exit /b 1
  )
  call npm run build
  if errorlevel 1 (
    echo [ERROR] npm run build failed.
    popd
    pause
    exit /b 1
  )
  popd
  echo [OK] Frontend built.
  echo.
)

echo [INFO] Starting console on http://127.0.0.1:7788
echo        Keep this window open. Press Ctrl+C to stop.
echo.
start "" http://127.0.0.1:7788
node packages\server\src\cli.ts --port 7788

echo.
echo [INFO] Server stopped.
pause
