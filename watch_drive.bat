@echo off
REM Launches the Drive watcher. Point a Task Scheduler task at this, triggered
REM "At log on" — Google Drive for Desktop needs you logged in anyway, so there
REM is nothing to gain from running it as a service.
REM
REM To test by hand, run this from a terminal and watch the output; Ctrl-C stops
REM it. Unattended, everything also goes to watch_drive.log next to this file.

cd /d "%~dp0"
python watch_drive.py %*
