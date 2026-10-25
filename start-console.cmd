@echo off
setlocal
cd /d "%~dp0"

REM Usage:  start-console.cmd [port]
REM         no argument -> 7788
REM Two consoles side by side:
REM   start-console.cmd 7788   (offline demo)
REM   start-console.cmd 7789   (real LLM)

set PORT=%1
if "%PORT%"=="" set PORT=7788

title AgentForge console %PORT%

echo ============================================================
echo  AgentForge console   port %PORT%
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

if not exist "apps\web\dist\index.html" (
  echo [INFO] Frontend bundle is missing - building now (needs network once)...
  pushd apps\web
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed. No network? Copy the whole folder from the
    echo         machine where it already works (it must include apps\web\dist).
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
)

echo.
echo [INFO] http://127.0.0.1:%PORT%
echo        Keep this window open. Ctrl+C stops THIS console only.
echo.
start "" http://127.0.0.1:%PORT%
node packages\server\src\cli.ts --port %PORT%

echo.
echo [INFO] Server on port %PORT% stopped.
pause
