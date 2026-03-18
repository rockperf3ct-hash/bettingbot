@echo off
REM ============================================================
REM  Setup Windows Task Scheduler for Sports Model Daily Pipeline
REM  Run this ONCE as Administrator to register the scheduled task.
REM ============================================================

echo Setting up Windows Task Scheduler...
echo Task will run daily at 6:00 AM.
echo.

schtasks /create ^
  /tn "SportsModel_DailyPipeline" ^
  /tr "\"E:\Sports betting web\daily_pipeline.bat\"" ^
  /sc daily ^
  /st 06:00 ^
  /ru "%USERNAME%" ^
  /rl HIGHEST ^
  /f

if %ERRORLEVEL% EQU 0 (
    echo.
    echo Task created successfully!
    echo.
    echo To verify: schtasks /query /tn "SportsModel_DailyPipeline"
    echo To run now: schtasks /run /tn "SportsModel_DailyPipeline"
    echo To delete:  schtasks /delete /tn "SportsModel_DailyPipeline" /f
) else (
    echo.
    echo ERROR: Failed to create task.
    echo Make sure you are running this as Administrator.
    echo Right-click setup_task_scheduler.bat and choose "Run as administrator"
)

pause
