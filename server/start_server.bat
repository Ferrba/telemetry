@echo off
title CellDiag Telemetry Server
echo ===================================================
echo   Iniciando Servidor CellDiag Telemetry Hub
echo   Painel Local: http://localhost:8000
echo   API Endpoint: http://localhost:8000/api/telemetry
echo ===================================================
cd /d "%~dp0"
python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload
pause
