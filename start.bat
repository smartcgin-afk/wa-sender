@echo off
title WA Sender - TEAM VINIT JAIN
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.6 or newer in the Node 22 line is required.
  pause
  exit /b 1
)
if not exist .env (
  copy .env.example .env >nul
  echo Created .env with the default team access code.
)
if not exist node_modules (
  call npm install
  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)
call npm start
pause
