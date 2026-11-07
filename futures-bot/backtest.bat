@echo off
cd /d "%~dp0"
node src\backtest.js --days=180
pause
