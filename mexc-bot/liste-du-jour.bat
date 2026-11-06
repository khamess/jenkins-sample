@echo off
cd /d "%~dp0"
node src\index.js --scan-only
start "" listes
pause
