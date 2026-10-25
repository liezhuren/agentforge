@echo off
setlocal
cd /d "%~dp0"

REM Usage:  start-console.cmd [port]
REM         no argument -^> 7788
REM Two consoles side by side:
REM   start-console.cmd 7788   offline demo
REM   start-console.cmd 7789   real LLM
REM
REM NOTE: never put an unescaped round bracket inside an echo line that lives
REM       in an if-block. cmd.exe parses the whole block up front, so it fails
REM       with "was unexpected at this time" even when that branch is unused.

set PORT=%1
if "%PORT%"=="" set PORT=7788

title AgentForge console %PORT%

echo ============================================================
echo  AgentForge console   port %PORT%
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 goto :no_node

for /f "delims=" %%v in ('node -v') do set NODEVER=%%v
echo [OK] Node %NODEVER%

if exist "apps\web\dist\index.html" goto :serve
goto :build

:no_node
echo [ERROR] Node.js not found on PATH.
echo         Install Node.js 24 or newer from https://nodejs.org/
echo.
pause
exit /b 1

:build
echo [INFO] Frontend bundle is missing - building now, needs network once.
pushd apps\web
call npm install
if errorlevel 1 goto :build_fail
call npm run build
if errorlevel 1 goto :build_fail
popd
echo [OK] Frontend built.
goto :serve

:build_fail
popd
echo [ERROR] Build failed.
echo         No network? Copy the whole folder from the machine where it works.
echo         That folder must include apps\web\dist
echo.
pause
exit /b 1

:serve
echo.
echo [INFO] http://127.0.0.1:%PORT%
echo        Keep this window open. Ctrl+C stops THIS console only.
echo.
start "" http://127.0.0.1:%PORT%
node packages\server\src\cli.ts --port %PORT%

echo.
echo [INFO] Server on port %PORT% stopped.
pause
