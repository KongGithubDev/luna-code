@echo off
title LunaCode - MCP Server + Tunnel Client
color 0A

echo ============================================
echo   LunaCode - ChatGPT Luna Coding Assistant
echo ============================================
echo.

:: ── Load .env ──────────────────────────────────────────────────────────
setlocal enabledelayedexpansion
set "FOUND_KEY="

if exist ".env" (
    echo [1/4] Loading .env ...
    for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
        set "KEY=%%A"
        set "VAL=%%B"
        if "!KEY!"=="CONTROL_PLANE_API_KEY" (
            set "CONTROL_PLANE_API_KEY=!VAL!"
            set "FOUND_KEY=1"
        )
        if "!KEY!"=="MCP_PORT" set "MCP_PORT=!VAL!"
        if "!KEY!"=="MCP_WORK_DIR" set "MCP_WORK_DIR=!VAL!"
    )
    echo       Done.
) else (
    echo [!] .env not found. Copy .env.example to .env and fill in your API key.
    echo.
    pause
    exit /b 1
)

if not defined FOUND_KEY (
    echo [!] CONTROL_PLANE_API_KEY not found in .env
    echo     Edit .env and add your OpenAI Runtime API key.
    echo.
    pause
    exit /b 1
)

:: ── Defaults ────────────────────────────────────────────────────────────
if not defined MCP_PORT set "MCP_PORT=3456"
if not defined MCP_WORK_DIR set "MCP_WORK_DIR=."

:: ── Paths ───────────────────────────────────────────────────────────────
set "LUNA_DIR=%~dp0"
set "TUNNEL_DIR=%LUNA_DIR%..\tunnel_client"
set "MCP_URL=http://localhost:%MCP_PORT%/mcp"

:: ── Check tunnel-client ────────────────────────────────────────────────
if not exist "%TUNNEL_DIR%\tunnel-client.exe" (
    echo [!] tunnel-client.exe not found at:
    echo     %TUNNEL_DIR%
    echo.
    echo     Download from: https://github.com/openai/tunnel-client/releases
    echo     Extract to:    %TUNNEL_DIR%
    echo.
    pause
    exit /b 1
)

:: ── Build if needed ────────────────────────────────────────────────────
if not exist "%LUNA_DIR%dist\http-server.js" (
    echo [2/4] Building LunaCode ...
    cd /d "%LUNA_DIR%"
    call npm run build
    if errorlevel 1 (
        echo [!] Build failed.
        pause
        exit /b 1
    )
    echo       Done.
) else (
    echo [2/4] Build exists, skipping.
)

:: ── Start MCP Server ───────────────────────────────────────────────────
echo [3/4] Starting MCP Server on port %MCP_PORT% ...
cd /d "%LUNA_DIR%"
start "LunaCode MCP Server" /min cmd /c "node dist/http-server.js"

:: Wait for server to be ready
echo       Waiting for server ...
set "RETRIES=0"
:wait_server
timeout /t 1 /nobreak >nul
curl -s http://localhost:%MCP_PORT%/health >nul 2>&1
if errorlevel 1 (
    set /a RETRIES+=1
    if !RETRIES! lss 10 goto wait_server
    echo [!] MCP Server failed to start.
    pause
    exit /b 1
)
echo       Server is ready.

:: ── Setup tunnel-client profile ────────────────────────────────────────
echo [4/4] Setting up tunnel-client ...
cd /d "%TUNNEL_DIR%"

:: Check if profile already exists
if not exist "%USERPROFILE%\.config\tunnel-client\luna-code.yaml" (
    echo       Creating tunnel-client profile ...
    set "CONTROL_PLANE_API_KEY=!CONTROL_PLANE_API_KEY!"
    tunnel-client.exe init ^
        --sample sample_mcp_remote_no_auth ^
        --profile luna-code ^
        --tunnel-id tunnel_6a8490a77bb88191bda48691cd348be7 ^
        --mcp-server-url %MCP_URL%
) else (
    echo       Profile already exists.
)

:: ── Run tunnel-client ──────────────────────────────────────────────────
echo.
echo ============================================
echo   Everything is running!
echo ============================================
echo.
echo   MCP Server:   http://localhost:%MCP_PORT%/mcp
echo   Admin UI:     http://127.0.0.1:8090/ui
echo   Tunnel ID:    tunnel_6a8490a77bb88191bda48691cd348be7
echo.
echo   Now go to ChatGPT Luna:
echo   1. Open ChatGPT -> Plugins -> Create App
echo   2. Select "Tunnel" as connection type
echo   3. Choose "Local MCP Tunnel"
echo   4. Click Connect
echo.
echo   Press Ctrl+C to stop everything.
echo ============================================
echo.

tunnel-client.exe run --profile luna-code

:: ── Cleanup on exit ────────────────────────────────────────────────────
echo.
echo Shutting down ...
taskkill /fi "WINDOWTITLE eq LunaCode MCP Server" /f >nul 2>&1
echo Done.
pause
