@echo off
cd /d "%~dp0"
echo Building monthly JSON track bundles...
echo.
python build_tracks.py
echo.
pause
