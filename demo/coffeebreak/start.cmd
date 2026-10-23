@echo off
chcp 65001 >nul
cd /d %~dp0
echo 启动 CoffeeBreak（http://127.0.0.1:8788/）...
node src/api/server.ts
pause
