@echo off
cd /d "%~dp0..\.."
node dist/apps/cwrig.js monitor --simulate
if errorlevel 1 pause
