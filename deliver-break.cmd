@echo off
setlocal
title AgentForge - coffee-break delivery (real LLM)
cd /d "%~dp0"
echo ============================================================
echo  AgentForge - coffee-break delivery (task 3, real LLM)
echo  ETA 25-40 minutes. Keep this window open.
echo ============================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\deliver-one.ps1" -BriefFile "%~dp0workspace\_scratch\brief.txt" -Name deliv-manual
echo.
echo ==== Done. The "[3/3] verdict" block above is the result. ====
pause
