@echo off
setlocal
cd /d "%~dp0"
title TheMeshVault Backbone
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-and-start.ps1"
if errorlevel 1 (
  echo.
  echo The Backbone could not start. Read the message above.
  pause
)

