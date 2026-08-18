@echo off
title LunaCode - Stop
color 0C

echo Stopping LunaCode ...
echo.

:: Stop tunnel-client
echo Stopping tunnel-client ...
taskkill /f /im tunnel-client.exe >nul 2>&1
if errorlevel 1 (
    echo   tunnel-client was not running.
) else (
    echo   tunnel-client stopped.
)

:: Stop MCP Server
echo Stopping MCP Server ...
taskkill /fi "WINDOWTITLE eq LunaCode MCP Server" /f >nul 2>&1
if errorlevel 1 (
    echo   MCP Server was not running.
) else (
    echo   MCP Server stopped.
)

:: Also kill any node processes on MCP port
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3456 " ^| findstr "LISTENING"') do (
    taskkill /f /pid %%p >nul 2>&1
    echo   Killed process %%p on port 3456.
)

echo.
echo All stopped.
timeout /t 3 /nobreak >nul
