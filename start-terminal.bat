@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title WhatsApp Manager (terminal)

where node >nul 2>nul
if errorlevel 1 goto nonode
node -e "process.exit(Number(process.versions.node.split('.')[0]) < 18 ? 1 : 0)"
if errorlevel 1 goto nonode

if exist "node_modules\puppeteer-core" goto run
echo First run: installing (takes about a minute)...
call npm install --no-fund --no-audit
if errorlevel 1 goto installfail

:run
node index.mjs
echo.
pause
exit /b 0

:nonode
echo Node.js 18 or newer is needed.
echo Opening the download page: install the "LTS" version, then double-click this file again.
start "" "https://nodejs.org/en/download"
pause
exit /b 1

:installfail
echo Installing failed. Check your internet connection and try again.
pause
exit /b 1
