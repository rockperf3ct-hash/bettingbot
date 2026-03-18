@echo off
REM ============================================================
REM  Sports Model — Daily Pipeline
REM  Run this file via Windows Task Scheduler every morning.
REM  It captures odds, fetches yesterday's scores, and
REM  re-trains the sport-specific models.
REM ============================================================

cd /d "E:\Sports betting web"

echo [%date% %time%] Starting daily pipeline...

python daily_pipeline.py >> logs\task_scheduler.log 2>&1

if %ERRORLEVEL% NEQ 0 (
    echo [%date% %time%] ERROR: Pipeline failed. Check logs\daily_pipeline.log
) else (
    echo [%date% %time%] Pipeline completed successfully.
)
