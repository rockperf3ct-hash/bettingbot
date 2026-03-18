@echo off
echo Starting Sports Model Dashboard...

echo.
echo [1/2] Starting API server (port 8000)...
start "API Server" cmd /k "cd /d %~dp0 && pip install -r api/requirements.txt -q && uvicorn api.main:app --reload --host 0.0.0.0 --port 8000"

timeout /t 3 /nobreak >nul

echo.
echo [2/2] Starting Frontend (port 3000)...
start "Frontend" cmd /k "cd /d %~dp0\frontend && npm install && npm run dev"

echo.
echo Dashboard will open at http://localhost:3000
echo API docs at         http://localhost:8000/docs
echo.
pause
