@echo off
setlocal
cd /d "%~dp0"

rem ===== SETTINGS (edit these) =====
set "PORT=8000"
set "OLLAMA_URL=http://127.0.0.1:11434"
set "NUM_CTX=32768"
set "DEFAULT_TEXT_MODEL=gpt-oss:20b"
set "DEFAULT_VISION_MODEL=qwen3-vl:30b-a3b-instruct-q4_K_M"
rem =================================

if not exist "venv\Scripts\python.exe" (
    echo Could not find venv\Scripts\python.exe
    echo Create it first with:  py -3.12 -m venv venv
    echo Then run:  venv\Scripts\activate
    echo And:       pip install -r requirements.txt
    echo.
    pause
    exit /b 1
)

rem Look up the Tailscale IP so the phone address can be shown.
set "TSIP="
for /f "delims=" %%i in ('tailscale ip -4 2^>nul') do if not defined TSIP set "TSIP=%%i"

echo.
echo  Agente is starting...
echo.
echo  On this PC:     http://localhost:%PORT%
if defined TSIP echo  On your phone:  http://%TSIP%:%PORT%
echo.
if exist "password.txt" (
    echo  Login:          on ^(password from password.txt^)
) else (
    echo  Login:          OFF - create password.txt to require a password
)
echo.
echo  Press Ctrl+C or close this window to stop.
echo.

"venv\Scripts\python.exe" -m uvicorn main:app --host 0.0.0.0 --port %PORT%

echo.
echo  The server stopped.
pause
